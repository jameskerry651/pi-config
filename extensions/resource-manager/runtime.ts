/**
 * Session-scoped "soft disable" runtime.
 *
 * Persisting `-path` patterns requires `/reload`, which is disruptive. This
 * module lets the user/model switch things off for the current session only:
 *
 *   - extensions : their tools are removed from the active tool set
 *   - skills     : their <skill> entries are removed from the system prompt
 *                  and /skill:<name> invocations are intercepted
 *   - prompts    : /<name> invocations are intercepted before expansion
 *
 * Hard limitations (documented in README.md):
 *   - an already loaded extension cannot be unloaded; its hooks, commands and
 *     shortcuts keep running
 *   - extension slash commands are dispatched before the `input` event, so they
 *     cannot be blocked here
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { canonicalPath, skillNameFromPath } from "./catalog.ts";

export type SoftKind = "extension" | "skill" | "prompt";

export interface SoftStateJSON {
	extensions: string[];
	skills: string[];
	prompts: string[];
}

export const SOFT_ENTRY_TYPE = "resource-manager-soft";

interface BranchEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

const SECTION_START = "\n\nThe following skills provide specialized instructions for specific tasks.";
const SECTION_END = "</available_skills>";

/**
 * Rebuild the `<available_skills>` section without the disabled skills.
 * The section format is produced by pi's own `formatSkillsForPrompt`, so we
 * regenerate it from the same skill list instead of doing fragile regex surgery.
 */
export function filterSkillsSection(
	prompt: string,
	skills: readonly Skill[],
	disabledPaths: ReadonlySet<string>,
): string {
	if (disabledPaths.size === 0) return prompt;
	const start = prompt.indexOf(SECTION_START);
	if (start === -1) return prompt;
	const endMarkerIndex = prompt.indexOf(SECTION_END, start);
	if (endMarkerIndex === -1) return prompt;
	const end = endMarkerIndex + SECTION_END.length;

	// Preserve whichever read tool sentence the original section used.
	const existing = prompt.slice(start, end);
	const readToolAvailable = existing.includes("Use the read tool to load");

	const visible = skills.filter((skill) => !skill.disableModelInvocation && !disabledPaths.has(skill.filePath));
	const replacement = formatSkillsForPrompt(visible as Skill[], readToolAvailable ? "read" : "bash");
	return prompt.slice(0, start) + replacement + prompt.slice(end);
}

/**
 * pi registers `/skill:<name>` from the skill's frontmatter `name`, which may
 * differ from the directory name (pi explicitly allows that). Fall back to the
 * path-derived name when the file cannot be read.
 */
function readSkillFrontmatterName(filePath: string): string {
	try {
		const head = readFileSync(filePath, "utf8").slice(0, 4000);
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
		const match = frontmatter ? /^name:[ \t]*(.+)$/m.exec(frontmatter[1]) : null;
		if (match) return match[1].trim().replace(/^["']|["']$/g, "");
	} catch {
		/* unreadable skill file */
	}
	return skillNameFromPath(filePath);
}

export class ResourceRuntime {
	private readonly extensions = new Set<string>();
	private readonly skills = new Set<string>();
	private readonly prompts = new Set<string>();
	/** Tools we removed ourselves, so re-enabling only restores what we took. */
	private readonly removedTools = new Set<string>();
	private readonly skillNameCache = new Map<string, string>();

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	get softExtensions(): ReadonlySet<string> {
		return this.extensions;
	}

	get softSkills(): ReadonlySet<string> {
		return this.skills;
	}

	get softPrompts(): ReadonlySet<string> {
		return this.prompts;
	}

	get count(): number {
		return this.extensions.size + this.skills.size + this.prompts.size;
	}

	serialize(): SoftStateJSON {
		return {
			extensions: [...this.extensions],
			skills: [...this.skills],
			prompts: [...this.prompts],
		};
	}

	restore(state: SoftStateJSON | undefined): void {
		this.extensions.clear();
		this.skills.clear();
		this.prompts.clear();
		if (!state) return;
		for (const p of state.extensions ?? []) this.extensions.add(p);
		for (const p of state.skills ?? []) this.skills.add(p);
		for (const p of state.prompts ?? []) this.prompts.add(p);
	}

	/** Restore the most recent soft state from the current session branch. */
	restoreFromBranch(entries: readonly BranchEntryLike[]): void {
		let latest: SoftStateJSON | undefined;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SOFT_ENTRY_TYPE) continue;
			latest = entry.data as SoftStateJSON | undefined;
		}
		this.restore(latest);
	}

	saveToSession(): void {
		this.pi.appendEntry<SoftStateJSON>(SOFT_ENTRY_TYPE, this.serialize());
	}

	clearAll(): void {
		this.extensions.clear();
		this.skills.clear();
		this.prompts.clear();
	}

	isSoftDisabled(kind: SoftKind, id: string): boolean {
		if (kind === "extension") {
			const canonical = canonicalPath(id);
			for (const p of this.extensions) if (canonicalPath(p) === canonical) return true;
			return false;
		}
		if (kind === "skill") {
			const canonical = canonicalPath(id);
			for (const p of this.skills) if (canonicalPath(p) === canonical) return true;
			return false;
		}
		return this.prompts.has(id);
	}

	/** Toggle soft state; returns true when the resource is now soft-disabled. */
	toggleSoft(kind: SoftKind, id: string): boolean {
		this.skillNameCache.clear();
		return this.toggleSoftInternal(kind, id);
	}

	private toggleSoftInternal(kind: SoftKind, id: string): boolean {
		if (kind === "extension") {
			const disabled = this.isSoftDisabled("extension", id);
			if (disabled) {
				const canonical = canonicalPath(id);
				for (const p of [...this.extensions]) if (canonicalPath(p) === canonical) this.extensions.delete(p);
			} else {
				this.extensions.add(id);
			}
			return !disabled;
		}
		if (kind === "skill") {
			const disabled = this.isSoftDisabled("skill", id);
			if (disabled) {
				const canonical = canonicalPath(id);
				for (const p of [...this.skills]) if (canonicalPath(p) === canonical) this.skills.delete(p);
			} else {
				this.skills.add(id);
			}
			return !disabled;
		}
		const disabled = this.prompts.has(id);
		if (disabled) this.prompts.delete(id);
		else this.prompts.add(id);
		return !disabled;
	}

	/** Remove an extension path from the soft set (used when hard-disabling it). */
	forgetExtension(extensionPath: string): void {
		const canonical = canonicalPath(extensionPath);
		for (const p of [...this.extensions]) if (canonicalPath(p) === canonical) this.extensions.delete(p);
	}

	/**
	 * Recompute the active tool set: drop tools owned by soft-disabled
	 * extensions, restore only the ones we removed ourselves.
	 */
	applyTools(): void {
		const active = new Set(this.pi.getActiveTools());
		let changed = false;
		for (const tool of this.pi.getAllTools()) {
			const owner = tool.sourceInfo?.path;
			const disabled = owner ? this.isSoftDisabled("extension", owner) : false;
			if (disabled) {
				if (active.delete(tool.name)) {
					this.removedTools.add(tool.name);
					changed = true;
				}
			} else if (this.removedTools.has(tool.name)) {
				active.add(tool.name);
				this.removedTools.delete(tool.name);
				changed = true;
			}
		}
		if (changed) this.pi.setActiveTools([...active]);
	}

	filterSystemPrompt(prompt: string, skills: readonly Skill[]): string {
		if (this.skills.size === 0) return prompt;
		const disabled = new Set<string>();
		for (const skill of skills) {
			if (this.isSoftDisabled("skill", skill.filePath)) disabled.add(skill.filePath);
		}
		if (disabled.size === 0) return prompt;
		return filterSkillsSection(prompt, skills, disabled);
	}

	/**
	 * Returns the blocked token (e.g. "/review") when input targets a
	 * soft-disabled skill command or prompt template, otherwise undefined.
	 */
	blockedInput(text: string): string | undefined {
		if (this.skills.size === 0 && this.prompts.size === 0) return undefined;
		const match = /^\s*\/([^\s]+)/.exec(text);
		if (!match) return undefined;
		const command = match[1];

		if (command.startsWith("skill:")) {
			const name = command.slice("skill:".length);
			for (const p of this.skills) {
				let cached = this.skillNameCache.get(p);
				if (cached === undefined) {
					cached = readSkillFrontmatterName(p);
					this.skillNameCache.set(p, cached);
				}
				if (cached === name || skillNameFromPath(p) === name) return `/${command}`;
			}
			return undefined;
		}

		if (this.prompts.has(command)) return `/${command}`;
		return undefined;
	}

	describe(): string {
		const parts: string[] = [];
		if (this.extensions.size > 0) parts.push(`${this.extensions.size} extension(s)`);
		if (this.skills.size > 0) parts.push(`${this.skills.size} skill(s)`);
		if (this.prompts.size > 0) parts.push(`${this.prompts.size} prompt(s)`);
		return parts.length > 0 ? parts.join(", ") : "nothing";
	}
}
