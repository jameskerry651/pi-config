import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable" | "auto-decided";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
	/** Which context produced an automatic decision. */
	decidedBy?: "main-agent" | "self";
}

interface MainAgentDecisionRequest {
	question: string;
	context?: string;
	options: AskOption[];
	multiSelect: boolean;
	childLabel?: string;
	childTask?: string;
}

/**
 * In-process service published by the root session so that subagent (headless)
 * sessions can ask the main agent for a decision. Everything here lives in the
 * same process, so the bus is just globalThis — same pattern pi-subagents uses
 * for its manager registry.
 */
interface MainAgentDecider {
	token: symbol;
	/** Session id of the root that published this decider (guards shutdown races). */
	sessionId?: string;
	decide(request: MainAgentDecisionRequest): Promise<string>;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
) {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
	} as AskUserQuestionResultDetails;
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function buildResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[]) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

// ─── Automatic decision when no human is available ──────────────────────────
//
// Subagent sessions are headless (pi never binds a UI context for a child
// AgentSession, so `ctx.hasUI === false`). Instead of returning "unavailable"
// and letting the subagent silently guess, the root session publishes a decider
// service here; a child asks it and the root answers with a plain completion
// that uses the main agent's model, system prompt and conversation snapshot.
// No message is injected into the main conversation and no main-agent turn is
// consumed, so a foreground subagent (parent blocked inside the Agent tool)
// cannot deadlock.

const MAIN_AGENT_DECIDER_KEY = Symbol.for("pi:ask-main-agent:decider");
const AUTO_DECISION_TIMEOUT_MS = 90_000;
const AUTO_DECISION_MAX_PER_SESSION = 6;
const DECISION_CONTEXT_MAX_CHARS = 24_000;
const DECISION_ENTRY_MAX_CHARS = 4_000;
const DECISION_TASK_MAX_CHARS = 4_000;

function getMainAgentDecider(): MainAgentDecider | undefined {
	return (globalThis as unknown as Record<symbol, MainAgentDecider | undefined>)[MAIN_AGENT_DECIDER_KEY];
}

/**
 * A subagent session is identified by its parent link (persisted children) or,
 * for in-memory children (nested runs, `rememberAgents: false`), by the name
 * pi-subagents assigns BEFORE `session_start` fires: `<type>#<agentId>`.
 * `SessionManager.inMemory()` synthesizes a header WITHOUT `parentSession`, so
 * the header alone would misclassify an in-memory child as a root and let it
 * overwrite the real main-agent decider.
 */
function isSubagentSession(ctx: any): boolean {
	try {
		const header = ctx.sessionManager?.getHeader?.();
		if (header?.parentSession) return true;
	} catch {
		// ignore
	}
	try {
		const name = ctx.sessionManager?.getSessionName?.();
		if (typeof name === "string" && /#[A-Za-z0-9_-]{6,16}$/.test(name)) return true;
	} catch {
		// ignore
	}
	return false;
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[...truncated...]`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const typed = block as { type?: string; text?: string; name?: string };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "toolCall" && typeof typed.name === "string") parts.push(`[called tool ${typed.name}]`);
	}
	return parts.join("\n");
}

/** Tail of a session's conversation, oldest-first, bounded by maxChars. */
function buildConversationSnapshot(ctx: any, maxChars: number): string {
	let branch: any[] = [];
	try {
		branch = ctx.sessionManager?.getBranch?.() ?? [];
	} catch {
		return "";
	}

	const parts: string[] = [];
	for (const entry of branch) {
		if (entry?.type === "compaction" && typeof entry.summary === "string") {
			parts.push(`[Earlier conversation summary]\n${truncateText(entry.summary, DECISION_ENTRY_MAX_CHARS)}`);
			continue;
		}
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractTextContent(entry.message.content).trim();
		if (!text) continue;
		parts.push(`${role === "user" ? "User" : "Assistant"}: ${truncateText(text, DECISION_ENTRY_MAX_CHARS)}`);
	}

	let joined = "";
	for (let i = parts.length - 1; i >= 0; i--) {
		const candidate = joined ? `${parts[i]}\n\n${joined}` : parts[i];
		if (candidate.length > maxChars) {
			joined = `[... earlier conversation truncated ...]\n\n${joined}`;
			break;
		}
		joined = candidate;
	}
	return joined.trim();
}

/** The brief a subagent was spawned with (its first user message). */
function getChildTaskBrief(ctx: any): string | undefined {
	try {
		const branch = ctx.sessionManager?.getBranch?.() ?? [];
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = extractTextContent(entry.message.content).trim();
			if (text) return truncateText(text, DECISION_TASK_MAX_CHARS);
		}
	} catch {
		// fall through
	}
	return undefined;
}

function buildDecisionPrompt(request: MainAgentDecisionRequest, snapshot: string): string {
	const lines: string[] = [];
	lines.push(
		"You are the main agent in this conversation. One of your subagents cannot reach a human user — this session has no interactive UI — so it asked you to decide instead. Use the conversation above (your plan, constraints, and earlier decisions) and answer decisively.",
	);
	lines.push("");
	if (snapshot) {
		lines.push("## Your conversation so far");
		lines.push(snapshot);
		lines.push("");
	}
	lines.push("## Subagent request");
	if (request.childLabel) lines.push(`Subagent: ${request.childLabel}`);
	if (request.childTask) lines.push(`Subagent task: ${request.childTask}`);
	lines.push(`Question: ${request.question}`);
	if (request.context) lines.push(`Extra context: ${request.context}`);
	if (request.options.length > 0) {
		lines.push(
			request.multiSelect
				? "Options (choose one or more, or give a direct instruction if none fits):"
				: "Options (choose one, or give a direct instruction if none fits):",
		);
		for (const [index, option] of request.options.entries()) {
			lines.push(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
		}
	}
	lines.push("");
	lines.push("Do not call any tools. Reply with exactly these two lines and nothing else:");
	lines.push("DECISION: <the option label verbatim, or a concise directive>");
	lines.push("REASON: <one short sentence>");
	return lines.join("\n");
}

function parseDecision(text: string): { decision: string; reason?: string } {
	const decision = text.match(/^\s*DECISION\s*:\s*(.+?)\s*$/im)?.[1];
	const reason = text.match(/^\s*REASON\s*:\s*(.+?)\s*$/im)?.[1];
	return { decision: (decision || text.trim()).trim(), reason: reason?.trim() };
}

function matchOptionAnswer(decision: string, options: AskOption[]): AskAnswer | undefined {
	const normalized = decision
		.toLowerCase()
		.replace(/^\d+[.)]\s*/, "")
		.trim();
	for (const [index, option] of options.entries()) {
		const label = option.label.toLowerCase().trim();
		if (normalized === label || normalized.startsWith(label) || label.startsWith(normalized)) {
			return { type: "option", label: option.label, value: option.value, index: index + 1 };
		}
	}
	return undefined;
}

/** One independent completion using the given context's model/state. */
async function runDecider(ctx: any, request: MainAgentDecisionRequest): Promise<string> {
	const model = ctx.model ?? ctx.modelRegistry?.getAll?.()[0];
	if (!model) throw new Error("no model available for automatic decision");

	let systemPrompt = "";
	try {
		systemPrompt = ctx.getSystemPrompt?.() ?? "";
	} catch {
		systemPrompt = "";
	}

	const snapshot = buildConversationSnapshot(ctx, DECISION_CONTEXT_MAX_CHARS);
	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildDecisionPrompt(request, snapshot) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			cacheRetention: "none",
			sessionId: randomUUID(),
			signal: AbortSignal.timeout(AUTO_DECISION_TIMEOUT_MS),
		},
	);

	const text = extractTextContent(response?.content).trim();
	if (!text) throw new Error("automatic decision returned no text");
	return text;
}

function buildAutoDecidedResult(
	question: string,
	context: string | undefined,
	mode: AskUserQuestionMode,
	decisionText: string,
	options: AskOption[],
	decidedBy: "main-agent" | "self",
) {
	const { decision, reason } = parseDecision(decisionText);
	const matched = mode === "single-select" ? matchOptionAnswer(decision, options) : undefined;
	const answer: AskAnswer = matched ?? { type: "text", label: decision, value: decision };
	const who = decidedBy === "main-agent" ? "the main agent" : "this agent (no main agent available)";
	const text = [
		`[auto-decided — no human available; decided by ${who}]`,
		`Decision: ${decision}`,
		reason ? `Reason: ${reason}` : undefined,
		"Treat this as the user's answer and proceed. Do not ask again; if it conflicts with your task constraints, state the conflict in your final report.",
	]
		.filter(Boolean)
		.join("\n");

	return {
		content: [{ type: "text" as const, text }],
		details: {
			...buildStructuredResult("auto-decided", question, mode, [answer], context),
			decidedBy,
		},
	};
}

async function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	const otherLabel = getOtherLabel(options);
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
	];

	return ctx.ui.custom<AskAnswer | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const editor = new Editor(tui, createEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			done({ type: "other", label: trimmed, value: trimmed });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
					return;
				}
				done({
					type: "option",
					label: selected.label,
					value: selected.value,
					index: selected.index!,
				});
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allOptions.length; i++) {
				const option = allOptions[i];
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
				const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				if (option.description) {
					addWrapped(lines, theme.fg("muted", option.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to go back"));
			} else {
				lines.push("");
				add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

async function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	const otherLabel = getOtherLabel(options);
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const submitItem: DisplayOption = { id: "submit", label: "Submit", value: "__submit__", isSubmit: true };
	const allItems: DisplayOption[] = [
		...choiceItems,
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
		submitItem,
	];

	return ctx.ui.custom<AskAnswer[] | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer[] | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const selected = new Map<string, AskAnswer>();
		const editor = new Editor(tui, createEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			refresh();
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function toggleOption(item: DisplayOption) {
			if (selected.has(item.id)) {
				selected.delete(item.id);
			} else {
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index!,
				});
			}
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			const current = allItems[optionIndex];
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit) return;
				if (current.isOther) {
					if (selected.has("other")) {
						selected.delete("other");
						refresh();
					} else {
						editMode = true;
						editor.setText("");
						refresh();
					}
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (current.isSubmit) {
					if (selected.size > 0) {
						done(sortAnswers(Array.from(selected.values())));
					}
					return;
				}
				if (current.isOther) {
					editMode = true;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allItems.length; i++) {
				const item = allItems[i];
				const isFocused = i === optionIndex;
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

				if (item.isSubmit) {
					const label = selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
					const styled = isFocused
						? theme.fg("accent", label)
						: theme.fg(selected.size > 0 ? "success" : "dim", label);
					add(`${prefix}${styled}`);
					continue;
				}

				if (item.isOther) {
					const other = selected.get("other");
					const marker = other ? "[x]" : "[ ]";
					const suffix = other ? ` — ${other.label}` : "";
					const styled = isFocused
						? theme.fg("accent", `${marker} ${item.label}${suffix}`)
						: theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`);
					add(`${prefix}${styled}`);
					continue;
				}

				const checked = selected.has(item.id);
				const marker = checked ? "[x]" : "[ ]";
				const label = `${marker} ${item.index}. ${item.label}`;
				const styled = isFocused
					? theme.fg("accent", label)
					: theme.fg(checked ? "success" : "text", label);
				add(`${prefix}${styled}`);
				if (item.description) {
					addWrapped(lines, theme.fg("muted", item.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to save • Esc to go back"));
			} else {
				lines.push("");
				if (selected.size === 0) {
					add(theme.fg("warning", " Select at least one answer before submitting."));
				}
				add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// Shared UI mutex. ctx.ui.custom()/editor can only handle one active call at
// a time, so ALL pop-up-style tools (ask_user_question, quiz, ...) must
// serialize against each other, not just against themselves. We stash one
// mutex on globalThis so separate extension files can share it without
// importing each other.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => { release = r; });
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

export default function askUserQuestion(pi: ExtensionAPI) {
	const activationToken = Symbol("ask-main-agent-activation");
	let autoDecisionCount = 0;

	// Only a root session (not spawned as a subagent) serves decisions. Persisted
	// children carry `parentSession`; in-memory children only carry the
	// `<type>#<agentId>` session name. See isSubagentSession().
	pi.on("session_start", (_event, ctx) => {
		if (isSubagentSession(ctx)) return;
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}
		const decider: MainAgentDecider = {
			token: activationToken,
			sessionId,
			decide: (request) => runDecider(ctx, request),
		};
		(globalThis as unknown as Record<symbol, MainAgentDecider>)[MAIN_AGENT_DECIDER_KEY] = decider;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const current = getMainAgentDecider();
		if (current?.token !== activationToken) return;
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = undefined;
		}
		// A session switch can start the replacement before this shutdown fires.
		// Only remove the decider this exact session published.
		if (sessionId && current.sessionId && sessionId !== current.sessionId) return;
		delete (globalThis as unknown as Record<symbol, MainAgentDecider | undefined>)[MAIN_AGENT_DECIDER_KEY];
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together. If no human is available (subagent or headless session), the question is automatically routed to the main agent, which decides for you and returns that decision — treat it as final.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
			"In a subagent or other session with no human user, this tool automatically asks the main agent to decide and returns its answer. Use it instead of silently guessing when a decision would materially change the work, but do not use it for trivial choices.",
			"When the result says it was auto-decided, treat that decision as final and proceed. Do not ask the same question again; if it conflicts with your task constraints, state the conflict in your final report.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const context = params.details?.trim() || undefined;
			const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ctx.hasUI) {
				if (autoDecisionCount >= AUTO_DECISION_MAX_PER_SESSION) {
					return unavailableResult(
						params.question,
						mode,
						`ask_user_question auto-decision limit reached (${AUTO_DECISION_MAX_PER_SESSION}) and no human is available. Decide yourself and note the open question in your final report.`,
						context,
					);
				}
				autoDecisionCount += 1;

				const request: MainAgentDecisionRequest = {
					question: params.question,
					context,
					options,
					multiSelect: mode === "multi-select",
					childLabel: (() => {
						try {
							return ctx.sessionManager.getSessionName();
						} catch {
							return undefined;
						}
					})(),
					childTask: getChildTaskBrief(ctx),
				};

				const decider = getMainAgentDecider();
				if (decider) {
					try {
						const decision = await decider.decide(request);
						return buildAutoDecidedResult(params.question, context, mode, decision, options, "main-agent");
					} catch {
						// The root is gone or its model failed — fall back to a local decision.
					}
				}

				try {
					const decision = await runDecider(ctx, request);
					return buildAutoDecidedResult(params.question, context, mode, decision, options, "self");
				} catch (error) {
					return unavailableResult(
						params.question,
						mode,
						`ask_user_question has no UI and the automatic decision failed: ${error instanceof Error ? error.message : String(error)}. Decide yourself and note the open question in your final report.`,
						context,
					);
				}
			}

			return withUILock(async () => {
				if (mode === "text") {
					const editorTitle = context ? `${params.question}\n\n${context}` : params.question;
					const answer = await ctx.ui.editor(editorTitle);
					if (answer === undefined) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [
						{ type: "text", label: answer.trim(), value: answer.trim() },
					]);
				}

				if (mode === "single-select") {
					const answer = await askSingleChoice(ctx, params.question, context, options);
					if (!answer) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [answer]);
				}

				const answers = await askMultiChoice(ctx, params.question, context, options);
				if (!answers) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, answers);
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}

			if (details.status === "auto-decided") {
				const who = details.decidedBy === "main-agent" ? "main agent" : "self";
				const lines = [theme.fg("warning", `⚡ auto-decided (${who})`)];
				for (const answer of details.answers) {
					lines.push(
						answer.type === "option"
							? `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`
							: `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label)}`,
					);
				}
				return new Text(lines.join("\n"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
