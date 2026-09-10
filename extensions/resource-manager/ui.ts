/**
 * Interactive TUI selector for the resource manager.
 *
 * Layout is intentionally close to the built-in `pi config` selector:
 *   - always-on type-to-filter search
 *   - space toggles, Tab switches global/project write scope
 *   - project scope shows three states: inherit / project load / project unload
 *
 * Extra keys:
 *   ctrl+s  toggle session-only soft disable (no reload needed)
 *   ctrl+d  toggle diagnostics/help panel
 *   enter   finish and offer to reload
 *   esc     finish without reloading
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	RESOURCE_TYPE_LABELS,
	type Catalog,
	type ResourceItem,
	filterItems,
} from "./catalog.ts";
import {
	type WriteScope,
	getInheritedEnabled,
	getOverrideState,
	isInheritedGlobalItem,
	settingsPathFor,
} from "./store.ts";

export interface ResourceSelectorResult {
	changed: boolean;
	reload: boolean;
}

type Row =
	| { kind: "group"; key: string; label: string; groupScope: "user" | "project" }
	| { kind: "subgroup"; key: string; label: string }
	| { kind: "item"; key: string; item: ResourceItem };

interface ToggleOutcome {
	ok: boolean;
	enabled?: boolean;
	error?: string;
}

export interface ResourceSelectorOptions {
	catalog: Catalog;
	theme: Theme;
	keybindings: KeybindingsManager;
	terminalHeight: number | (() => number);
	initialScope: WriteScope;
	projectModeAvailable: boolean;
	initialQuery?: string;
	isSoftDisabled: (item: ResourceItem) => boolean;
	onToggle: (item: ResourceItem, scope: WriteScope) => ToggleOutcome;
	onSoftToggle: (item: ResourceItem) => ToggleOutcome;
	notify: (message: string, type: "info" | "warning" | "error") => void;
	requestRender: () => void;
	done: (result: ResourceSelectorResult) => void;
}

export class ResourceSelector implements Component, Focusable {
	private readonly searchInput: Input;
	private rows: Row[] = [];
	private selectedIndex = 0;
	private scope: WriteScope;
	private changed = false;
	private showHelp = false;
	private lastError: string | undefined;
	private readonly maxVisibleCap = 20;
	private get maxVisible(): number {
		const height = typeof this.opts.terminalHeight === "function" ? this.opts.terminalHeight() : this.opts.terminalHeight;
		return Math.max(5, Math.min(this.maxVisibleCap, height - 12));
	}
	private _focused = false;
	private readonly opts: ResourceSelectorOptions;

	constructor(opts: ResourceSelectorOptions) {
		this.opts = opts;
		this.scope = opts.initialScope;
		this.searchInput = new Input({ placeholder: "search" });
		if (opts.initialQuery) this.searchInput.setValue(opts.initialQuery);
		this.rebuildRows();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	invalidate(): void {
		/* stateless render */
	}

	private rebuildRows(): void {
		const view = this.scope === "project" ? this.opts.catalog.project : this.opts.catalog.global;
		const items = filterItems(view.items, this.searchInput.getValue());
		const rows: Row[] = [];
		let lastGroup = "";
		let lastSubgroup = "";
		for (const item of items) {
			if (item.groupKey !== lastGroup) {
				lastGroup = item.groupKey;
				lastSubgroup = "";
				rows.push({ kind: "group", key: item.groupKey, label: item.groupLabel, groupScope: item.groupScope });
			}
			const subgroupKey = `${item.groupKey}:${item.type}`;
			if (subgroupKey !== lastSubgroup) {
				lastSubgroup = subgroupKey;
				rows.push({ kind: "subgroup", key: subgroupKey, label: RESOURCE_TYPE_LABELS[item.type] });
			}
			rows.push({ kind: "item", key: item.itemKey, item });
		}

		const previousKey = this.rows[this.selectedIndex]?.kind === "item" ? this.rows[this.selectedIndex].key : undefined;
		this.rows = rows;

		const restored = previousKey ? rows.findIndex((r) => r.kind === "item" && r.key === previousKey) : -1;
		this.selectedIndex = restored >= 0 ? restored : rows.findIndex((r) => r.kind === "item");
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	private moveSelection(direction: 1 | -1): void {
		let index = this.selectedIndex + direction;
		while (index >= 0 && index < this.rows.length) {
			if (this.rows[index].kind === "item") {
				this.selectedIndex = index;
				return;
			}
			index += direction;
		}
	}

	private pageSelection(direction: 1 | -1): void {
		for (let i = 0; i < this.maxVisible; i++) this.moveSelection(direction);
	}

	private currentItem(): ResourceItem | undefined {
		const row = this.rows[this.selectedIndex];
		return row?.kind === "item" ? row.item : undefined;
	}

	private toggleCurrent(): void {
		const item = this.currentItem();
		if (!item) return;

		if (this.scope === "global" && item.metadata.scope !== "user") {
			this.opts.notify("Global scope can only toggle user resources. Press Tab for project scope.", "warning");
			return;
		}

		const outcome = this.opts.onToggle(item, this.scope);
		if (!outcome.ok) {
			this.lastError = outcome.error ?? "toggle failed";
			this.opts.notify(this.lastError, "error");
		} else {
			this.lastError = undefined;
			this.changed = true;
			if (this.scope === "global" && outcome.enabled !== undefined) item.enabled = outcome.enabled;
		}
		this.rebuildRows();
		this.opts.requestRender();
	}

	private softToggleCurrent(): void {
		const item = this.currentItem();
		if (!item) return;
		if (item.type === "themes") {
			this.opts.notify("Themes cannot be soft-disabled; use a persistent toggle.", "warning");
			return;
		}
		const outcome = this.opts.onSoftToggle(item);
		if (!outcome.ok) {
			this.lastError = outcome.error ?? "soft toggle failed";
			this.opts.notify(this.lastError, "error");
		} else {
			this.lastError = undefined;
			this.opts.notify(
				outcome.enabled ? `Session-disabled ${item.displayName}` : `Re-enabled ${item.displayName} for this session`,
				"info",
			);
		}
		this.opts.requestRender();
	}

	private switchScope(): void {
		if (!this.opts.projectModeAvailable) {
			this.opts.notify("Project is not trusted; project scope is unavailable.", "warning");
			return;
		}
		this.scope = this.scope === "global" ? "project" : "global";
		this.rebuildRows();
		this.opts.requestRender();
	}

	private marker(item: ResourceItem): string {
		const soft = this.opts.isSoftDisabled(item);
		if (soft) return this.opts.theme.fg("accent", "[~]");

		if (this.scope === "project") {
			const state = getOverrideState(this.opts.catalog, item, "project");
			if (state === "load") return this.opts.theme.fg("success", "[+]");
			if (state === "unload") return this.opts.theme.fg("warning", "[-]");
			// inherit: for inherited global resources use the global baseline, for
			// project-local resources use the resolved state (they are never in the
			// global view, so the baseline fallback would wrongly say "enabled").
			const inherited = isInheritedGlobalItem(this.opts.catalog, item);
			const enabled = inherited ? getInheritedEnabled(this.opts.catalog, item) : item.enabled;
			return enabled ? this.opts.theme.fg("success", "[x]") : this.opts.theme.fg("dim", "[ ]");
		}

		return item.enabled ? this.opts.theme.fg("success", "[x]") : this.opts.theme.fg("dim", "[ ]");
	}

	private suffix(item: ResourceItem): string {
		const parts: string[] = [];
		if (this.opts.isSoftDisabled(item)) parts.push(this.opts.theme.fg("accent", "session off"));
		if (this.scope === "project") {
			const state = getOverrideState(this.opts.catalog, item, "project");
			if (state === "load") parts.push(this.opts.theme.fg("muted", "project load"));
			else if (state === "unload") parts.push(this.opts.theme.fg("muted", "project unload"));
			else if (isInheritedGlobalItem(this.opts.catalog, item)) parts.push(this.opts.theme.fg("dim", "inherited global"));
		}
		return parts.length > 0 ? `  ${parts.join(" · ")}` : "";
	}

	private isDimmed(item: ResourceItem): boolean {
		if (this.scope !== "project") return false;
		if (getOverrideState(this.opts.catalog, item, "project") !== "inherit") return false;
		return isInheritedGlobalItem(this.opts.catalog, item) && !getInheritedEnabled(this.opts.catalog, item);
	}

	render(width: number): string[] {
		const theme = this.opts.theme;
		const lines: string[] = [];
		const w = Math.max(1, width);

		const scopeLabel = this.scope === "project" ? "Project" : "Global";
		const title = theme.bold("Resource Manager");
		const hints = theme.fg("muted", "tab scope · space toggle · ctrl+s session · ctrl+d help · enter apply · esc close");
		const gap = Math.max(1, w - visibleWidth(title) - visibleWidth(scopeLabel) - visibleWidth(hints) - 4);
		lines.push(
			truncateToWidth(
				`${title}  ${theme.fg("accent", scopeLabel)}${" ".repeat(gap)}${hints}`,
				w,
				"",
			),
		);
		lines.push(
			truncateToWidth(
				theme.fg(
					"muted",
					this.scope === "project"
						? `${settingsPathFor("project")} · inherited global resources are dimmed`
						: settingsPathFor("global"),
				),
				w,
				"",
			),
		);
		lines.push(...this.searchInput.render(w));
		lines.push(theme.fg("borderMuted", "─".repeat(w)));

		if (this.showHelp) {
			lines.push(...this.renderHelp(w));
			lines.push(theme.fg("borderMuted", "─".repeat(w)));
		}

		if (this.rows.length === 0) {
			lines.push(theme.fg("muted", "  no resources found"));
		} else {
			const visible = Math.min(this.maxVisible, this.rows.length);
			const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visible / 2), this.rows.length - visible));
			const end = Math.min(start + visible, this.rows.length);
			for (let i = start; i < end; i++) {
				const row = this.rows[i];
				const selected = i === this.selectedIndex;
				if (row.kind === "group") {
					const inherited = this.scope === "project" && row.groupScope === "user";
					const label = `${row.label}${inherited ? " · inherited global" : ""}`;
					lines.push(truncateToWidth(`  ${theme.fg(inherited ? "dim" : "accent", theme.bold(label))}`, w, ""));
				} else if (row.kind === "subgroup") {
					lines.push(truncateToWidth(`    ${theme.fg("muted", row.label)}`, w, ""));
				} else {
					const item = row.item;
					const cursor = selected ? "> " : "  ";
					const dimmed = this.isDimmed(item);
					const name = dimmed ? theme.fg("dim", item.displayName) : selected ? theme.bold(item.displayName) : item.displayName;
					lines.push(truncateToWidth(`${cursor}    ${this.marker(item)} ${name}${this.suffix(item)}`, w, "…"));
				}
			}
			if (start > 0 || end < this.rows.length) {
				const itemCount = this.rows.filter((r) => r.kind === "item").length;
				const currentIndex = this.rows.slice(0, this.selectedIndex + 1).filter((r) => r.kind === "item").length;
				lines.push(theme.fg("dim", `  (${currentIndex}/${itemCount})`));
			}
		}

		if (this.changed) {
			lines.push(theme.fg("warning", "  changes saved · enter to apply with /reload, esc to keep them for the next reload"));
		}
		if (this.lastError) {
			lines.push(truncateToWidth(theme.fg("error", `  ${this.lastError}`), w, "…"));
		}

		return lines;
	}

	private renderHelp(width: number): string[] {
		const theme = this.opts.theme;
		const lines: string[] = [];
		const push = (text: string) => lines.push(truncateToWidth(`  ${text}`, width, "…"));
		push(theme.fg("accent", "Session-only soft disable (ctrl+s) works immediately, no reload:"));
		push("  extensions → their tools are removed from the active tool set");
		push("  skills → hidden from the system prompt, /skill:<name> blocked");
		push("  prompts → /<name> blocked before expansion");
		push(theme.fg("warning", "  extension hooks/commands/shortcuts keep running until a real /reload"));
		push("");
		push(theme.fg("accent", "Persistent toggles write +/- patterns into settings.json:"));
		push(`  global  ${settingsPathFor("global")}`);
		push(`  project ${settingsPathFor("project")}`);
		push("  project scope: [x]/[ ] inherit · [+] force load · [-] force unload");
		if (this.opts.catalog.errors.length > 0) {
			push("");
			push(theme.fg("error", `Settings diagnostics (${this.opts.catalog.errors.length}):`));
			for (const error of this.opts.catalog.errors.slice(0, 5)) push(theme.fg("error", error));
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = this.opts.keybindings;

		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			this.opts.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			this.opts.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.pageSelection(-1);
			this.opts.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.pageSelection(1);
			this.opts.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.softToggleCurrent();
			return;
		}
		if (matchesKey(data, "ctrl+d")) {
			this.showHelp = !this.showHelp;
			this.opts.requestRender();
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			this.switchScope();
			return;
		}
		if (data === " ") {
			this.toggleCurrent();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.opts.done({ changed: this.changed, reload: true });
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.opts.done({ changed: this.changed, reload: false });
			return;
		}

		this.searchInput.handleInput(data);
		this.rebuildRows();
		this.opts.requestRender();
	}
}
