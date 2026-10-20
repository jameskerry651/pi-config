/**
 * SSH Remote Execution
 *
 * Delegates the built-in tools (read, write, edit, bash, ls, find, grep) and user
 * `!` commands to a remote machine over SSH.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *   pi -e ./ssh.ts --ssh user@host:~/projects/app
 *
 * Requirements:
 *   - Key-based auth: every call runs with BatchMode=yes, so a password or
 *     passphrase prompt fails the call instead of hanging it.
 *   - bash/sh, coreutils or BSD userland, and `file` on the remote.
 *   - `rg` on the remote for gitignore-aware `grep` output; without it `grep`
 *     falls back to the system `grep`, and `find` always uses `find`.
 *   - A bare `host:port` is not read as a port (it looks like `host:path`); use
 *     ~/.ssh/config for non-standard ports.
 *
 * Behavior notes:
 *   - Paths inside the local working directory are rebased onto the remote one.
 *     Absolute paths outside it (including this machine's pi docs) are passed
 *     through unchanged and therefore only work if they exist on the remote.
 *   - PI_* session variables are forwarded; the rest of the local environment is
 *     not, so the remote shell keeps its own PATH and toolchain.
 *   - Aborting or timing out kills the local ssh client. A remote command only
 *     receives the hangup if its ssh session channel closes, so a daemonized
 *     process can outlive the tool call.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateLine,
	type BashOperations,
	type EditOperations,
	type ExtensionAPI,
	type ExtensionToolContext,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type ToRemote = (path: string) => string;

/** Defaults keep an unreachable host from stalling a tool call. */
const SSH_ARGS = [
	"-T",
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=10",
	"-o",
	"ServerAliveInterval=15",
	"-o",
	"ServerAliveCountMax=3",
];

const DEFAULT_MATCH_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;

interface Remote {
	host: string;
	/** Absolute working directory on the remote. */
	cwd: string;
}

interface GrepInput {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Shell and SSH plumbing
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping: the only quoting that survives every shell. */
function quote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

/** Remote path literal that still expands a leading `~` (quoting would stop it). */
function remotePath(path: string): string {
	if (path === "~") return `"$HOME"`;
	if (path === "~/" || path.startsWith("~/")) return `"$HOME"${quote(path.slice(1))}`;
	return quote(path);
}

/**
 * Mirror the host path onto the remote tree. Paths outside the local working
 * directory are returned unchanged so remote-absolute paths keep working.
 */
function createToRemote(localCwd: string, remoteCwd: string): ToRemote {
	return (path) => {
		const absolute = resolve(path);
		const rel = relative(localCwd, absolute);
		if (rel === "") return remoteCwd;
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return absolute;
		return join(remoteCwd, rel);
	};
}

function resolveLocalPath(input: string, cwd: string): string {
	let value = input.trim();
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
	return resolve(cwd, value);
}

function terminate(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const timer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 2000);
	timer.unref();
}

interface SshResult {
	stdout: Buffer;
	stderr: string;
	code: number | null;
}

/** One buffered remote command. Never throws on a non-zero exit code. */
function runSsh(
	host: string,
	command: string,
	options: { signal?: AbortSignal; stdin?: string | Buffer } = {},
): Promise<SshResult> {
	return new Promise((resolvePromise, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const child = spawn("ssh", [...SSH_ARGS, host, command], { stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let stderr = "";
		const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
		const onAbort = () => terminate(child);
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			resolvePromise({ stdout: Buffer.concat(chunks), stderr, code });
		});
		// The remote side may exit before reading stdin; that is not an error here.
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.stdin ?? "");
	});
}

/** Buffered remote command that rejects on failure, for tool operations. */
async function sshExec(host: string, command: string, signal?: AbortSignal): Promise<Buffer> {
	const result = await runSsh(host, command, { signal });
	if (result.code !== 0) throw new Error(result.stderr.trim() || `ssh ${host} exited with code ${result.code}`);
	return result.stdout;
}

// ---------------------------------------------------------------------------
// Tool operations
// ---------------------------------------------------------------------------

function createRemoteReadOps(remote: Remote, toRemote: ToRemote): ReadOperations {
	return {
		readFile: (path) => sshExec(remote.host, `cat ${remotePath(toRemote(path))}`),
		access: async (path) => {
			const target = remotePath(toRemote(path));
			if ((await runSsh(remote.host, `test -r ${target}`)).code === 0) return;
			// One extra round trip only when access fails, for a message the model can act on.
			const exists = (await runSsh(remote.host, `test -e ${target}`)).code === 0;
			throw new Error(
				exists
					? `EACCES: permission denied, access '${path}' on ${remote.host}`
					: `ENOENT: no such file or directory, access '${path}' on ${remote.host}`,
			);
		},
		// Return any image type: the read tool converts unsupported formats to PNG
		// itself. Reporting null would send binary bytes to the model as text.
		detectImageMimeType: async (path) => {
			const target = remotePath(toRemote(path));
			for (const command of [`file -b --mime-type -- ${target}`, `file -bI -- ${target}`]) {
				try {
					const output = (await sshExec(remote.host, command)).toString("utf8").trim();
					const mimeType = (output.split(";")[0] ?? "").trim().toLowerCase();
					return mimeType.startsWith("image/") ? mimeType : null;
				} catch {
					// Try the next invocation style of `file`.
				}
			}
			return null;
		},
	};
}

function createRemoteWriteOps(remote: Remote, toRemote: ToRemote): WriteOperations {
	return {
		// Content travels over stdin: no base64, no quoting, and writes are binary-safe.
		writeFile: async (path, content) => {
			const target = toRemote(path);
			const result = await runSsh(remote.host, `mkdir -p ${remotePath(dirname(target))} && cat > ${remotePath(target)}`, {
				stdin: content,
			});
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `Failed to write ${path} on ${remote.host}`);
			}
		},
		mkdir: async (dir) => {
			await sshExec(remote.host, `mkdir -p ${remotePath(toRemote(dir))}`);
		},
	};
}

function createRemoteEditOps(remote: Remote, toRemote: ToRemote): EditOperations {
	const read = createRemoteReadOps(remote, toRemote);
	const write = createRemoteWriteOps(remote, toRemote);
	return {
		readFile: read.readFile,
		access: read.access,
		writeFile: write.writeFile,
	};
}

/** Forward the session variables the bash tool advertises, and nothing else. */
function formatEnv(env: NodeJS.ProcessEnv | undefined): string {
	if (!env) return "";
	const exports: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("PI_") || value === undefined) continue;
		exports.push(`export ${key}=${quote(value)}`);
	}
	return exports.length > 0 ? `${exports.join("\n")}\n` : "";
}

function createRemoteBashOps(remote: Remote, toRemote: ToRemote): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) =>
			new Promise((resolvePromise, reject) => {
				const script = `cd ${remotePath(toRemote(cwd))} || exit 1\n${formatEnv(env)}${command}`;
				const child = spawn("ssh", [...SSH_ARGS, remote.host, script], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer =
					timeout && timeout > 0
						? setTimeout(() => {
								timedOut = true;
								terminate(child);
							}, timeout * 1000)
						: undefined;
				const onAbort = () => terminate(child);
				signal?.addEventListener("abort", onAbort, { once: true });

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				});
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
						return;
					}
					// Report signal deaths the way the shell does, not as a success.
					const signalCode = child.signalCode;
					resolvePromise({
						exitCode: code ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : null),
					});
				});
			}),
	};
}

function createRemoteLsOps(remote: Remote, toRemote: ToRemote): LsOperations {
	// A directory listing already knows which entries are directories; cache them
	// so the per-entry stat() the ls tool performs stays local.
	const directories = new Map<string, boolean>();

	const statDirectory = async (path: string): Promise<boolean> => {
		const cached = directories.get(path);
		if (cached !== undefined) return cached;
		const target = remotePath(toRemote(path));
		const result = await runSsh(
			remote.host,
			`test -d ${target} && echo dir || { test -e ${target} && echo file || echo missing; }`,
		);
		const kind = result.stdout.toString("utf8").trim();
		if (kind === "missing") throw new Error(`Path not found: ${path}`);
		const isDirectory = kind === "dir";
		directories.set(path, isDirectory);
		return isDirectory;
	};

	return {
		exists: async (path) => (await runSsh(remote.host, `test -e ${remotePath(toRemote(path))}`)).code === 0,
		stat: async (path) => {
			const isDirectory = await statDirectory(path);
			return { isDirectory: () => isDirectory };
		},
		readdir: async (path) => {
			const marker = "__PI_SSH_DIRS__";
			const script = [
				`cd ${remotePath(toRemote(path))} || exit 1`,
				"ls -1A",
				`printf '\\n%s\\n' ${marker}`,
				"find . -mindepth 1 -maxdepth 1 -type d -print",
			].join("\n");
			const output = (await sshExec(remote.host, script)).toString("utf8");
			const [namesPart, directoriesPart = ""] = output.split(marker);
			const names = namesPart.split("\n").filter((name) => name !== "");
			const directoryNames = new Set(
				directoriesPart
					.split("\n")
					.map((entry) => entry.trim().replace(/^\.\//, ""))
					.filter((entry) => entry !== ""),
			);
			for (const name of names) directories.set(join(path, name), directoryNames.has(name));
			return names;
		},
	};
}

function createRemoteFindOps(remote: Remote, toRemote: ToRemote): FindOperations {
	return {
		exists: async (path) => (await runSsh(remote.host, `test -e ${remotePath(toRemote(path))}`)).code === 0,
		glob: async (pattern, cwd, { ignore, limit }) => {
			const effectiveLimit = Math.max(1, limit || DEFAULT_FIND_LIMIT);
			// find's `*` also matches `/`, so a single -path plus a basename -name
			// covers both `**/x.ts` and bare `x.ts` patterns.
			const matches = [`-path ${quote(`./${pattern}`)}`, `-name ${quote(basename(pattern))}`];
			const excludes = ignore
				.map((entry) => entry.replace(/^\*\*\//, "").replace(/\/\*\*$/, ""))
				.filter((entry) => entry !== "")
				.map((entry) => `-not -path ${quote(`*${entry}*`)}`);
			const script = [
				`cd ${remotePath(toRemote(cwd))} || exit 1`,
				`find . -type f \\( ${matches.join(" -o ")} \\) ${excludes.join(" ")} | LC_ALL=C sort | head -n ${effectiveLimit} | sed 's|^\\./||'`,
			].join("\n");
			const output = (await sshExec(remote.host, script)).toString("utf8");
			return output.split("\n").filter((entry) => entry !== "");
		},
	};
}

/**
 * The native grep tool spawns a *local* ripgrep and only reads matched lines
 * through operations, so it cannot be redirected. This replacement runs the
 * search on the remote and formats the output like the native tool.
 */
function createRemoteGrepDefinition(local: AnyToolDefinition, remote: Remote, toRemote: ToRemote): AnyToolDefinition {
	return {
		...local,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const input = params as GrepInput;
			const searchRoot = resolveLocalPath(input.path || ".", ctx?.cwd ?? process.cwd());
			const remoteRoot = toRemote(searchRoot);
			const probe = await runSsh(
				remote.host,
				`test -d ${remotePath(remoteRoot)} && echo dir || { test -e ${remotePath(remoteRoot)} && echo file || echo missing; }`,
				{ signal },
			);
			const kind = probe.stdout.toString("utf8").trim();
			if (kind === "missing") throw new Error(`Path not found: ${searchRoot}`);

			const isDirectory = kind === "dir";
			const searchDir = isDirectory ? remoteRoot : dirname(remoteRoot);
			const target = isDirectory ? "." : basename(remoteRoot);
			const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_MATCH_LIMIT);
			const contextLines = input.context && input.context > 0 ? Math.floor(input.context) : 0;

			const rgFlags = ["--line-number", "--no-heading", "--color=never", "--hidden"];
			if (input.ignoreCase) rgFlags.push("--ignore-case");
			if (input.literal) rgFlags.push("--fixed-strings");
			if (input.glob) rgFlags.push("--glob", input.glob);
			if (contextLines > 0) rgFlags.push("--context", String(contextLines));

			const grepFlags = ["-r", "-n", "--binary-files=without-match"];
			if (input.ignoreCase) grepFlags.push("-i");
			if (input.literal) grepFlags.push("-F");
			if (isDirectory && input.glob) grepFlags.push(`--include=${input.glob}`);
			if (contextLines > 0) grepFlags.push("-C", String(contextLines));

			const script = [
				`cd ${remotePath(searchDir)} || exit 1`,
				"if command -v rg >/dev/null 2>&1; then",
				`  rg ${rgFlags.map(quote).join(" ")} -- ${quote(input.pattern)} ${quote(target)}`,
				"else",
				`  grep ${grepFlags.map(quote).join(" ")} -- ${quote(input.pattern)} ${quote(target)}`,
				"fi",
			].join("\n");

			const result = await runSsh(remote.host, script, { signal });
			// 0 = matches, 1 = no matches; anything else is a real failure.
			if (result.code !== 0 && result.code !== 1) {
				throw new Error(result.stderr.trim() || `Search failed on ${remote.host}`);
			}

			const outputLines: string[] = [];
			let matchCount = 0;
			let matchLimitReached = false;
			let linesTruncated = false;
			for (const line of result.stdout.toString("utf8").split("\n")) {
				if (line === "" || line === "--") continue;
				const parsed = /^(.*?)([:-])(\d+)\2(.*)$/.exec(line);
				if (!parsed) continue;
				const [, filePath, separator, lineNumber, lineText] = parsed;
				const displayPath = filePath.replace(/^\.\//, "");
				if (separator === ":") {
					// Stop at the next match once the limit is reached, but keep the
					// trailing context lines rg already printed for the last match.
					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						break;
					}
					matchCount++;
				}
				const { text, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
				if (wasTruncated) linesTruncated = true;
				outputLines.push(separator === ":" ? `${displayPath}:${lineNumber}: ${text}` : `${displayPath}-${lineNumber}- ${text}`);
			}

			if (matchCount === 0) {
				return { content: [{ type: "text", text: "No matches found" }], details: undefined };
			}

			const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			const notices: string[] = [];
			const details: Record<string, unknown> = {};
			if (matchLimitReached) {
				notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (linesTruncated) {
				notices.push("Some lines truncated. Use read tool to see full lines");
				details.linesTruncated = true;
			}
			let text = truncation.content;
			if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
			return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
		},
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** `user@host:/path`, `user@host:~/path`, `[::1]:/path`, or plain `user@host`. */
function parseSshFlag(value: string): { host: string; path?: string } {
	const match = /^(?<host>\[[^\]]+\]|[^:]+):(?<path>\/.*|~.*)$/.exec(value);
	if (match?.groups?.host && match.groups.path) return { host: match.groups.host, path: match.groups.path };
	return { host: value };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	// Local fallbacks. Definitions (not AgentTool wrappers) keep the `ctx`
	// parameter, which carries the live session cwd.
	const localCwd = process.cwd();
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localBash = createBashToolDefinition(localCwd);
	const localLs = createLsToolDefinition(localCwd);
	const localFind = createFindToolDefinition(localCwd);
	const localGrep = createGrepToolDefinition(localCwd);

	const buildRemoteTools = (remote: Remote, sessionCwd: string) => {
		const toRemote = createToRemote(sessionCwd, remote.cwd);
		return {
			read: createReadToolDefinition(sessionCwd, { operations: createRemoteReadOps(remote, toRemote) }),
			write: createWriteToolDefinition(sessionCwd, { operations: createRemoteWriteOps(remote, toRemote) }),
			edit: createEditToolDefinition(sessionCwd, { operations: createRemoteEditOps(remote, toRemote) }),
			bash: createBashToolDefinition(sessionCwd, { operations: createRemoteBashOps(remote, toRemote) }),
			ls: createLsToolDefinition(sessionCwd, { operations: createRemoteLsOps(remote, toRemote) }),
			find: createFindToolDefinition(sessionCwd, { operations: createRemoteFindOps(remote, toRemote) }),
			grep: createRemoteGrepDefinition(localGrep, remote, toRemote),
		};
	};

	type RemoteTools = ReturnType<typeof buildRemoteTools>;

	let remote: Remote | null = null;
	let remoteTools: RemoteTools | null = null;
	// Set when the flag was given but the host could not be reached: fail every
	// tool call instead of silently running it on this machine.
	let remoteFailure: string | null = null;
	let sessionCwd = localCwd;

	const withRemote = (
		local: AnyToolDefinition,
		pick: (tools: RemoteTools) => AnyToolDefinition,
		extra: { defaultActive?: boolean } = {},
	): AnyToolDefinition => ({
		...local,
		...extra,
		async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext) {
			if (remoteFailure) throw new Error(remoteFailure);
			const tool = remote && remoteTools ? pick(remoteTools) : local;
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool(withRemote(localRead, (tools) => tools.read));
	pi.registerTool(withRemote(localWrite, (tools) => tools.write));
	pi.registerTool(withRemote(localEdit, (tools) => tools.edit));
	pi.registerTool(withRemote(localBash, (tools) => tools.bash));
	// ls/find/grep are not in pi's default tool set: keep them inactive unless the
	// session selected them, so registering the override does not change the loadout.
	pi.registerTool(withRemote(localLs, (tools) => tools.ls, { defaultActive: false }));
	pi.registerTool(withRemote(localFind, (tools) => tools.find, { defaultActive: false }));
	pi.registerTool(withRemote(localGrep, (tools) => tools.grep, { defaultActive: false }));

	pi.on("session_start", async (_event, ctx) => {
		remote = null;
		remoteTools = null;
		remoteFailure = null;
		sessionCwd = ctx.cwd || localCwd;

		const arg = pi.getFlag("ssh");
		if (typeof arg !== "string" || arg.trim() === "") return;

		const parsed = parseSshFlag(arg.trim());
		try {
			// Resolve the remote cwd once so every later path is absolute.
			const cwd = parsed.path
				? (await sshExec(parsed.host, `cd ${remotePath(parsed.path)} && pwd`)).toString("utf8").trim()
				: (await sshExec(parsed.host, "pwd")).toString("utf8").trim();
			if (!cwd) throw new Error("remote pwd returned nothing");

			remote = { host: parsed.host, cwd };
			remoteTools = buildRemoteTools(remote, sessionCwd);
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${remote.host}:${remote.cwd}`));
			ctx.ui.notify(`SSH mode: ${remote.host}:${remote.cwd}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			remoteFailure = `SSH remote ${parsed.host} is unavailable: ${message}`;
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", `SSH failed: ${parsed.host}`));
			ctx.ui.notify(remoteFailure, "error");
		}
	});

	// User `!` commands run remotely too. Throwing blocks them: the runner treats
	// a handler failure as fail-closed, so a broken tunnel never runs locally.
	pi.on("user_bash", () => {
		if (remoteFailure) throw new Error(remoteFailure);
		if (!remote) return;
		const toRemote = createToRemote(sessionCwd, remote.cwd);
		return { operations: createRemoteBashOps(remote, toRemote) };
	});

	// Point the model at the remote directory through the structured prompt
	// options; replacing the rendered text no longer matches the `<cwd>` section.
	pi.on("before_agent_start", (event) => {
		if (!remote) return;
		const options = event.systemPromptOptions;
		options.cwd = remote.cwd;
		options.sections = {
			...options.sections,
			remote_execution: [
				`File and shell tools run on ${remote.host} in ${remote.cwd}.`,
				"Relative paths resolve there; absolute paths inside the local working directory are rebased too.",
				`Pi's own docs and examples in <docs> live on the local machine and are not readable through these tools.`,
			].join("\n"),
		};
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("ssh", undefined);
	});
}
