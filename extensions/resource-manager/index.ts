/**
 * pi Resource Manager
 *
 * Manage skills, extensions, prompt templates and themes:
 *   /resources          interactive selector (persist to settings.json + session soft-off)
 *   /resources-reload   reload the runtime so persistent changes take effect
 *   resource_manager    the same for the model
 *
 * Persistent toggles write exactly the same `+path` / `-path` patterns as the
 * built-in `pi config`, so both stay compatible.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Catalog,
	type ResourceItem,
	filterItems,
	loadCatalog,
	promptNameFromPath,
} from "./catalog.ts";
import type { SoftKind } from "./runtime.ts";
import { ResourceRuntime } from "./runtime.ts";
import {
	type WriteScope,
	effectiveEnabled,
	flushSettings,
	getInheritedEnabled,
	getOverrideState,
	toggleItem,
} from "./store.ts";
import { ResourceSelector, type ResourceSelectorResult } from "./ui.ts";

const TYPE_PARAM_TO_KEY = {
	extension: "extensions",
	skill: "skills",
	prompt: "prompts",
	theme: "themes",
} as const;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function softKindFor(item: ResourceItem): SoftKind | undefined {
	if (item.type === "extensions") return "extension";
	if (item.type === "skills") return "skill";
	if (item.type === "prompts") return "prompt";
	return undefined;
}

function softIdFor(item: ResourceItem): string | undefined {
	if (item.type === "prompts") return promptNameFromPath(item.path);
	if (item.type === "extensions" || item.type === "skills") return item.path;
	return undefined;
}

function isItemSoftDisabled(runtime: ResourceRuntime, item: ResourceItem): boolean {
	const kind = softKindFor(item);
	const id = softIdFor(item);
	if (!kind || !id) return false;
	return runtime.isSoftDisabled(kind, id);
}

function toggleSoftItem(runtime: ResourceRuntime, item: ResourceItem): { ok: boolean; enabled?: boolean; error?: string } {
	const kind = softKindFor(item);
	const id = softIdFor(item);
	if (!kind || !id) return { ok: false, error: `Cannot session-disable ${item.type}` };
	const enabled = runtime.toggleSoft(kind, id);
	if (kind === "extension") runtime.applyTools();
	runtime.saveToSession();
	return { ok: true, enabled };
}

function itemStateLine(catalog: Catalog, item: ResourceItem, scope: WriteScope, runtime: ResourceRuntime): string {
	const soft = isItemSoftDisabled(runtime, item);
	const enabled = effectiveEnabled(catalog, item, scope);
	const marker = soft ? "[~]" : enabled ? "[x]" : "[ ]";
	const parts = [marker, item.type.padEnd(10), item.displayName];
	if (scope === "project") {
		const state = getOverrideState(catalog, item, scope);
		if (state !== "inherit") parts.push(`(${state === "load" ? "project load" : "project unload"})`);
		else if (!getInheritedEnabled(catalog, item)) parts.push("(inherited disabled)");
	}
	parts.push(item.path);
	return parts.join("  ");
}

function listText(catalog: Catalog, scope: WriteScope, runtime: ResourceRuntime, query: string, typeFilter?: string): string {
	const view = scope === "project" ? catalog.project : catalog.global;
	let items = filterItems(view.items, query);
	if (typeFilter) {
		const key = TYPE_PARAM_TO_KEY[typeFilter as keyof typeof TYPE_PARAM_TO_KEY];
		items = items.filter((item) => item.type === key);
	}
	if (items.length === 0) return `No matching resources in ${scope} scope.`;

	const lines = [`${scope === "project" ? "Project" : "Global"} resources (${items.length}):`];
	let lastGroup = "";
	for (const item of items) {
		if (item.groupLabel !== lastGroup) {
			lastGroup = item.groupLabel;
			lines.push(`\n${lastGroup}`);
		}
		lines.push(`  ${itemStateLine(catalog, item, scope, runtime)}`);
	}
	const soft = runtime.count > 0 ? `\nSession-only disabled: ${runtime.describe()}` : "";
	return `${lines.join("\n")}${soft}`;
}

async function runResourceCommand(
	pi: ExtensionAPI,
	runtime: ResourceRuntime,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/resources requires interactive TUI mode. Use the resource_manager tool instead.", "error");
		return;
	}

	const tokens = args.split(/\s+/).filter(Boolean);
	let requestedScope: WriteScope | undefined;
	const queryParts: string[] = [];
	for (const token of tokens) {
		const lower = token.toLowerCase();
		if (lower === "project" || lower === "local") requestedScope = "project";
		else if (lower === "global" || lower === "user") requestedScope = "global";
		else queryParts.push(token);
	}

	const projectTrusted = ctx.isProjectTrusted();
	if (requestedScope === "project" && !projectTrusted) {
		ctx.ui.notify("Project is not trusted; showing global scope.", "warning");
		requestedScope = undefined;
	}

	let catalog: Catalog;
	try {
		catalog = await loadCatalog(ctx.cwd, projectTrusted);
	} catch (error) {
		ctx.ui.notify(`Failed to scan resources: ${errorMessage(error)}`, "error");
		return;
	}

	const result = await ctx.ui.custom<ResourceSelectorResult>((tui, theme, keybindings, done) =>
		new ResourceSelector({
			catalog,
			theme,
			keybindings,
			terminalHeight: () => tui.terminal.rows,
			initialScope: requestedScope ?? "global",
			projectModeAvailable: projectTrusted,
			initialQuery: queryParts.join(" "),
			isSoftDisabled: (item) => isItemSoftDisabled(runtime, item),
			onToggle: (item, scope) => {
				try {
					const enabled = toggleItem(catalog, item, scope);
					return { ok: true, enabled };
				} catch (error) {
					return { ok: false, error: errorMessage(error) };
				}
			},
			onSoftToggle: (item) => toggleSoftItem(runtime, item),
			notify: (message, type) => ctx.ui.notify(message, type),
			requestRender: () => tui.requestRender(),
			done,
		}),
	);

	const writeErrors = await flushSettings(catalog);
	for (const error of writeErrors) ctx.ui.notify(error, "error");

	if (!result.changed) return;

	if (!result.reload) {
		ctx.ui.notify(`Saved. Run /resources-reload (or restart pi) to apply.`, "info");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Reload runtime now?",
		"Extensions, skills, prompts and themes are re-read. The session runtime is rebuilt.",
	);
	if (!confirmed) {
		ctx.ui.notify("Saved. Run /resources-reload when ready.", "info");
		return;
	}

	await ctx.waitForIdle();
	await ctx.reload();
}

async function runSetAction(
	pi: ExtensionAPI,
	runtime: ResourceRuntime,
	ctx: ExtensionContext,
	params: {
		type?: keyof typeof TYPE_PARAM_TO_KEY;
		name?: string;
		enabled?: boolean;
		scope?: WriteScope;
		mode?: "persist" | "session";
	},
): Promise<string> {
	const scope: WriteScope = params.scope ?? "global";
	const mode = params.mode ?? "persist";
	const catalog = await loadCatalog(ctx.cwd, ctx.isProjectTrusted());
	const view = scope === "project" ? catalog.project : catalog.global;

	if (scope === "project" && !ctx.isProjectTrusted()) {
		return "Project is not trusted, so project-scope changes are unavailable. Use scope=global or run /trust.";
	}
	if (params.enabled === undefined) return "Missing required parameter: enabled";

	let candidates = view.items;
	if (params.type) {
		const key = TYPE_PARAM_TO_KEY[params.type];
		candidates = candidates.filter((item) => item.type === key);
	}
	if (params.name) {
		const needle = params.name.toLowerCase();
		candidates = candidates.filter(
			(item) => item.displayName.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle),
		);
	}
	if (candidates.length === 0) {
		return `No matching resource (type=${params.type ?? "any"}, name=${params.name ?? "any"}, scope=${scope}). Use action="list" first.`;
	}
	if (candidates.length > 4 && !params.name) {
		return `Too many matches (${candidates.length}). Narrow it down with name= or type=.`;
	}

	const lines: string[] = [];
	for (const item of candidates) {
		if (mode === "session") {
			const kind = softKindFor(item);
			const id = softIdFor(item);
			if (!kind || !id) {
				lines.push(`skipped ${item.displayName}: session mode is not supported for ${item.type}`);
				continue;
			}
			if (runtime.isSoftDisabled(kind, id) !== !params.enabled) {
				runtime.toggleSoft(kind, id);
				runtime.saveToSession();
			}
			lines.push(`${params.enabled ? "session-enabled" : "session-disabled"} ${item.type}/${item.displayName}`);
			continue;
		}

		const before = effectiveEnabled(catalog, item, scope);
		if (before === params.enabled) {
			lines.push(
				`unchanged ${item.type}/${item.displayName} (already ${before ? "enabled" : "disabled"}) in ${scope} settings`,
			);
			continue;
		}

		if (item.type === "extensions" && params.enabled) {
			const target = item.metadata.origin === "package" ? `package ${item.metadata.source}` : item.path;
			if (!ctx.hasUI) {
				lines.push(`skipped ${item.displayName}: enabling an extension requires interactive confirmation`);
				continue;
			}
			const ok = await ctx.ui.confirm(
				"Enable this extension?",
				`${target}\nExtensions run arbitrary code with your full permissions.`,
			);
			if (!ok) {
				lines.push(`skipped ${item.displayName}: not confirmed`);
				continue;
			}
		}

		// `effectiveEnabled` for global scope reads the resolve-time snapshot, which
		// toggleItem does not mutate; use its return value (the applied state).
		const after = toggleItem(catalog, item, scope, params.enabled);
		lines.push(`${after ? "enabled" : "disabled"} ${item.type}/${item.displayName} (${before ? "on" : "off"} → ${after ? "on" : "off"}) in ${scope} settings`);
	}

	if (mode === "session") {
		runtime.applyTools();
		return `${lines.join("\n")}\nSession-only changes applied immediately.`;
	}

	const errors = await flushSettings(catalog);
	const suffix = lines.some((line) => line.startsWith("enabled") || line.startsWith("disabled"))
		? "\nWritten to settings.json. Run /resources-reload (or the resource_manager action=\"reload\") to apply."
		: "";
	return `${lines.join("\n")}${suffix}${errors.length > 0 ? `\nSettings errors:\n${errors.join("\n")}` : ""}`;
}

export default function resourceManager(pi: ExtensionAPI): void {
	const runtime = new ResourceRuntime(pi);

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		runtime.restoreFromBranch(ctx.sessionManager.getBranch());
		runtime.applyTools();
	});

	pi.on("before_agent_start", async (event) => {
		if (runtime.softSkills.size === 0) return;
		const skills = event.systemPromptOptions.skills ?? [];
		const filtered = runtime.filterSystemPrompt(event.systemPrompt, skills);
		if (filtered !== event.systemPrompt) return { systemPrompt: filtered };
	});

	pi.on("input", async (event, ctx) => {
		const blocked = runtime.blockedInput(event.text);
		if (!blocked) return;
		ctx.ui.notify(`${blocked} is session-disabled. Use /resources (ctrl+s) to re-enable it.`, "warning");
		return { action: "handled" };
	});

	// ----------------------------------------------------------------- commands

	pi.registerCommand("resources", {
		description: "Enable/disable skills, extensions, prompts and themes",
		handler: async (args, ctx) => {
			await runResourceCommand(pi, runtime, args, ctx);
		},
	});

	pi.registerCommand("resources-reload", {
		description: "Reload extensions, skills, prompts and themes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});

	// --------------------------------------------------------------------- tool

	pi.registerTool({
		name: "resource_manager",
		label: "Manage Resources",
		description:
			"List, enable or disable pi skills, extensions, prompt templates and themes. Persistent changes write settings.json and need a reload; session changes apply immediately.",
		promptSnippet: "List/enable/disable pi skills, extensions, prompts and themes",
		promptGuidelines: [
			'Use resource_manager with action="list" before claiming a skill, extension or prompt is unavailable.',
			'Use resource_manager mode="session" for an immediate toggle that needs no reload; mode="persist" writes settings.json and requires /resources-reload.',
			"resource_manager cannot unload an already loaded extension; soft-disabling an extension only removes its tools.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "set", "reload"] as const, {
				description: "list resources, change one, or trigger a runtime reload",
			}),
			type: Type.Optional(
				StringEnum(["extension", "skill", "prompt", "theme"] as const, { description: "Resource type filter" }),
			),
			name: Type.Optional(Type.String({ description: "Case-insensitive substring match on name or path" })),
			enabled: Type.Optional(Type.Boolean({ description: "Target state for action=set" })),
			scope: Type.Optional(
				StringEnum(["global", "project"] as const, { description: "Settings scope, defaults to global" }),
			),
			mode: Type.Optional(
				StringEnum(["persist", "session"] as const, {
					description: "persist = settings.json + reload (default); session = immediate, session-only",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (params.action === "reload") {
					pi.sendUserMessage("/resources-reload", { deliverAs: "followUp", expandPromptTemplates: true });
					return {
						content: [{ type: "text", text: "Queued /resources-reload as a follow-up command." }],
						details: {},
					};
				}

				if (params.action === "list") {
					const scope: WriteScope = params.scope ?? "global";
					if (scope === "project" && !ctx.isProjectTrusted()) {
						return {
							content: [
								{
									type: "text",
									text: "Project is not trusted, so project resources are not loaded. Use scope=global or run /trust.",
								},
							],
							details: {},
						};
					}
					const catalog = await loadCatalog(ctx.cwd, ctx.isProjectTrusted());
					const text = listText(catalog, scope, runtime, params.name ?? "", params.type);
					return { content: [{ type: "text", text }], details: { count: catalog[scope].items.length } };
				}

				const text = await runSetAction(pi, runtime, ctx, params);
				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text", text: `resource_manager failed: ${errorMessage(error)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});
}
