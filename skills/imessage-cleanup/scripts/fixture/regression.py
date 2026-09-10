#!/usr/bin/env python3
"""
回归测试：用合成夹具库验证 scan.py 的分类与解析逻辑。

改分类规则（关键词、白名单、分档）之后跑一遍，确认没有把之前修好的
几个真实 bug 又改回去：
  - SQL 列名当 dict 键 -> 正文/时间/去程计数全读空
  - tapback（表情回应）被计入消息数
  - 政务通知因为含「回T退订」被误判为营销
  - attributedBody（typedstream）解不出正文

用法：python3 regression.py
退出码 0 = 全部通过。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCAN = HERE.parent / "scan.py"
MAKE = HERE / "make_test_db.py"

CHECKS = 0


def check(name: str, cond: bool, detail: object = "") -> None:
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name}  ->  {detail}")
        raise SystemExit(1)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="imessage-regression-") as tmp:
        db = Path(tmp) / "chat.db"
        subprocess.run([sys.executable, str(MAKE), str(db)], check=True, capture_output=True)

        proc = subprocess.run(
            [
                sys.executable, str(SCAN),
                "--db", str(db),
                "--json", "--quiet", "--top", "100",
                "--out-dir", str(Path(tmp) / "reports"),
            ],
            check=True, capture_output=True, text=True,
        )
        d = json.loads(proc.stdout)
        by_handle = {c["handle"]: c for c in d["chats"]}

    print("分类汇总")
    check("活跃会话 13 个", d["totals"]["active_chats"] == 13, d["totals"])
    check("活跃消息 22 条（tapback 已排除）", d["totals"]["active_messages"] == 22, d["totals"])
    check("最近删除会话 1 个", d["totals"]["recoverable_chats"] == 1, d["totals"])

    b = d["buckets"]
    check("验证码 1 个", b["verify_code"]["count"] == 1, b)
    check("营销推广 1 个", b["marketing"]["count"] == 1, b)
    check("服务通知 6 个", b["service_notice"]["count"] == 6, b)
    check("真人对话 2 个", b["person"]["count"] == 2, b)
    check("群聊 1 个", b["group"]["count"] == 1, b)
    check("白名单保留 2 个", b["keep"]["count"] == 2, b)

    print("分类规则")
    check(
        "政务短号 12381 含「回T退订」仍判为服务通知",
        by_handle["12381"]["bucket"] == "service_notice",
        by_handle["12381"],
    )
    check(
        "106 端口 + 强营销词判为营销",
        by_handle["1069000123456"]["bucket"] == "marketing",
        by_handle["1069000123456"],
    )
    check(
        "双向真人对话清理分为 0",
        by_handle["zhangwei@example.com"]["cleanup_score"] == 0,
        by_handle["zhangwei@example.com"],
    )
    check(
        "白名单冲突有 ⚠ 标记（手机号发营销）",
        any(r.startswith("⚠") for r in by_handle["+8618800138000"]["reasons"]),
        by_handle["+8618800138000"],
    )
    check(
        "白名单命中仍归入 keep",
        by_handle["+8618800138000"]["bucket"] == "keep",
        by_handle["+8618800138000"],
    )

    print("解析正确性（回归已修 bug）")
    check(
        "attributedBody 能解出正文（该行 text 为 NULL）",
        "验证码" in (by_handle["106903039400"]["samples"] or [""])[0],
        by_handle["106903039400"]["samples"],
    )
    check(
        "tapback 不计入消息数（该会话 3 条正文）",
        by_handle["+8613800138000"]["msg_count"] == 3,
        by_handle["+8613800138000"]["msg_count"],
    )
    check(
        "去程计数正确读出（双向会话 outgoing >= 1）",
        by_handle["+8613800138000"]["outgoing"] >= 1,
        by_handle["+8613800138000"],
    )
    check(
        "时间戳换算正确（有 last_active）",
        all(c["last_active"] for c in by_handle.values() if c["msg_count"]),
        {k: v["last_active"] for k, v in by_handle.items()},
    )

    print(f"\n全部 {CHECKS} 项断言通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
