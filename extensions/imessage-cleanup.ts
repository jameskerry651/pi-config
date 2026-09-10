/**
 * imessage-cleanup —— 只读扫描扩展（无删除能力）
 *
 * 提供 sms_scan 工具：扫描 ~/Library/Messages/chat.db 的临时快照副本，
 * 按规则给每个会话分类（验证码 / 营销推广 / 服务通知 / 真人对话 / 群聊 / 白名单保留），
 * 输出 Markdown + JSON 报告。
 *
 * 明确的边界（改动前请先读）：
 *   - 本扩展不注册、也不包含任何删除短信的能力。
 *   - 扫描脚本对 chat.db 只是拷贝 + SELECT，原始数据库永不写入。
 *   - 删除是独立的、需要人工逐步确认的后续步骤，不在本次交付范围内。
 *
 * 前置条件：运行 pi 的终端 App（当前是 Ghostty）需要「完全磁盘访问权限」。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_DIR = join(homedir(), ".pi", "agent", "skills", "imessage-cleanup");
const SCAN_SCRIPT = join(SKILL_DIR, "scripts", "scan.py");

const FDA_HELP = `读取 chat.db 被系统拒绝（TCC / 完全磁盘访问权限）。

需要手动授权一次（脚本和扩展都无法自己申请）：
  1. 系统设置 → 隐私与安全性 → 完全磁盘访问权限
  2. 点「+」加入 /Applications/Ghostty.app（权限属于终端 App，不属于 pi）
  3. 确认开关打开
  4. 完全退出 Ghostty 再重开（TCC 缓存需要重启进程）
  5. 重跑 sms_scan

注意：换用 iTerm2 / VS Code / Warp 启动 pi 时，需要单独给那个 App 授权。`;

interface ScanChat {
	chat_id: number;
	handle: string;
	name: string;
	service: string;
	is_group: boolean;
	msg_count: number;
	outgoing: number;
	one_way: boolean;
	last_active: string | null;
	in_recently_deleted: boolean;
	bucket: string;
	label: string;
	cleanup_score: number;
	reasons: string[];
	samples: string[];
	suggestion: string;
}

interface ScanPayload {
	ok?: boolean;
	error?: string;
	hint?: string;
	raw?: string;
	generated_at?: string;
	readonly?: boolean;
	report_md?: string;
	report_json?: string;
	config?: string;
	totals?: {
		chats: number;
		messages: number;
		active_chats: number;
		active_messages: number;
		recoverable_chats: number;
	};
	buckets?: Record<string, { count: number; messages: number }>;
	chats?: ScanChat[];
}

function summarize(payload: ScanPayload, shown: number): string {
	const t = payload.totals;
	const lines: string[] = [];

	lines.push("只读扫描完成（原始 chat.db 未被写入，本次运行没有任何删除操作）");
	if (t) {
		lines.push(
			`会话 ${t.active_chats} 个（活跃）/ 消息 ${t.active_messages} 条` +
				(t.recoverable_chats ? `｜「最近删除」中还有 ${t.recoverable_chats} 个会话` : ""),
		);
	}

	const bucketOrder = [
		"verify_code",
		"marketing",
		"service_notice",
		"unknown",
		"person",
		"group",
		"keep",
	];
	const labels: Record<string, string> = {
		verify_code: "验证码",
		marketing: "营销推广",
		service_notice: "服务通知",
		unknown: "未分类",
		person: "真人对话",
		group: "群聊",
		keep: "白名单保留",
	};
	if (payload.buckets && Object.keys(payload.buckets).length) {
		lines.push("");
		lines.push("分类统计");
		for (const key of bucketOrder) {
			const b = payload.buckets[key];
			if (!b) continue;
			lines.push(`  ${labels[key] ?? key}：${b.count} 个会话 / ${b.messages} 条`);
		}
		for (const key of Object.keys(payload.buckets)) {
			if (!bucketOrder.includes(key)) {
				const b = payload.buckets[key];
				lines.push(`  ${key}：${b.count} 个会话 / ${b.messages} 条`);
			}
		}
	}

	const chats = payload.chats ?? [];
	// 只列活跃会话，且排除永不建议清理的
	const candidates = chats
		.filter((c) => !c.in_recently_deleted && c.bucket !== "keep" && c.bucket !== "person")
		.slice(0, shown);

	if (candidates.length) {
		lines.push("");
		lines.push(`清理分最高的 ${candidates.length} 个会话（分数只是启发式排序，不是删除建议）：`);
		for (const c of candidates) {
			const when = c.last_active ?? "未知";
			const sample = c.samples[0] ? c.samples[0].slice(0, 46) : "（无正文/仅附件）";
			lines.push(
				`  [${c.cleanup_score}] ${c.name}（${c.handle}）` +
					`　${c.label}・${c.msg_count} 条・最后 ${when}`,
			);
			lines.push(`        ${sample}`);
		}
	} else {
		lines.push("");
		lines.push("没有高分的待清理候选会话。");
	}

	const kept = chats.filter((c) => c.bucket === "keep" && c.reasons.some((r) => r.startsWith("⚠")));
	if (kept.length) {
		lines.push("");
		lines.push("需要注意的冲突（白名单保留但内容可疑）：");
		for (const c of kept) {
			lines.push(`  ${c.name}：${c.reasons.filter((r) => r.startsWith("⚠")).join("；")}`);
		}
	}

	lines.push("");
	if (payload.report_md) lines.push(`完整报告：${payload.report_md}`);
	if (payload.config) lines.push(`白名单配置：${payload.config}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "sms_scan",
			label: "短信只读扫描",
			description:
				"只读扫描 macOS 本地 iMessage/短信数据库（chat.db 快照），按规则把每个会话分类为" +
				"验证码/营销推广/服务通知/真人对话/群聊/白名单保留，并生成 Markdown + JSON 报告。" +
				"不会修改任何数据，也不具备删除能力。需要终端拥有完全磁盘访问权限。",
			promptSnippet:
				"只读扫描并分类 Mac 本地短信/iMessage 会话，生成清理候选报告（不做任何删除）",
			promptGuidelines: [
				"当用户想了解或清理 Mac 上的短信、iMessage、验证码、垃圾短信时，用 sms_scan 做只读分析。",
				"sms_scan 只生成报告、不删除任何数据；不要说它删除过消息。如果要讨论删除，必须明确说明当前交付不包含删除能力，并需要人工逐步确认。",
				"sms_scan 报错「authorization denied」时，把完全磁盘访问权限的授权步骤原样告诉用户，不要尝试绕过权限。",
			],
			parameters: Type.Object({
				top: Type.Optional(
					Type.Number({ description: "摘要里列出多少个高分候选会话，默认 12" }),
				),
				db: Type.Optional(
					Type.String({ description: "chat.db 路径，默认 ~/Library/Messages/chat.db（仅测试用）" }),
				),
			}),

			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				if (!existsSync(SCAN_SCRIPT)) {
					return {
						content: [
							{ type: "text", text: `找不到扫描脚本：${SCAN_SCRIPT}` },
						],
						details: {},
					};
				}

				const shown = Math.max(1, Math.min(50, params.top ?? 12));
				const args = [SCAN_SCRIPT, "--json", "--quiet", "--top", String(shown)];
				if (params.db) args.push("--db", params.db);

				const result = await pi.exec("python3", args, { signal, timeout: 300000 });
				const stdout = (result.stdout ?? "").trim();

				let payload: ScanPayload | null = null;
				try {
					payload = JSON.parse(stdout) as ScanPayload;
				} catch {
					payload = null;
				}

				if (!payload) {
					const err = (result.stderr ?? "").trim() || stdout || "扫描脚本没有输出可解析的 JSON";
					const fda = /authorization denied|Operation not permitted|Permission denied/i.test(err);
					return {
						content: [
							{
								type: "text",
								text: fda ? `扫描失败。\n\n${FDA_HELP}` : `扫描失败：${err}`,
							},
						],
						details: { exitCode: result.code, stderr: result.stderr },
					};
				}

				if (payload.ok === false) {
					// 脚本在权限失败时会带上 hint（一次性授权指引）和 raw（系统原始报错）
					const parts = [`扫描失败：${payload.error}`];
					if (payload.hint) parts.push(payload.hint);
					else if (payload.error && /authorization denied|Operation not permitted|Permission denied/i.test(payload.error)) {
						parts.push(FDA_HELP);
					}
					return {
						content: [{ type: "text", text: parts.join("\n\n") }],
						details: payload,
					};
				}

				return {
					content: [{ type: "text", text: summarize(payload, shown) }],
					details: payload,
				};
			},
		}),
	);

	pi.registerCommand("sms-scan", {
		description: "只读扫描并分类 Mac 本地短信/iMessage（不做任何删除）",
		handler: async (_args, ctx) => {
			if (!existsSync(SCAN_SCRIPT)) {
				ctx.ui.notify(`找不到扫描脚本：${SCAN_SCRIPT}`, "error");
				return;
			}
			ctx.ui.notify("正在只读扫描短信数据库…", "info");
			const result = await pi.exec("python3", [SCAN_SCRIPT, "--json", "--quiet", "--top", "5"], {
				timeout: 300000,
			});
			try {
				const payload = JSON.parse((result.stdout ?? "").trim()) as ScanPayload;
				if (payload.ok === false) {
					ctx.ui.notify(payload.error ?? "扫描失败", "error");
					return;
				}
				const t = payload.totals;
				ctx.ui.notify(
					`扫描完成：${t?.active_chats ?? "?"} 个活跃会话 / ${t?.active_messages ?? "?"} 条消息\n${payload.report_md ?? ""}`,
					"info",
				);
			} catch {
				const fda = /authorization denied|Operation not permitted/i.test(result.stderr ?? "");
				ctx.ui.notify(fda ? "需要完全磁盘访问权限，见 /sms-scan 说明或阅读 SKILL.md" : "扫描失败", "error");
			}
		},
	});
}
