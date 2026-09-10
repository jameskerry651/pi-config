#!/usr/bin/env python3
"""
测试夹具：生成一个结构逼真的 chat.db，用来在没有完全磁盘访问权限时验证 scan.py。

这个库是合成的假数据，放在临时目录里，不含任何真实短信。
生成后用 `scan.py --db <fixture>` 跑一遍，可以完整验证：
  - schema 探测（缺失列时的降级路径）
  - attributedBody（typedstream）解码
  - Apple 纳秒时间戳换算
  - 分类规则与报告渲染

用法：
  python3 make_test_db.py [输出路径]     # 默认 /tmp/imessage-fixture/chat.db
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

SCHEMA = """
CREATE TABLE chat (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    style INTEGER DEFAULT 45,
    state INTEGER DEFAULT 3,
    account_id TEXT,
    properties INTEGER,
    chat_identifier TEXT,
    service_name TEXT,
    room_name TEXT,
    display_name TEXT,
    is_archived INTEGER DEFAULT 0,
    is_filtered INTEGER DEFAULT 0
);
CREATE TABLE handle (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    country TEXT,
    service TEXT,
    uncanonicalized_id TEXT
);
CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    text TEXT,
    replace INTEGER DEFAULT 0,
    service_center TEXT,
    handle_id INTEGER DEFAULT 0,
    subject TEXT,
    country TEXT,
    attributedBody BLOB,
    version INTEGER DEFAULT 0,
    type INTEGER DEFAULT 0,
    service TEXT,
    account TEXT,
    account_guid TEXT,
    error INTEGER DEFAULT 0,
    date INTEGER DEFAULT 0,
    date_read INTEGER DEFAULT 0,
    date_delivered INTEGER DEFAULT 0,
    is_delivered INTEGER DEFAULT 0,
    is_finished INTEGER DEFAULT 0,
    is_emote INTEGER DEFAULT 0,
    is_from_me INTEGER DEFAULT 0,
    is_empty INTEGER DEFAULT 0,
    is_delayed INTEGER DEFAULT 0,
    is_auto_reply INTEGER DEFAULT 0,
    is_prepared INTEGER DEFAULT 0,
    is_read INTEGER DEFAULT 0,
    is_system_message INTEGER DEFAULT 0,
    is_sent INTEGER DEFAULT 0,
    has_dd_results INTEGER DEFAULT 1,
    is_service_message INTEGER DEFAULT 0,
    is_forward INTEGER DEFAULT 0,
    was_downgraded INTEGER DEFAULT 0,
    is_archive INTEGER DEFAULT 0,
    cache_has_attachments INTEGER DEFAULT 0,
    cache_roomnames TEXT,
    was_data_detected INTEGER DEFAULT 0,
    was_deduplicated INTEGER DEFAULT 0,
    is_audio_message INTEGER DEFAULT 0,
    is_played INTEGER DEFAULT 0,
    date_played INTEGER DEFAULT 0,
    item_type INTEGER DEFAULT 0,
    other_handle INTEGER DEFAULT 0,
    group_title TEXT,
    group_action_type INTEGER DEFAULT 0,
    share_status INTEGER DEFAULT 0,
    share_direction INTEGER DEFAULT 0,
    is_expirable INTEGER DEFAULT 0,
    expire_state INTEGER DEFAULT 0,
    message_action_type INTEGER DEFAULT 0,
    message_source INTEGER DEFAULT 0,
    associated_message_guid TEXT,
    associated_message_type INTEGER DEFAULT 0,
    balloon_bundle_id TEXT,
    payload_data BLOB,
    expressive_send_style_id TEXT,
    associated_message_range_location INTEGER DEFAULT 0,
    associated_message_range_length INTEGER DEFAULT 0,
    time_expressive_send_played INTEGER DEFAULT 0,
    message_summary_info BLOB,
    ck_sync_state INTEGER DEFAULT 0,
    ck_record_id TEXT,
    ck_record_change_tag TEXT,
    destination_caller_id TEXT,
    sr_ck_sync_state INTEGER DEFAULT 0,
    sr_ck_record_id TEXT,
    sr_ck_record_change_tag TEXT,
    is_corrupt INTEGER DEFAULT 0,
    reply_to_guid TEXT,
    sort_id INTEGER DEFAULT 0,
    is_spam INTEGER DEFAULT 0,
    has_unseen_mention INTEGER DEFAULT 0,
    thread_originator_guid TEXT,
    thread_originator_part TEXT,
    syndication_ranges TEXT,
    was_delivered_quietly INTEGER DEFAULT 0,
    did_notify_recipient INTEGER DEFAULT 0,
    synced_syndication_ranges TEXT,
    date_retracted INTEGER DEFAULT 0,
    date_edited INTEGER DEFAULT 0,
    part_count INTEGER DEFAULT 0,
    is_stewie INTEGER DEFAULT 0,
    is_kt_verified INTEGER DEFAULT 0,
    is_sos INTEGER DEFAULT 0,
    is_critical INTEGER DEFAULT 0,
    ck_sync_state_override INTEGER DEFAULT 0,
    ck_distinguished_guid INTEGER DEFAULT 0,
    is_gauged_by_filtering INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (
    chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
    message_date INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE chat_handle_join (
    chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, handle_id)
);
CREATE TABLE attachment (
    ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE NOT NULL,
    created_date INTEGER DEFAULT 0,
    start_date INTEGER DEFAULT 0,
    filename TEXT,
    uti TEXT,
    mime_type TEXT,
    transfer_state INTEGER DEFAULT 0,
    is_outgoing INTEGER DEFAULT 0,
    user_info BLOB,
    transfer_name TEXT,
    total_bytes INTEGER DEFAULT 0,
    is_sticker INTEGER DEFAULT 0,
    hide_attachment INTEGER DEFAULT 0
);
CREATE TABLE message_attachment_join (
    message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
    attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE,
    PRIMARY KEY (message_id, attachment_id)
);
CREATE TABLE chat_recoverable_message_join (
    chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
    message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
    delete_date INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, message_id)
);
"""


def ts(dt: datetime) -> int:
    """datetime -> Apple 纳秒时间戳"""
    delta = dt.astimezone(timezone.utc) - APPLE_EPOCH
    return int(delta.total_seconds() * 1_000_000_000)


def typedstream(text: str) -> bytes:
    """构造一个和 macOS 真实结构一致的 NSAttributedString typedstream。"""
    body = text.encode("utf-8")
    out = bytearray(
        b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString"
        b"\x00\x84\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString"
        b"\x01\x94\x84\x01\x2b"
    )
    if len(body) < 0x80:
        out.append(len(body))
    else:
        out.append(0x81)
        out += len(body).to_bytes(2, "little")
    out += body
    out += b"\x86\x84\x02iI\x01\x92\x84\x84\x84\x0cNSDictionary\x00\x84\x84\x08NSObject\x00"
    return bytes(out)


# (标识, 显示名, service, style, [(正文, 是否我发的, 距今天数, 用attributedBody)])
FIXTURE = [
    (
        "1069000123456", "", "SMS", 45,
        [
            ("【某商城】双11限时秒杀，全场5折起，点击链接领取优惠券，回T退订", False, 3, True),
            ("【某商城】尊敬的用户，您的专属优惠券即将过期，快来领取", False, 9, True),
        ],
    ),
    (
        "95588", "", "SMS", 45,
        [("【工商银行】您尾号1234的账户于今日入账1000.00元，余额5000.00元", False, 1, False)],
    ),
    (
        "106903039400", "", "SMS", 45,
        [("【某某科技】验证码 384712，5分钟内有效。请勿泄露给他人。", False, 0, True)],
    ),
    (
        "10086", "", "SMS", 45,
        [("【中国移动】您本月流量已使用80%，剩余2GB，详情请登录App查看", False, 5, False)],
    ),
    (
        "95543", "", "SMS", 45,
        [("【顺丰速运】您的快递已到菜鸟驿站，取件码 6-2-3041，请及时取件", False, 2, False)],
    ),
    (
        "12381", "", "SMS", 45,
        [("【交管部门】您的机动车检验有效期临近，请及时办理，回T退订", False, 20, False)],
    ),
    (
        "+8613800138000", "", "iMessage", 45,
        [
            ("晚上一起吃饭吗", False, 1, True),
            ("可以啊，几点", True, 1, True),
            ("七点，老地方", False, 1, True),
        ],
    ),
    (
        "zhangwei@example.com", "张伟", "iMessage", 45,
        [
            ("文件发你邮箱了", False, 6, False),
            ("收到，我看一下", True, 6, False),
        ],
    ),
    (
        "13900139000", "李娜", "iMessage", 45,
        [
            ("好久不见，最近怎么样", False, 40, False),
            ("挺好的，你呢", True, 40, False),
        ],
    ),
    (
        "+8618800138000", "", "SMS", 45,
        [
            ("【某某教育】儿童编程体验课免费领取，加微信预约，回T退订", False, 4, False),
            ("【某某教育】限时特惠，报名立减800元", False, 15, False),
            ("【某某教育】您好，请问还有兴趣吗", False, 12, False),
        ],
    ),
    (
        "chat00000000000000000000000000000001", "家人群", "iMessage", 43,
        [
            ("周末回不回来吃饭", False, 2, True),
            ("回", True, 2, True),
            ("好，等你", False, 2, True),
        ],
    ),
    (
        "59239", "", "SMS", 45,
        [("您在某某平台的订单已发货，运单号 SF1234567890", False, 8, False)],
    ),
    (
        "1065500000001", "", "SMS", 45,
        [("【某银行】您的信用卡账单已出，本期应还5200元，最低还款520元", False, 7, True)],
    ),
    # 已在「最近删除」中的会话
    (
        "1069999999999", "", "SMS", 45,
        [("【某平台】邀请您参与问卷调查，完成可得红包", False, 11, False)],
    ),
]

RECOVERABLE = {"1069999999999"}
GROUPS = {"chat00000000000000000000000000000001"}


def build(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    for suffix in ("-wal", "-shm"):
        side = Path(str(target) + suffix)
        if side.exists():
            side.unlink()

    con = sqlite3.connect(str(target))
    con.executescript(SCHEMA)

    now = datetime.now().astimezone()
    mid = 0
    for identifier, display_name, service, style, messages in FIXTURE:
        handle_col = None
        if "@" in identifier or not identifier.startswith("chat"):
            cur = con.execute(
                "INSERT INTO handle (id, country, service) VALUES (?,?,?)",
                (identifier, "US", service),
            )
            handle_col = cur.lastrowid

        room = identifier if identifier.startswith("chat") else None
        cur = con.execute(
            """INSERT INTO chat (guid, style, chat_identifier, service_name, room_name, display_name)
               VALUES (?,?,?,?,?,?)""",
            (
                f"iMessage;-;{identifier}",
                43 if style == 43 else 45,
                None if room else identifier,
                service,
                room,
                display_name or None,
            ),
        )
        chat_id = cur.lastrowid
        if handle_col:
            con.execute(
                "INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?,?)",
                (chat_id, handle_col),
            )

        for text, from_me, days_ago, use_ab in messages:
            mid += 1
            when = ts(now - timedelta(days=days_ago, hours=mid % 12))
            con.execute(
                """INSERT INTO message
                   (guid, text, handle_id, service, date, is_from_me, attributedBody, cache_has_attachments)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    f"msg-guid-{mid:04d}",
                    None if use_ab else text,
                    handle_col or 0,
                    service,
                    when,
                    1 if from_me else 0,
                    typedstream(text) if use_ab else None,
                    1 if mid % 9 == 0 else 0,
                ),
            )
            con.execute(
                "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?,?,?)",
                (chat_id, mid, when),
            )
            if identifier in RECOVERABLE:
                con.execute(
                    "INSERT INTO chat_recoverable_message_join (chat_id, message_id, delete_date) VALUES (?,?,?)",
                    (chat_id, mid, when),
                )

    # 一条 tapback 表情回应，验证会被统计逻辑跳过
    con.execute(
        """INSERT INTO message (guid, text, service, date, is_from_me, associated_message_type)
           VALUES ('msg-guid-tapback', 'Liked “可以啊，几点”', 'iMessage', ?, 0, 2000)""",
        (ts(now - timedelta(days=1)),),
    )
    con.execute(
        "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (7, ?, ?)",
        (mid + 1, ts(now - timedelta(days=1))),
    )

    con.commit()
    con.close()
    return target


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/imessage-fixture/chat.db")
    print(build(out))
