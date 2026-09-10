# pi Resource Manager

Interactive manager for pi **skills, extensions, prompt templates and themes**.
Persistent toggles write the exact same `+path` / `-path` patterns as the built-in
`pi config`, so the two stay fully compatible. A separate *session-only* soft
disable lets you switch things off and see the effect immediately, without a
reload.

Location: `~/.pi/agent/extensions/resource-manager/` (auto-discovered, global).

## Commands

| Command | What it does |
|---|---|
| `/resources` | Open the interactive selector |
| `/resources project` | Open it in project write scope |
| `/resources skills` | Open it pre-filtered to skills |
| `/resources-reload` | Reload extensions, skills, prompts, themes (needed after persistent changes) |

## Selector keys

| Key | Action |
|---|---|
| `↑` / `↓` / `PgUp` / `PgDn` | move selection |
| type anything | filter (always-on search) |
| `space` | toggle the selected resource |
| `ctrl+s` | toggle **session-only** disable (immediate, no reload) |
| `tab` | switch write scope: Global ⇄ Project |
| `ctrl+d` | help + settings diagnostics |
| `enter` | finish and offer to `/reload` |
| `esc` | finish without reloading |

Markers: `[x]` enabled · `[ ]` disabled · `[~]` session-disabled ·
`[+]` project force-load · `[-]` project force-unload.

## Global vs project scope

- **Global** writes to `~/.pi/agent/settings.json` and can only change
  user/global resources.
- **Project** writes to `.pi/settings.json` and requires a trusted project. It
  can additionally override inherited global resources:
  - `[+]/load` — force-enable something global scope disabled
  - `[-]/unload` — disable something global scope enables
  - inherited globals that are off are dimmed

Overriding a global resource from project scope writes two entries (a plain
absolute include plus the signed one), e.g.

```json
{
  "skills": [
    "/Users/you/.pi/agent/skills/foo/SKILL.md",
    "-/Users/you/.pi/agent/skills/foo/SKILL.md"
  ]
}
```

Package resources are toggled inside the package entry's own filter arrays:

```json
{
  "packages": [
    { "source": "npm:pkg", "skills": ["-skills/foo"] }
  ]
}
```

and a project-scope override of a globally configured package uses an
`autoload: false` delta entry.

## Session-only soft disable

`ctrl+s` (or `resource_manager mode="session"`) applies immediately:

| Type | Effect |
|---|---|
| extension | its **tools** are removed from the active tool set |
| skill | removed from the system prompt, `/skill:<name>` blocked |
| prompt | `/<name>` blocked before expansion |
| theme | not supported (use a persistent toggle) |

Soft state is stored in the session (`appendEntry`), so it survives `/resume`
and follows branch navigation.

### Known limitations

1. An already loaded extension **cannot be unloaded**. Soft-disabling it only
   removes its tools; its hooks, commands and shortcuts keep running.
2. Extension slash commands are dispatched by pi *before* the `input` event, so
   they cannot be blocked at runtime. Use a persistent toggle + `/reload`.
3. A soft-disabled skill is hidden from the prompt, but its `SKILL.md` still
   exists on disk and can be read if the model knows the path.
4. Persistent toggles always need `/resources-reload` (or a restart).
5. `/reload` rebuilds the session runtime — do it when the agent is idle.
6. Soft-disable bookkeeping tracks tool names; another extension that calls
   `pi.setActiveTools()` can re-enable a soft-disabled extension's tools until
   the next soft toggle, and two extensions sharing a tool name can cross-restore.

## Model tool: `resource_manager`

```
action:  "list" | "set" | "reload"
type:    "extension" | "skill" | "prompt" | "theme"
name:    substring match on name or path
enabled: target state for "set"
scope:   "global" | "project"   (default: global)
mode:    "persist" | "session"  (default: persist)
```

- `action="list"` is read-only and safe.
- `mode="persist"` writes settings.json and reports that `/resources-reload` is
  needed; the tool does not reload automatically mid-turn.
- `mode="session"` applies immediately and is session-scoped.
- Enabling an extension always requires an interactive confirmation. In a
  non-interactive session the tool refuses instead of silently enabling code.

## Safety

Persistently enabling an extension is a code-execution switch. The selector and
the tool require confirmation before enabling one, show the real path/package
source, and refuse project-scope writes while the project is untrusted
(`/trust` first). Scanning never installs packages: the extension calls pi's
resolver with `onMissing → skip`, so a missing npm/git package is only reported,
never fetched.

## Implementation notes

- `catalog.ts` — enumerates resources by reusing pi's own
  `SettingsManager` + `DefaultPackageManager` (two views: global and project).
  Discovery rules are never reimplemented, so this cannot drift from `pi config`.
- `store.ts` — pattern generation/writing for top-level and package resources,
  including project overrides of inherited globals.
- `runtime.ts` — session soft-disable, tool set recomputation, system-prompt
  skill filtering, input interception.
- `ui.ts` — the TUI selector.
- `index.ts` — commands, tool and event wiring.

No local `node_modules` is required: pi bundles `@earendil-works/pi-*` and
`typebox` for extensions. If you want editor/type-check support in this folder,
create the same symlinks the pi runtime provides:

```bash
mkdir -p node_modules/@earendil-works
G="$(npm root -g)/@earendil-works/pi-coding-agent"
ln -s "$G" node_modules/@earendil-works/pi-coding-agent
ln -s "$G/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -s "$G/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
ln -s "$G/node_modules/typebox" node_modules/typebox
```
