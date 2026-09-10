/**
 * Catalog for the resource manager.
 *
 * Enumerates every extension / skill / prompt / theme pi knows about, together
 * with its effective enabled state, by reusing pi's own resolver
 * (`SettingsManager` + `DefaultPackageManager`). We deliberately do NOT
 * reimplement discovery rules so this can never drift from `pi config`.
 *
 * Two views are built, mirroring the built-in `pi config` selector:
 *   - `global`  : project settings ignored (user/global resources only)
 *   - `project` : project settings applied (only meaningful when trusted)
 */

import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	SettingsManager,
	getAgentDir,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	extensions: "Extensions",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
};

export interface ResourceItem {
	type: ResourceType;
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	displayName: string;
	/** stable across the two views: `${type}:${canonicalPath}` */
	itemKey: string;
	groupKey: string;
	groupLabel: string;
	groupOrder: number;
	groupScope: "user" | "project";
}

export interface CatalogView {
	items: ResourceItem[];
	byKey: Map<string, ResourceItem>;
}

export interface Catalog {
	cwd: string;
	agentDir: string;
	projectBaseDir: string;
	projectTrusted: boolean;
	settingsManager: SettingsManager;
	global: CatalogView;
	project: CatalogView;
	errors: string[];
}

/** Resolve symlinks so the same file discovered via two paths collapses to one key. */
export function canonicalPath(input: string): string {
	const abs = resolve(input);
	try {
		return realpathSync.native(abs);
	} catch {
		return abs;
	}
}

export function itemKeyFor(type: ResourceType, path: string): string {
	return `${type}:${canonicalPath(path)}`;
}

export function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

export function formatHomeDir(path: string): string {
	const home = homedir();
	let display = path;
	if (path === home) display = "~";
	else if (path.startsWith(`${home}/`)) display = `~${path.slice(home.length)}`;
	display = normalizeSlashes(display);
	return display.endsWith("/") ? display : `${display}/`;
}

export function displayNameFor(type: ResourceType, path: string): string {
	const file = basename(path);
	const parent = basename(dirname(path));
	if (type === "skills") return file === "SKILL.md" ? parent : file.replace(/\.md$/i, "");
	if (type === "extensions") return parent === "extensions" ? file : `${parent}/${file}`;
	if (type === "prompts") return file.replace(/\.md$/i, "");
	return file.replace(/\.json$/i, "");
}

export function skillNameFromPath(skillPath: string): string {
	const file = basename(skillPath);
	return file === "SKILL.md" ? basename(dirname(skillPath)) : file.replace(/\.md$/i, "");
}

export function promptNameFromPath(promptPath: string): string {
	return basename(promptPath).replace(/\.md$/i, "");
}

function groupInfo(
	metadata: PathMetadata,
	agentDir: string,
	projectBaseDir: string,
): { key: string; label: string; order: number; scope: "user" | "project" } {
	const scope: "user" | "project" = metadata.scope === "project" ? "project" : "user";

	if (metadata.origin === "package") {
		return {
			key: `package:${scope}:${metadata.source}`,
			label: `${metadata.source} (${scope})`,
			order: scope === "user" ? 40 : 50,
			scope,
		};
	}

	if (metadata.source === "auto") {
		const baseDir = metadata.baseDir ?? (scope === "project" ? projectBaseDir : agentDir);
		return scope === "project"
			? { key: "project:auto", label: `Project (${formatHomeDir(baseDir)})`, order: 20, scope }
			: { key: "user:auto", label: `User (${formatHomeDir(baseDir)})`, order: 10, scope };
	}

	return scope === "project"
		? { key: "project:settings", label: "Project settings", order: 30, scope }
		: { key: "user:settings", label: "User settings", order: 0, scope };
}

function buildView(resolved: ResolvedPaths, agentDir: string, projectBaseDir: string): CatalogView {
	const items: ResourceItem[] = [];
	for (const type of RESOURCE_TYPES) {
		const resources = resolved[type] as ResolvedResource[];
		for (const resource of resources) {
			const group = groupInfo(resource.metadata, agentDir, projectBaseDir);
			items.push({
				type,
				path: resource.path,
				enabled: resource.enabled,
				metadata: resource.metadata,
				displayName: displayNameFor(type, resource.path),
				itemKey: itemKeyFor(type, resource.path),
				groupKey: group.key,
				groupLabel: group.label,
				groupOrder: group.order,
				groupScope: group.scope,
			});
		}
	}
	items.sort(compareItems);
	const byKey = new Map(items.map((item) => [item.itemKey, item]));
	return { items, byKey };
}

function compareItems(a: ResourceItem, b: ResourceItem): number {
	if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
	const typeOrder = RESOURCE_TYPES.indexOf(a.type) - RESOURCE_TYPES.indexOf(b.type);
	if (typeOrder !== 0) return typeOrder;
	return a.displayName.localeCompare(b.displayName);
}

/**
 * Never auto-install missing packages from inside a session: pass `onMissing`
 * so `DefaultPackageManager.resolve()` skips them instead of hitting the network.
 */
const skipMissing = async (): Promise<"skip"> => "skip";

export async function loadCatalog(cwd: string, projectTrusted: boolean): Promise<Catalog> {
	const agentDir = getAgentDir();
	const projectBaseDir = join(cwd, CONFIG_DIR_NAME);

	// Manager used for writes (respects the real trust state).
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	// Manager used for the "what would load without project overrides" view.
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

	const globalResolved = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
	}).resolve(skipMissing);

	const projectResolved = projectTrusted
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(skipMissing)
		: globalResolved;

	const errors = [
		...settingsManager
			.drainErrors()
			.map((e) => `${e.scope} settings${e.path ? ` (${e.path})` : ""}: ${e.error.message}`),
		...globalSettingsManager
			.drainErrors()
			.map((e) => `${e.scope} settings (global view)${e.path ? ` (${e.path})` : ""}: ${e.error.message}`),
	];

	return {
		cwd,
		agentDir,
		projectBaseDir,
		projectTrusted,
		settingsManager,
		global: buildView(globalResolved, agentDir, projectBaseDir),
		project: buildView(projectResolved, agentDir, projectBaseDir),
		errors,
	};
}

export function viewFor(catalog: Catalog, scope: "global" | "project"): CatalogView {
	return scope === "project" ? catalog.project : catalog.global;
}

/** Items from the global view, filtered by a free-text query. */
export function filterItems(items: ResourceItem[], query: string): ResourceItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter(
		(item) =>
			item.displayName.toLowerCase().includes(q) ||
			item.type.toLowerCase().includes(q) ||
			item.path.toLowerCase().includes(q) ||
			item.groupLabel.toLowerCase().includes(q),
	);
}
