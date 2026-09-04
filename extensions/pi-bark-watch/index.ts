/**
 * Pi Bark-Watch extension
 *
 * Sends a push notification to your iPhone (and onward to your Apple Watch)
 * whenever an agent task takes longer than a configurable threshold.
 *
 * How it reaches the watch:
 *   macOS native notifications never reach an Apple Watch. This extension
 *   sends an HTTP push to the free Bark service (https://bark.day.app), which
 *   delivers a system notification to your iPhone. If your Apple Watch has
 *   Notification Mirroring enabled for the Bark app, that notification is then
 *   forwarded to the watch.
 *
 * Setup:
 *   1. Install the free Bark app on your iPhone (App Store).
 *   2. Open Bark -> copy your Device Key.
 *   3. Put the Device Key in config.json (recommended) or set PI_BARK_WATCH_KEY.
 *   4. (Optional) On your iPhone, Watch app -> Notifications -> Bark ->
 *      enable "Mirror iPhone Alerts" so it shows on the watch.
 *
 * Configuration (config.json next to this file, or environment variables):
 *   server      -> PI_BARK_SERVER          default "https://api.day.app"
 *   deviceKey   -> PI_BARK_WATCH_KEY       (required to actually send)
 *   minutes     -> PI_BARK_WATCH_MINUTES   default 3
 *   sound       -> PI_BARK_WATCH_SOUND     default "minuet"
 *   level       -> PI_BARK_WATCH_LEVEL     optional "critical"|"active"|"timeSensitive"|"passive"
 *
 * Test with:  /bark-watch
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface BarkConfig {
  server: string;
  deviceKey: string;
  minutes: number;
  sound: string;
  level: "critical" | "active" | "timeSensitive" | "passive";
}

const DEFAULT_SERVER = "https://api.day.app";
const DEFAULT_MINUTES = 3;
const DEFAULT_SOUND = "minuet";
const DEFAULT_LEVEL: BarkConfig["level"] = "active";
const BARK_REQUEST_TIMEOUT_MS = 10_000;
const VALID_LEVELS = new Set<BarkConfig["level"]>([
  "critical",
  "active",
  "timeSensitive",
  "passive",
]);
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function normalizeServer(value: unknown): string {
  const server = asString(value, DEFAULT_SERVER).replace(/\/+$/, "");
  try {
    const url = new URL(server);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return server;
  } catch {
    console.warn(`[bark-watch] Invalid server URL; using ${DEFAULT_SERVER}`);
    return DEFAULT_SERVER;
  }
}

function loadConfig(): BarkConfig {
  // Prefer a JSON file next to the extension. Keep the old global path as a
  // compatibility fallback for extensions launched from another location.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const legacyPath = join(
    home,
    CONFIG_DIR_NAME,
    "agent",
    "extensions",
    "pi-bark-watch",
    "config.json",
  );
  const configPaths = [...new Set([join(EXTENSION_DIR, "config.json"), legacyPath])];

  let file: Record<string, unknown> = {};
  for (const configPath of configPaths) {
    try {
      if (!existsSync(configPath)) continue;
      const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        file = parsed as Record<string, unknown>;
      } else {
        console.warn(`[bark-watch] Ignoring non-object config: ${configPath}`);
      }
      break;
    } catch (err) {
      console.warn(
        `[bark-watch] Ignoring invalid config ${configPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      break;
    }
  }

  const rawMinutes = Number(
    process.env.PI_BARK_WATCH_MINUTES ?? file.minutes ?? DEFAULT_MINUTES,
  );
  const rawLevel = asString(
    process.env.PI_BARK_WATCH_LEVEL ?? file.level,
    DEFAULT_LEVEL,
  );
  const level = VALID_LEVELS.has(rawLevel as BarkConfig["level"])
    ? (rawLevel as BarkConfig["level"])
    : DEFAULT_LEVEL;
  if (rawLevel !== DEFAULT_LEVEL && !VALID_LEVELS.has(rawLevel as BarkConfig["level"])) {
    console.warn(`[bark-watch] Invalid level "${rawLevel}"; using ${DEFAULT_LEVEL}`);
  }

  return {
    server: normalizeServer(process.env.PI_BARK_SERVER ?? file.server),
    deviceKey: asString(process.env.PI_BARK_WATCH_KEY ?? file.deviceKey, ""),
    minutes:
      Number.isFinite(rawMinutes) && rawMinutes > 0
        ? rawMinutes
        : DEFAULT_MINUTES,
    sound: asString(
      process.env.PI_BARK_WATCH_SOUND ?? file.sound,
      DEFAULT_SOUND,
    ),
    level,
  };
}

/** Format a millisecond duration into a human-readable string. */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const h = Math.floor(m / 60);
  if (h === 0) return m === 0 ? `${s}s` : `${m}m ${s}s`;
  return `${h}h ${m % 60}m`;
}

/** POST a push to the Bark server. Resolves true on a 2xx response. */
async function sendBark(
  config: BarkConfig,
  title: string,
  body: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    title,
    body,
    device_key: config.deviceKey,
    group: "pi",
    sound: config.sound,
    isArchive: "1",
    level: config.level,
  };

  // agent_settled and extension commands normally have no ctx.signal, so a
  // separate deadline is required to prevent Pi from waiting forever on Bark.
  const timeoutSignal = AbortSignal.timeout(BARK_REQUEST_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await fetch(`${config.server}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
    const text = await res.text().catch(() => "");

    if (!res.ok) {
      console.warn(
        `[bark-watch] Bark push failed: ${res.status} ${text}`.slice(0, 500),
      );
      return false;
    }
    return true;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError") {
      console.warn(
        `[bark-watch] Bark push timed out after ${BARK_REQUEST_TIMEOUT_MS}ms`,
      );
    } else if (name !== "AbortError") {
      console.warn("[bark-watch] Bark push error:", err);
    }
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  // Timestamp of when the current agent run started (null when idle).
  let startedAt: number | null = null;
  let outcome: "running" | "success" | "failed" | "aborted" = "success";

  pi.on("agent_start", () => {
    // Keep the first start of a cycle so retries/compactions count together.
    if (startedAt === null) {
      startedAt = Date.now();
      outcome = "running";
    }
  });

  pi.on("agent_end", (event) => {
    const assistant = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (assistant?.role === "assistant") {
      if (assistant.stopReason === "aborted") outcome = "aborted";
      else if (assistant.stopReason === "error") outcome = "failed";
      else outcome = "success";
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (startedAt === null) return;

    const elapsedMs = Date.now() - startedAt;
    const finalOutcome = outcome;
    startedAt = null;
    outcome = "success";

    const config = loadConfig();
    const thresholdMs = config.minutes * 60_000;
    if (
      finalOutcome !== "success" ||
      elapsedMs < thresholdMs ||
      !config.deviceKey
    ) {
      return;
    }

    const duration = formatDuration(elapsedMs);
    const body = `Pi 任务完成，耗时 ${duration}`;

    // Local terminal notification (TUI/RPC modes only).
    if (ctx.hasUI) {
      ctx.ui.notify(`Pi 任务完成 · ${duration}`, "info");
    }

    await sendBark(config, "Pi 任务完成", body, ctx.signal);
  });

  // Safety: clear state on shutdown so a stale timestamp never leaks into a
  // future session in the same process.
  pi.on("session_shutdown", () => {
    startedAt = null;
    outcome = "success";
  });

  // Manual test command so you can verify the whole pipeline.
  pi.registerCommand("bark-watch", {
    description: "Send a test Bark push to verify watch notifications",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      if (!config.deviceKey) {
        ctx.ui.notify(
          "未配置: 请设置 PI_BARK_WATCH_KEY 或填写 config.json 的 deviceKey",
          "error",
        );
        return;
      }
      const ok = await sendBark(
        config,
        "Pi Bark-Watch 测试",
        "这是一条来自 Pi 扩展的测试推送，请查看手表。",
        ctx.signal,
      );
      ctx.ui.notify(
        ok ? "测试推送已发送 ✅" : "推送失败（详见日志）",
        ok ? "info" : "error",
      );
    },
  });
}
