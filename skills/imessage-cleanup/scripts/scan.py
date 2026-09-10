#!/usr/bin/env python3
"""
imessage-cleanup / scan.py —— 只读扫描 + 分类 + 报告生成

设计约束（重要，改动前请先读）：
  1. 本脚本对 ~/Library/Messages/chat.db 永远只做「拷贝」，从不写入。
  2. 所有 SQL 都是 SELECT。拷贝出来的快照以 PRAGMA query_only=1 打开。
  3. 本脚本没有任何删除/修改能力。删除是另一个（尚未实现的）独立步骤。
  4. 读取真实 chat.db 需要运行 pi 的终端 App 拥有「完全磁盘访问权限」。

用法：
  python3 scan.py                          # 扫描默认位置，生成 Markdown + JSON 报告
  python3 scan.py --db /path/to/chat.db    # 扫描指定库（测试夹具用）
  python3 scan.py --json                   # stdout 只输出 JSON 摘要（给 pi 扩展调用）
  python3 scan.py --quiet                  # 不打印进度
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

APPLE_EPOCH_OFFSET = 978307200  # 2001-01-01 UTC
DEFAULT_DB = Path.home() / "Library" / "Messages" / "chat.db"
WORK_DIR = Path.home() / ".pi" / "imessage-cleanup"
REPORT_DIR = WORK_DIR / "reports"
CONFIG_PATH = WORK_DIR / "config.json"

FDA_HINT = """\
读取 chat.db 被系统拒绝（TCC / 完全磁盘访问权限）。

请手动执行一次：
  1. 打开「系统设置」→「隐私与安全性」→「完全磁盘访问权限」
  2. 点左下角「+」，加入 /Applications/Ghostty.app（pi 是从 Ghostty 启动的，
     权限归属于终端 App，而不是 pi 本身）
  3. 确认右边的开关是打开状态
  4. **完全退出 Ghostty 再重新打开**（TCC 缓存要重启进程才生效）
  5. 回来重跑本脚本

注意：如果以后换用 iTerm2 / VS Code / Warp 启动 pi，需要单独给那个 App 授权。
"""


# --------------------------------------------------------------------------
# 时间 / 文本解码
# --------------------------------------------------------------------------


def apple_ts(value) -> datetime | None:
    """把 Apple 纪元时间戳（可能是 ns/us/ms/s）转成本地 datetime。"""
    if not value:
        return None
    v = int(value)
    if v >= 10**17:
        seconds = v / 1e9
    elif v >= 10**14:
        seconds = v / 1e6
    elif v >= 10**11:
        seconds = v / 1e3
    else:
        seconds = float(v)
    try:
        return datetime.fromtimestamp(APPLE_EPOCH_OFFSET + seconds)
    except (OverflowError, OSError, ValueError):
        return None


def _read_len(buf: bytes, pos: int):
    """typedstream 的长度前缀：0x81=2字节LE，0x82=4字节LE，否则单字节。"""
    if pos >= len(buf):
        return None, pos
    b = buf[pos]
    if b == 0x81:
        if pos + 3 > len(buf):
            return None, pos
        return int.from_bytes(buf[pos + 1 : pos + 3], "little"), pos + 3
    if b == 0x82:
        if pos + 5 > len(buf):
            return None, pos
        return int.from_bytes(buf[pos + 1 : pos + 5], "little"), pos + 5
    return b, pos + 1


def _printable_ratio(text: str) -> float:
    if not text:
        return 0.0
    bad = sum(1 for ch in text if ch == "\ufffd" or (ord(ch) < 32 and ch not in "\n\r\t"))
    return 1.0 - bad / len(text)


_AB_MARKERS = (
    b"NSString\x01\x94\x84\x01\x2b",
    b"NSString\x01\x94\x84\x01\x4f",
    b"NSString\x01\x94\x84\x01\x49",
)


def decode_attributed_body(blob) -> str | None:
    """
    解码 NSAttributedString typedstream，取出正文。

    现代 macOS 上 message.text 经常是 NULL，正文只存在于 attributedBody。
    分两级：先试已知的 NSString 类型标记，失败再在 NSString 之后扫描合理的长度前缀。
    """
    if not blob:
        return None
    if isinstance(blob, str):
        blob = blob.encode("utf-8", "replace")
    if not isinstance(blob, (bytes, bytearray)):
        return None
    buf = bytes(blob)

    def try_at(pos: int) -> str | None:
        length, start = _read_len(buf, pos)
        if not length or length <= 0 or start + length > len(buf):
            return None
        try:
            text = buf[start : start + length].decode("utf-8")
        except UnicodeDecodeError:
            return None
        if _printable_ratio(text) >= 0.8 and text.strip():
            return text
        return None

    for marker in _AB_MARKERS:
        idx = buf.find(marker)
        if idx != -1:
            got = try_at(idx + len(marker))
            if got:
                return got

    idx = buf.find(b"NSString")
    if idx != -1:
        # 类型标记有几种长度变体，向后扫一小段找第一个合法的长度前缀
        for pos in range(idx + 8, min(idx + 24, len(buf))):
            got = try_at(pos)
            if got:
                return got
    return None


# --------------------------------------------------------------------------
# 数据库读取（全部只读）
# --------------------------------------------------------------------------


class ChatDBError(RuntimeError):
    pass


def snapshot_db(src: Path, workdir: Path) -> Path:
    """把 chat.db 连同 WAL/SHM 拷到临时目录。原始文件只读、永不修改。"""
    if not src.exists():
        raise ChatDBError(f"找不到 {src}")
    dst = workdir / "chat.db"
    try:
        shutil.copy2(src, dst)
    except PermissionError as exc:
        raise ChatDBError(str(exc)) from exc
    for suffix in ("-wal", "-shm"):
        side = Path(str(src) + suffix)
        if side.exists():
            try:
                shutil.copy2(side, Path(str(dst) + suffix))
            except (PermissionError, OSError):
                pass
    return dst


def connect_ro(path: Path) -> sqlite3.Connection:
    """打开快照副本，并强制只读。副本是临时文件，关闭后即删除。"""
    con = sqlite3.connect(str(path))
    con.execute("PRAGMA query_only = 1")
    return con


def table_columns(con: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = con.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.DatabaseError:
        return set()
    return {r[1] for r in rows}


def table_exists(con: sqlite3.Connection, table: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


# --------------------------------------------------------------------------
# 分类规则
# --------------------------------------------------------------------------

RE_VERIFY = re.compile(
    r"(验证码|校验码|动态码|动态密码|短信密码|一次性密码|安全码|verification\s*code|"
    r"one[\s-]*time\s*(password|code)|\bOTP\b|\bcode\b)",
    re.I,
)
RE_DIGITS = re.compile(r"(?<!\d)(\d{4,8})(?!\d)")
RE_MARKETING = re.compile(
    r"(退订|回T退订|拒收请|优惠|促销|特价|限时|秒杀|抢购|领取|免费领|福利|礼包|"
    r"抽奖|中奖|恭喜|贷款|借款|额度|免息|分期|放款|首付|低息|办卡|开户|"
    r"加微信|加V|点击链接|下载APP|注册送|返现|红包|折扣|会员|尊享|"
    r"unsubscribe|promo|deal|discount|offer|limited time)",
    re.I,
)
# 强营销信号：出现任何一个就基本可以确定是推广（政务/银行通知里几乎不会出现）
RE_MARKETING_STRONG = re.compile(
    r"(优惠|促销|特价|限时|秒杀|抢购|免费领|礼包|抽奖|中奖|恭喜|"
    r"贷款|借款|免息|分期|放款|首付|低息|办卡|加微信|加V|"
    r"注册送|返现|红包|折扣|尊享|limited time|discount)",
    re.I,
)
# 弱营销信号：机构通知也常带，单独出现不足以判定为推广
RE_MARKETING_WEAK = re.compile(r"(退订|回T退订|拒收请|领取|会员|点击链接|下载APP|unsubscribe)", re.I)
RE_LOGISTICS = re.compile(r"(快递|取件|取货|驿站|菜鸟|丰巢|包裹|派送|签收|顺丰|京东物流|运单)")
RE_BANK = re.compile(
    r"(银行|信用卡|储蓄卡|账户|余额|交易|消费|入账|出账|扣款|还款|账单|逾期|"
    r"验证|密码|医保|社保|公积金|税务|发票)"
)
RE_OPERATOR = re.compile(r"(流量|话费|套餐|欠费|停机|积分|移动|联通|电信|宽带)")
RE_GOV = re.compile(r"(交警|公安|法院|政务|街道|社区|居委会|防疫|疾控|不动产|出入境)")
def normalize_handle(text: str) -> str:
    return re.sub(r"[\s()\-]", "", text or "")


def is_mobile_like(handle: str) -> bool:
    """中国大陆手机号，或 +1 北美号码。"""
    h = normalize_handle(handle)
    digits = h.lstrip("+")
    if digits.startswith("86"):
        digits = digits[2:]
    if re.fullmatch(r"1[3-9]\d{9}", digits):
        return True
    if h.startswith("+1") and len(h) == 12:
        return True
    return False


def service_sender(handle: str) -> str | None:
    """
    识别「服务端口号」——机构群发通道，不可能是私人对话。

    覆盖中国常见形态：106 短信端口、95xxx 银行客服、100xx 运营商、
    123xx 政务、400/800 企业客服，以及 5-8 位的普通短号（含北美 short code）。
    返回归一化后的通道类型，不是服务端口则返回 None。
    """
    h = normalize_handle(handle)
    if "@" in h:
        return None
    digits = h.lstrip("+")
    if not digits.isdigit():
        return None
    if digits.startswith("106") and 11 <= len(digits) <= 13:
        return "106短信端口"
    if re.fullmatch(r"9[56]\d{3}", digits):
        return "银行/客服短号"
    if re.fullmatch(r"100\d{2,3}", digits):
        return "运营商短号"
    if re.fullmatch(r"123\d{1,2}", digits):
        return "政务服务短号"
    if re.fullmatch(r"[48]00\d{6,7}", digits):
        return "企业客服热线"
    if 5 <= len(digits) <= 6 and not digits.startswith("0"):
        return "短号"
    return None


# --------------------------------------------------------------------------
# 数据结构
# --------------------------------------------------------------------------


@dataclass
class ChatStats:
    chat_id: int
    handle: str
    display_name: str
    service: str
    is_group: bool
    msg_count: int = 0
    outgoing: int = 0
    incoming: int = 0
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    attachments: int = 0
    in_recently_deleted: bool = False
    samples: list[str] = field(default_factory=list)
    all_text: list[str] = field(default_factory=list)

    @property
    def one_way(self) -> bool:
        return self.outgoing == 0 and self.incoming > 0


@dataclass
class Classification:
    bucket: str
    label: str
    reasons: list[str]
    cleanup_score: int
    suggestion: str


BUCKET_LABELS = {
    "verify_code": "验证码",
    "marketing": "营销推广",
    "service_notice": "服务通知",
    "person": "真人对话",
    "group": "群聊",
    "unknown": "未分类",
    "keep": "白名单保留",
}


def classify(stats: ChatStats, cfg: dict) -> Classification:
    handle = stats.handle
    norm = normalize_handle(handle)
    reasons: list[str] = []
    joined = "\n".join(stats.all_text)

    # --- 先算内容特征，白名单也需要用它们做“冲突提醒” ---
    has_verify = bool(RE_VERIFY.search(joined))
    has_digits = bool(RE_DIGITS.search(joined))
    marketing_hits = RE_MARKETING.findall(joined)
    strong_hits = RE_MARKETING_STRONG.findall(joined)
    weak_hits = RE_MARKETING_WEAK.findall(joined)
    logistics = bool(RE_LOGISTICS.search(joined))
    bank = bool(RE_BANK.search(joined))
    operator = bool(RE_OPERATOR.search(joined))
    gov = bool(RE_GOV.search(joined))

    # --- 白名单优先，一票保留。但内容可疑时把冲突显式写出来，
    #     因为“真人手机号发营销”确实存在，需要人工判断。 ---
    whitelist_hit: str | None = None
    for exact in cfg.get("keep_exact", []):
        if norm == normalize_handle(str(exact)):
            whitelist_hit = f"白名单精确匹配：{exact}"
            break
    if whitelist_hit is None:
        for pattern in cfg.get("keep_regex", []):
            try:
                if re.search(pattern, handle) or re.search(pattern, norm):
                    whitelist_hit = f"白名单正则匹配：{pattern}"
                    break
            except re.error:
                continue
    if whitelist_hit:
        reasons.append(whitelist_hit)
        if marketing_hits:
            reasons.append(
                "⚠ 但内容疑似营销（"
                + "、".join(sorted(set(marketing_hits))[:3])
                + "），请人工确认"
            )
        elif has_verify and has_digits:
            reasons.append("⚠ 内容含验证码，确认不是常用服务后再清理")
        return Classification("keep", BUCKET_LABELS["keep"], reasons, 0, "保留")

    if stats.is_group:
        return Classification(
            "group",
            BUCKET_LABELS["group"],
            [f"群聊，{stats.msg_count} 条消息，{stats.outgoing} 条来自你"],
            10,
            "人工查看",
        )

    if has_verify and has_digits:
        reasons.append("含验证码关键词 + 4-8 位数字")
        if stats.one_way:
            reasons.append("单向消息（你从未回复）")
        return Classification(
            "verify_code",
            BUCKET_LABELS["verify_code"],
            reasons,
            90 if stats.one_way else 80,
            "可清理（建议保留最近 7 天）",
        )

    # 强营销信号，或弱信号堆叠（≥3 处）→ 推广。只看弱信号不算，
    # 否则「交管部门...回T退订」这类政务通知会被误判成营销。
    if strong_hits or len(marketing_hits) >= 3:
        reasons.append(
            f"营销关键词 {len(marketing_hits)} 处："
            + "、".join(sorted(set(marketing_hits))[:5])
        )
        if stats.one_way:
            reasons.append("单向消息（你从未回复）")
        score = 60 + min(len(marketing_hits), 4) * 8 + (15 if stats.one_way else 0)
        return Classification(
            "marketing", BUCKET_LABELS["marketing"], reasons, min(score, 95), "可清理"
        )

    channel = service_sender(handle)
    if channel or gov or logistics or bank or operator or weak_hits:
        kind = [channel] if channel else []
        if gov:
            kind.append("政务")
        if logistics:
            kind.append("快递物流")
        if bank:
            kind.append("银行金融")
        if operator:
            kind.append("运营商")
        reasons.append("来源为服务端口：" + "/".join(k for k in kind if k))
        if weak_hits:
            reasons.append("含退订字样（机构通知常见，未判定为推广）")
        if stats.one_way:
            reasons.append("单向消息（你从未回复）")
        return Classification(
            "service_notice",
            BUCKET_LABELS["service_notice"],
            reasons,
            70 if stats.one_way else 40,
            "可清理（建议保留最近 30 天）",
        )

    # 只有弱营销信号、又不属于任何服务端口 → 存疑，降分后归入推广
    if weak_hits:
        reasons.append("仅含弱推广信号：" + "、".join(sorted(set(weak_hits))))
        return Classification(
            "marketing", BUCKET_LABELS["marketing"], reasons, 45, "人工查看"
        )

    # --- 真人判定 ---
    if "@" in handle:
        reasons.append("iMessage 邮箱标识（不是端口群发）")
        human = True
    elif is_mobile_like(handle):
        reasons.append("来源为普通手机号")
        human = True
    else:
        human = False

    if human:
        if stats.outgoing > 0:
            reasons.append(f"有 {stats.outgoing} 条你发出的消息（双向对话）")
            return Classification("person", BUCKET_LABELS["person"], reasons, 0, "保留")
        reasons.append("对方发来但你从未回复")
        return Classification(
            "person",
            BUCKET_LABELS["person"],
            reasons,
            35,
            "人工查看（号码是真人，但从未回过）",
        )

    reasons.append("未命中任何规则")
    return Classification("unknown", BUCKET_LABELS["unknown"], reasons, 20, "人工查看")


DEFAULT_CONFIG = {
    "_comment": "keep_exact / keep_regex 命中即强制保留，优先于所有分类规则。",
    "keep_exact": [],
    "keep_regex": [
        r"^\+86\d{11}$",
        r"^\+1\d{10}$",
        r"^\+44\d{10}$",
        r"^\+81\d{10,11}$",
    ],
}


def load_config(path: Path) -> dict:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(DEFAULT_CONFIG, ensure_ascii=False, indent=2), "utf-8")
        return dict(DEFAULT_CONFIG)
    try:
        cfg = json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_CONFIG)
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg or {})
    return merged


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------


def scan(con: sqlite3.Connection, max_per_chat: int = 400) -> list[ChatStats]:
    cols_msg = table_columns(con, "message")
    if not cols_msg:
        raise ChatDBError("chat.db 里没有 message 表，schema 可能已变化")

    # (读取用的键, SQL 表达式)。注意键名必须和下面 rec.get() 用的一致，
    # 不能直接拿 SQL 列名当键——曾经因为 "m.text" != "text" 导致正文全部读空。
    fields: list[tuple[str, str]] = [
        ("message_id", "cmj.message_id"),
        ("is_from_me", "m.is_from_me" if "is_from_me" in cols_msg else "0"),
    ]
    if "date" in cols_msg:
        fields.append(("date", "m.date"))
    if "text" in cols_msg:
        fields.append(("text", "m.text"))
    if "attributedBody" in cols_msg:
        fields.append(("attributed_body", "m.attributedBody"))
    if "cache_has_attachments" in cols_msg:
        fields.append(("has_attachment", "m.cache_has_attachments"))
    if "associated_message_type" in cols_msg:
        fields.append(("assoc_type", "m.associated_message_type"))

    has_ab = "attributedBody" in cols_msg
    has_date = "date" in cols_msg

    recent_ids: set[int] = set()
    if table_exists(con, "chat_recoverable_message_join"):
        recent_ids = {
            r[0]
            for r in con.execute(
                "SELECT DISTINCT chat_id FROM chat_recoverable_message_join"
            ).fetchall()
        }

    chats = con.execute(
        """
        SELECT c.ROWID,
               COALESCE(c.chat_identifier, ''),
               COALESCE(c.display_name, ''),
               COALESCE(c.service_name, ''),
               COALESCE(c.style, 0),
               COALESCE(c.room_name, ''),
               COALESCE(c.display_name, '')
        FROM chat c
        """
    ).fetchall()

    stats: list[ChatStats] = []
    for rowid, identifier, display_name, service, style, room_name, _ in chats:
        st = ChatStats(
            chat_id=rowid,
            handle=identifier or room_name or f"chat-{rowid}",
            display_name=display_name or "",
            service=service or "",
            is_group=bool(style == 43 or room_name),
            in_recently_deleted=rowid in recent_ids,
        )

        sql = f"""
            SELECT {", ".join(expr for _, expr in fields)}
            FROM chat_message_join cmj
            JOIN message m ON m.ROWID = cmj.message_id
            WHERE cmj.chat_id = ?
            ORDER BY m.ROWID DESC
        """
        try:
            rows = con.execute(sql, (rowid,)).fetchall()
        except sqlite3.DatabaseError:
            continue

        for r in rows:
            rec = {key: r[i] for i, (key, _) in enumerate(fields)}
            if rec.get("assoc_type"):
                # tapback / 表情回应，不是正文，跳过统计
                continue
            st.msg_count += 1
            if rec.get("is_from_me"):
                st.outgoing += 1
            else:
                st.incoming += 1
            if rec.get("has_attachment"):
                st.attachments += 1
            ts = apple_ts(rec.get("date")) if has_date else None
            if ts:
                if st.first_ts is None or ts < st.first_ts:
                    st.first_ts = ts
                if st.last_ts is None or ts > st.last_ts:
                    st.last_ts = ts

            if len(st.all_text) < max_per_chat:
                text = (rec.get("text") or "").strip()
                if not text and has_ab:
                    text = (decode_attributed_body(rec.get("attributed_body")) or "").strip()
                if text:
                    text = text.replace("\n", " ").strip()
                    if text and len(st.samples) < 3 and text not in st.samples:
                        st.samples.append(text[:160])
                    st.all_text.append(text[:600])

        stats.append(st)

    return stats


def build_report(
    stats: list[ChatStats], classified: dict[int, Classification], source_db: Path
) -> str:
    active = [s for s in stats if not s.in_recently_deleted and s.msg_count > 0]
    deleted_pending = [s for s in stats if s.in_recently_deleted and s.msg_count > 0]

    by_bucket: dict[str, list[ChatStats]] = defaultdict(list)
    for s in active:
        by_bucket[classified[s.chat_id].bucket].append(s)

    total_msgs = sum(s.msg_count for s in active)
    spans = [s.last_ts for s in active if s.last_ts]
    span_txt = "-"
    if spans:
        span_txt = f"{min(s.first_ts for s in active if s.first_ts):%Y-%m-%d} ~ {max(spans):%Y-%m-%d}"

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    out: list[str] = []
    out.append("# iMessage / 短信 只读扫描报告")
    out.append("")
    is_real = source_db == DEFAULT_DB
    out.append(f"生成时间：{now}")
    out.append("")
    out.append("> **本报告为只读分析结果，不包含也不触发任何删除操作。**")
    if is_real:
        out.append("> 数据来源：`~/Library/Messages/chat.db` 的临时快照副本，原始数据库从未被写入。")
    else:
        out.append(f"> 数据来源：`{source_db}` 的临时快照副本。")
        out.append(">")
        out.append("> ⚠️ **这不是真实数据库**（非默认路径）。报告内容仅供测试验证，不代表真实短信。")
    out.append("")
    out.append("## 概览")
    out.append("")
    out.append("| 指标 | 值 |")
    out.append("|---|---|")
    out.append(f"| 活跃会话数 | {len(active)} |")
    out.append(f"| 消息总数 | {total_msgs} |")
    out.append(f"| 时间跨度 | {span_txt} |")
    out.append(f"| 「最近删除」中的会话 | {len(deleted_pending)} |")
    out.append("")

    out.append("| 分类 | 会话数 | 消息数 |")
    out.append("|---|---|---|")
    order = ["verify_code", "marketing", "service_notice", "unknown", "person", "group", "keep"]
    for bucket in order:
        items = by_bucket.get(bucket)
        if not items:
            continue
        out.append(
            f"| {BUCKET_LABELS.get(bucket, bucket)} | {len(items)} | {sum(i.msg_count for i in items)} |"
        )
    out.append("")

    out.append("## 明细")
    out.append("")
    for bucket in order:
        items = by_bucket.get(bucket)
        if not items:
            continue
        items.sort(key=lambda s: (-classified[s.chat_id].cleanup_score, -s.msg_count))
        out.append(f"### {BUCKET_LABELS.get(bucket, bucket)}（{len(items)} 个会话）")
        out.append("")
        out.append(
            "| 会话 | 标识 | 类型 | 消息 | 你发出 | 最后活跃 | 清理分 | 判定理由 | 正文样例 |"
        )
        out.append("|---|---|---|---|---|---|---|---|---|")
        for s in items:
            cls = classified[s.chat_id]
            name = s.display_name or s.handle
            last = f"{s.last_ts:%Y-%m-%d}" if s.last_ts else "-"
            sample = (s.samples[0] if s.samples else "（无正文/仅附件）")
            if s.attachments:
                sample = f"[附件×{s.attachments}] " + sample
            sample = sample.replace("|", "\\|")
            if len(sample) > 70:
                sample = sample[:70] + "…"
            reasons = "；".join(cls.reasons).replace("|", "\\|")
            out.append(
                f"| {name} | `{s.handle}` | {s.service or '-'} | {s.msg_count} | "
                f"{s.outgoing} | {last} | {cls.cleanup_score} | {reasons} | {sample} |"
            )
        out.append("")

    if deleted_pending:
        out.append("## 已在「最近删除」中的会话")
        out.append("")
        out.append("| 会话 | 消息数 | 备注 |")
        out.append("|---|---|---|")
        for s in deleted_pending:
            out.append(f"| {s.display_name or s.handle} | {s.msg_count} | 30 天后会被永久清除 |")
        out.append("")

    out.append("## 说明")
    out.append("")
    out.append("- 「清理分」只是启发式打分，**不是删除建议**，数值越高代表越像可安全清理的内容。")
    out.append("- 判定完全基于规则（关键词 + 号码形态 + 是否单向），规则和理由都写在表格里，可逐条复核。")
    out.append("- 白名单命中会强制归入「白名单保留」。白名单在 "
               f"`{CONFIG_PATH}` 里配置。")
    out.append("- 下一步（尚未实现）若要真的删除，必须走 Messages.app 的 UI 自动化流程，"
               "让每次删除都经过系统确认弹窗并进入「最近删除」，30 天内可撤销。")
    out.append("")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="iMessage/SMS 只读扫描与分类（绝不修改数据）")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="chat.db 路径")
    ap.add_argument("--out-dir", type=Path, default=REPORT_DIR, help="报告输出目录")
    ap.add_argument("--config", type=Path, default=CONFIG_PATH, help="白名单配置")
    ap.add_argument("--json", action="store_true", help="只向 stdout 输出 JSON 摘要")
    ap.add_argument("--quiet", action="store_true", help="不打印进度")
    ap.add_argument("--top", type=int, default=15, help="JSON 摘要里每类返回的条数")
    args = ap.parse_args()

    def log(msg: str) -> None:
        if not args.quiet and not args.json:
            print(msg, file=sys.stderr)

    def fail(msg: str, hint: str | None = None, raw: str | None = None) -> int:
        if args.json:
            print(
                json.dumps(
                    {"ok": False, "error": msg, "hint": hint, "raw": raw},
                    ensure_ascii=False,
                )
            )
        else:
            print(f"错误：{msg}", file=sys.stderr)
            if raw and raw != msg:
                print(f"系统报错：{raw}", file=sys.stderr)
            if hint:
                print("\n" + hint, file=sys.stderr)
        return 1

    log(f"快照 {args.db} …")
    tmp = Path(tempfile.mkdtemp(prefix="imessage-cleanup-"))
    try:
        try:
            snap = snapshot_db(args.db, tmp)
        except ChatDBError as exc:
            msg = str(exc)
            if "authorization denied" in msg or "Operation not permitted" in msg or "Permission denied" in msg:
                return fail("读取 chat.db 被系统拒绝", FDA_HINT, raw=msg)
            return fail(msg)

        con = connect_ro(snap)
        try:
            log("扫描会话与消息 …")
            stats = scan(con)
        finally:
            con.close()

        cfg = load_config(args.config)
        classified = {s.chat_id: classify(s, cfg) for s in stats}

        report = build_report(stats, classified, args.db)

        args.out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        # 非默认数据库（测试夹具）加后缀并在子目录里隔离，避免和真实报告混在一起
        if args.db == DEFAULT_DB:
            slug = ""
            out_dir = args.out_dir
        else:
            slug = "-" + re.sub(r"[^A-Za-z0-9]+", "-", args.db.stem)[:20].strip("-")
            out_dir = args.out_dir / "non-default-db"
        out_dir.mkdir(parents=True, exist_ok=True)
        md_path = out_dir / f"report-{stamp}{slug}.md"
        json_path = out_dir / f"report-{stamp}{slug}.json"
        md_path.write_text(report, "utf-8")

        payload = {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "source_db": str(args.db),
            "readonly": True,
            "report_md": str(md_path),
            "report_json": str(json_path),
            "config": str(args.config),
            "buckets": {},
            "chats": [],
        }
        for s in sorted(stats, key=lambda x: (-classified[x.chat_id].cleanup_score, -x.msg_count)):
            cls = classified[s.chat_id]
            entry = {
                "chat_id": s.chat_id,
                "handle": s.handle,
                "name": s.display_name or s.handle,
                "service": s.service,
                "is_group": s.is_group,
                "msg_count": s.msg_count,
                "outgoing": s.outgoing,
                "one_way": s.one_way,
                "last_active": s.last_ts.strftime("%Y-%m-%d") if s.last_ts else None,
                "in_recently_deleted": s.in_recently_deleted,
                "bucket": cls.bucket,
                "label": cls.label,
                "cleanup_score": cls.cleanup_score,
                "reasons": cls.reasons,
                "samples": s.samples,
                "suggestion": cls.suggestion,
            }
            payload["chats"].append(entry)
            if s.in_recently_deleted:
                # 「最近删除」里的会话不计入分类统计（它们已经不在侧边栏里了）
                continue
            payload["buckets"].setdefault(cls.bucket, {"count": 0, "messages": 0})
            payload["buckets"][cls.bucket]["count"] += 1
            payload["buckets"][cls.bucket]["messages"] += s.msg_count

        active = [s for s in stats if not s.in_recently_deleted and s.msg_count > 0]
        recoverable = [s for s in stats if s.in_recently_deleted and s.msg_count > 0]
        payload["totals"] = {
            "chats": len(stats),
            "messages": sum(s.msg_count for s in stats),
            "active_chats": len(active),
            "active_messages": sum(s.msg_count for s in active),
            "recoverable_chats": len(recoverable),
        }
        json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")

        if args.json:
            payload["chats"] = payload["chats"][: args.top]
            print(json.dumps(payload, ensure_ascii=False))
        else:
            print(f"报告已生成：{md_path}")
            print(f"结构化数据：{json_path}")
            print(f"会话 {payload['totals']['chats']} 个 / 消息 {payload['totals']['messages']} 条")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
