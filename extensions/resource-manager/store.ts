/**
 * Persistence layer: writes the same `+path` / `-path` patterns into
 * `~/.pi/agent/settings.json` and `.pi/settings.json` that the built-in
 * `pi config` uses, so both tools stay mutually compatible.
 *
 * Rules verified against pi 0.85.x:
 *   - Pattern base dirs: global settings -> agentDir, project settings -> .pi
 *   - `-` (force exclude) wins over `+` (force include) -> never leave both
 *   - Overriding an inherited global resource from project scope requires BOTH
 *     a plain include entry and the signed entry, e.g.
 *       "skills": ["/abs/path/to/skill/SKILL.md", "-/abs/path/to/skill/SKILL.md"]
 *   - Package resources use per-package filter arrays; a project-scope override
 *     of a globally configured package uses `{ source, autoload: false, ... }`.
 */

import {
	CONFIG_DIR_NAME,
	type PackageSource,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RESOURCE_TYPES,
	type Catalog,
	type ResourceItem,
	type ResourceType,
	canonicalPath,
	normalizeSlashes,
} from "./catalog.ts";

export type WriteScope = "global" | "project";
export type OverrideState = "inherit" | "load" | "unload";

interface PackageFilterObject {
	source: string;
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

function itemScope(item: ResourceItem): "user" | "project" {
	return item.metadata.scope === "project" ? "project" : "user";
}

function stripSign(entry: string): string {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
}

/**
 * Settings paths support `~` (pi documents `"skills": ["~/.claude/skills"]`),
 * but Node's `path.resolve` does not expand it.
 */
function expandTilde(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

function isSigned(entry: string): boolean {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

/**
 * Resolve a settings pattern against a base dir without canonicalising it, so
 * that `relative()` computations stay in the same path space as the base dir
 * pi scanned (mixing realpath and non-realpath bases produces bogus relative
 * paths such as `../../../../private/var/...`).
 */
function resolveAgainst(value: string, baseDir: string): string {
	const expanded = expandTilde(value.trim());
	// pi treats `file:` URLs as local paths and resolves them with fileURLToPath.
	if (expanded.startsWith("file:")) {
		try {
			return resolve(fileURLToPath(expanded));
		} catch {
			/* fall through to plain resolution */
		}
	}
	return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/** Same, but canonicalised for stable comparisons across symlinked paths. */
function canonicalResolve(value: string, baseDir: string): string {
	return canonicalPath(resolveAgainst(value, baseDir));
}

function resolveEntry(entry: string, baseDir: string): string {
	return canonicalResolve(stripSign(entry), baseDir);
}

function scopeBaseDir(catalog: Catalog, scope: WriteScope): string {
	return scope === "project" ? catalog.projectBaseDir : catalog.agentDir;
}

/**
 * True when `entry` refers to this item, trying every base dir the entry could
 * have been written against (settings base dir, or the item's own discovery base).
 */
function entryMatchesItem(entry: string, item: ResourceItem, catalog: Catalog, scope: WriteScope): boolean {
	const bases = new Set<string>([scopeBaseDir(catalog, scope), catalog.projectBaseDir, catalog.agentDir]);
	if (item.metadata.baseDir) bases.add(item.metadata.baseDir);
	const target = canonicalPath(item.path);
	for (const base of bases) {
		if (resolveEntry(entry, base) === target) return true;
	}
	return false;
}

/** Does this item also exist in the global view (i.e. is it inherited by the project)? */
export function isInheritedGlobalItem(catalog: Catalog, item: ResourceItem): boolean {
	return itemScope(item) === "user" || catalog.global.byKey.has(item.itemKey);
}

/** Effective enabled state ignoring project overrides. */
export function getInheritedEnabled(catalog: Catalog, item: ResourceItem): boolean {
	const globalItem = catalog.global.byKey.get(item.itemKey);
	if (globalItem) return globalItem.enabled;
	return itemScope(item) === "user" ? item.enabled : true;
}

function getTopLevelPaths(sm: SettingsManager, type: ResourceType, scope: WriteScope): string[] {
	const settings = scope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
	return [...(settings[type] ?? [])];
}

function setTopLevelPaths(sm: SettingsManager, type: ResourceType, scope: WriteScope, paths: string[]): void {
	if (scope === "project") {
		if (type === "extensions") sm.setProjectExtensionPaths(paths);
		else if (type === "skills") sm.setProjectSkillPaths(paths);
		else if (type === "prompts") sm.setProjectPromptTemplatePaths(paths);
		else sm.setProjectThemePaths(paths);
		return;
	}
	if (type === "extensions") sm.setExtensionPaths(paths);
	else if (type === "skills") sm.setSkillPaths(paths);
	else if (type === "prompts") sm.setPromptTemplatePaths(paths);
	else sm.setThemePaths(paths);
}

/** Pattern used to disable/enable a top-level (non-package) resource. */
export function getResourcePattern(catalog: Catalog, item: ResourceItem, scope: WriteScope): string {
	if (scope === "project") {
		// Inherited global resource: project scope must use the absolute path.
		if (isInheritedGlobalItem(catalog, item)) return normalizeSlashes(item.path);
		const base = item.metadata.baseDir ?? catalog.projectBaseDir;
		return normalizeSlashes(relative(base, item.path));
	}
	const base = item.metadata.baseDir ?? catalog.agentDir;
	return normalizeSlashes(relative(base, item.path));
}

/** Path of a package resource relative to the package root. */
function getPackagePattern(item: ResourceItem): string {
	const base = item.metadata.baseDir ?? dirname(item.path);
	return normalizeSlashes(relative(base, item.path));
}

function isLocalSource(source: string): boolean {
	const trimmed = source.trim();
	return !(
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	);
}

function packageSourceStringMatches(
	catalog: Catalog,
	leftSource: string,
	leftScope: "user" | "project",
	rightSource: string,
	rightScope: "user" | "project",
): boolean {
	if (leftSource === rightSource) return true;
	if (!isLocalSource(leftSource) || !isLocalSource(rightSource)) return false;
	const leftBase = leftScope === "project" ? catalog.projectBaseDir : catalog.agentDir;
	const rightBase = rightScope === "project" ? catalog.projectBaseDir : catalog.agentDir;
	return canonicalResolve(leftSource, leftBase) === canonicalResolve(rightSource, rightBase);
}

function findMatchingPackage(
	catalog: Catalog,
	item: ResourceItem,
	scope: WriteScope,
): PackageFilterObject | undefined {
	const sm = catalog.settingsManager;
	const settings = scope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
	const sourceScope = itemScope(item);
	for (const pkg of settings.packages ?? []) {
		const source = typeof pkg === "string" ? pkg : pkg.source;
		if (packageSourceStringMatches(catalog, item.metadata.source, sourceScope, source, scope)) {
			return typeof pkg === "string" ? { source: pkg } : { ...pkg };
		}
	}
	return undefined;
}

function createPackageOverrideSource(catalog: Catalog, item: ResourceItem): PackageFilterObject {
	const source = item.metadata.source;
	if (!isLocalSource(source)) return { source, autoload: false };
	const sourceScope = itemScope(item);
	const fromBase = sourceScope === "project" ? catalog.projectBaseDir : catalog.agentDir;
	const resolved = resolveAgainst(source, fromBase);
	const rel = normalizeSlashes(relative(catalog.projectBaseDir, resolved)) || ".";
	return { source: rel, autoload: false };
}

/** Current project-scope override state for an item. */
export function getOverrideState(catalog: Catalog, item: ResourceItem, scope: WriteScope): OverrideState {
	if (scope !== "project") return "inherit";

	if (item.metadata.origin === "top-level") {
		const entries = catalog.settingsManager.getProjectSettings()[item.type] ?? [];
		// Mirror pi's own precedence instead of last-wins: `-` (force exclude) >
		// `+` (force include) > `!` (exclude) > plain include.
		let sawUnload = false;
		let sawLoad = false;
		let sawExclude = false;
		let sawInclude = false;
		for (const entry of entries) {
			if (!entryMatchesItem(entry, item, catalog, "project")) continue;
			if (entry.startsWith("-")) sawUnload = true;
			else if (entry.startsWith("+")) sawLoad = true;
			else if (entry.startsWith("!")) sawExclude = true;
			else sawInclude = true;
		}
		if (sawUnload) return "unload";
		if (sawLoad) return "load";
		if (sawExclude) return "unload";
		if (sawInclude) return "load";
		return "inherit";
	}

	const pkg = findMatchingPackage(catalog, item, "project");
	if (!pkg) return "inherit";
	const entries = pkg[item.type];
	if (entries === undefined) return "inherit";
	if (entries.length === 0 && pkg.autoload !== false) return "unload";
	const pattern = getPackagePattern(item);
	let state: OverrideState = "inherit";
	for (const entry of entries) {
		if (stripSign(entry) !== pattern) continue;
		state = entry.startsWith("+") ? "load" : "unload";
	}
	return state;
}

/** Effective enabled state for display, given the current settings. */
export function effectiveEnabled(catalog: Catalog, item: ResourceItem, scope: WriteScope): boolean {
	if (scope !== "project") return item.enabled;
	const state = getOverrideState(catalog, item, scope);
	if (state === "load") return true;
	if (state === "unload") return false;
	return getInheritedEnabled(catalog, item);
}

/** Three-state cycle used by the interactive selector (inherited -> unload/load). */
export function nextOverrideState(catalog: Catalog, item: ResourceItem): OverrideState {
	const state = getOverrideState(catalog, item, "project");
	const inheritedEnabled = getInheritedEnabled(catalog, item);
	if (state === "inherit") return inheritedEnabled ? "unload" : "load";
	if (state === "unload") return inheritedEnabled ? "load" : "inherit";
	return inheritedEnabled ? "inherit" : "unload";
}

function applyTopLevelGlobal(catalog: Catalog, item: ResourceItem, enabled: boolean): void {
	const sm = catalog.settingsManager;
	const pattern = getResourcePattern(catalog, item, "global");
	const current = getTopLevelPaths(sm, item.type, "global");
	// Only replace our own signed pattern. Plain entries are the *source* of
	// settings-listed resources: `resolveLocalEntries` collects files from plain
	// entries only, so dropping one would make the resource vanish entirely
	// (and unable to be re-enabled) after the next reload.
	const updated = current.filter((entry) => !(isSigned(entry) && entryMatchesItem(entry, item, catalog, "global")));
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	setTopLevelPaths(sm, item.type, "global", updated);
}

/** Package resources are toggled inside the package entry's own filter arrays. */
function applyPackageGlobal(catalog: Catalog, item: ResourceItem, enabled: boolean): void {
	const sm = catalog.settingsManager;
	const packages: PackageSource[] = [...(sm.getGlobalSettings().packages ?? [])];
	const index = packages.findIndex((pkg) => {
		const source = typeof pkg === "string" ? pkg : pkg.source;
		return packageSourceStringMatches(catalog, item.metadata.source, itemScope(item), source, "user");
	});
	if (index === -1) {
		throw new Error(`Package not found in global settings: ${item.metadata.source}`);
	}

	let pkg = packages[index];
	if (typeof pkg === "string") {
		pkg = { source: pkg };
		packages[index] = pkg;
	}
	if (!pkg || typeof pkg === "string") return;

	const pattern = getPackagePattern(item);
	const entries = (pkg[item.type] ?? []).filter((entry) => stripSign(entry) !== pattern);
	entries.push(`${enabled ? "+" : "-"}${pattern}`);
	pkg[item.type] = entries;

	if (!RESOURCE_TYPES.some((key) => pkg[key] !== undefined)) {
		if (pkg.autoload === false) packages.splice(index, 1);
		else packages[index] = pkg.source;
	}
	sm.setPackages(packages);
}

function applyTopLevelProject(catalog: Catalog, item: ResourceItem, state: OverrideState): void {
	const sm = catalog.settingsManager;
	const inherited = isInheritedGlobalItem(catalog, item);
	const pattern = inherited ? normalizeSlashes(item.path) : getResourcePattern(catalog, item, "project");
	const current = getTopLevelPaths(sm, item.type, "project");
	const updated = current.filter((entry) => {
		if (isSigned(entry) && entryMatchesItem(entry, item, catalog, "project")) return false;
		// Restoring inheritance also drops the plain include we added for the override.
		if (state === "inherit" && inherited && !isSigned(entry) && entryMatchesItem(entry, item, catalog, "project")) {
			return false;
		}
		return true;
	});
	if (state !== "inherit") {
		if (inherited && !updated.includes(pattern)) updated.push(pattern);
		updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
	}
	setTopLevelPaths(sm, item.type, "project", updated);
}

function applyPackageProject(catalog: Catalog, item: ResourceItem, state: OverrideState): void {
	const sm = catalog.settingsManager;
	const packages: PackageSource[] = [...(sm.getProjectSettings().packages ?? [])];
	let index = packages.findIndex((pkg) => {
		const source = typeof pkg === "string" ? pkg : pkg.source;
		return packageSourceStringMatches(catalog, item.metadata.source, itemScope(item), source, "project");
	});

	if (index === -1) {
		if (state === "inherit") return;
		packages.push(createPackageOverrideSource(catalog, item));
		index = packages.length - 1;
	}

	let pkg = packages[index];
	if (typeof pkg === "string") {
		pkg = { source: pkg };
		packages[index] = pkg;
	}
	if (!pkg || typeof pkg === "string") return;

	const pattern = getPackagePattern(item);
	const entries = (pkg[item.type] ?? []).filter((entry) => stripSign(entry) !== pattern);
	if (state !== "inherit") entries.push(`${state === "load" ? "+" : "-"}${pattern}`);
	pkg[item.type] = entries.length > 0 ? entries : undefined;

	const hasFilters = RESOURCE_TYPES.some((key) => pkg[key] !== undefined);
	if (!hasFilters) {
		if (pkg.autoload === false) packages.splice(index, 1);
		else packages[index] = pkg.source;
	}
	sm.setProjectPackages(packages);
}

/** Apply an explicit project-scope override state. */
export function applyProjectState(catalog: Catalog, item: ResourceItem, state: OverrideState): void {
	if (item.metadata.origin === "top-level") applyTopLevelProject(catalog, item, state);
	else applyPackageProject(catalog, item, state);
}

/**
 * Toggle an item in the given scope and return the new effective enabled state.
 * Throws if the settings write is refused (e.g. untrusted project).
 */
export function toggleItem(
	catalog: Catalog,
	item: ResourceItem,
	scope: WriteScope,
	desiredEnabled?: boolean,
): boolean {
	if (scope === "global") {
		const enabled = desiredEnabled ?? !item.enabled;
		if (item.metadata.origin === "package") applyPackageGlobal(catalog, item, enabled);
		else applyTopLevelGlobal(catalog, item, enabled);
		return enabled;
	}

	if (desiredEnabled === undefined) {
		applyProjectState(catalog, item, nextOverrideState(catalog, item));
		return effectiveEnabled(catalog, item, "project");
	}

	// Explicit target: use inherit when the inherited state already matches.
	const inheritedEnabled = getInheritedEnabled(catalog, item);
	if (desiredEnabled === inheritedEnabled) applyProjectState(catalog, item, "inherit");
	else applyProjectState(catalog, item, desiredEnabled ? "load" : "unload");
	return effectiveEnabled(catalog, item, "project");
}

export async function flushSettings(catalog: Catalog): Promise<string[]> {
	const sm = catalog.settingsManager;
	await sm.flush();
	return sm.drainErrors().map((e) => `${e.scope} settings: ${e.error.message}`);
}

export function settingsPathFor(scope: WriteScope): string {
	return scope === "project" ? `${CONFIG_DIR_NAME}/settings.json` : "~/.pi/agent/settings.json";
}
