---
name: imessage-cleanup
description: 只读扫描并分类 Mac 本地短信/iMessage 会话，生成清理候选报告。用于了解「哪些短信是无用的」（验证码、营销推广、服务通知），按规则给出可复核的判定理由。绝不做任何删除；需要终端拥有完全磁盘访问权限。
---

# imessage-cleanup（只读扫描）

## 这个 skill 做什么

扫描 `~/Library/Messages/chat.db` 的**临时快照副本**，把每个会话分类，生成 Markdown + JSON 报告：

| 分类 | 含义 | 清理分 |
|---|---|---|
| 验证码 | 含验证码关键词 + 4-8 位数字 | 80-90 |
| 营销推广 | 命中强营销关键词（优惠/限时/贷款/加微信…） | 45-95 |
| 服务通知 | 106 端口 / 95xxx 银行 / 100xx 运营商 / 123xx 政务 / 快递 | 40-70 |
| 未分类 | 未命中任何规则 | 20 |
| 真人对话 | 手机号或 iMessage 邮箱，且有来有往 | 0-35 |
| 群聊 | 多人会话 | 10 |
| 白名单保留 | 命中 `keep_exact` / `keep_regex` | 0 |

清理分只是**启发式排序**，不是删除建议。每条判定都附带理由，可逐条复核。

## 硬性约束（不要绕过）

1. **本 skill 只读。** 所有 SQL 都是 `SELECT`，且只作用于 `cp` 出来的快照副本；原始 `chat.db` 永不写入。
2. **不要自己写 SQL 去改 chat.db。** 直接改库会破坏 iCloud 同步、丢失 WeChat 之外的触发器一致性，且无法撤销。
3. **不要用 AppleScript 删消息。** Messages.app 的脚本字典里没有 `delete` 命令，也没有 `message` 类（已在 macOS 26 上验证），这条路不存在。
4. 报告里的内容包含真实手机号和短信正文，**不要外发、不要写进 commit**。

## 前置条件：完全磁盘访问权限

读取 `chat.db` 会被 TCC 拦截。授权一次：

1. 系统设置 → 隐私与安全性 → 完全磁盘访问权限
2. 点「+」加入运行 pi 的终端 App（当前是 `/Applications/Ghostty.app`）
3. 打开开关
4. **完全退出终端再重开**（TCC 缓存要重启进程才生效）

报错 `authorization denied` / `Operation not permitted` 就是这里没授权。`scan.py` 会直接打印这份指引。
权限归属于**终端 App**，不是 pi 本身——换终端（iTerm2 / VS Code / Warp）要重新授权。

## 用法

```bash
# 扫描真实数据库，生成报告到 ~/.pi/imessage-cleanup/reports/
python3 ~/.pi/agent/skills/imessage-cleanup/scripts/scan.py

# 只看摘要（JSON，供扩展调用）
python3 ~/.pi/agent/skills/imessage-cleanup/scripts/scan.py --json --quiet --top 10

# 扫一个指定的库（用于测试）
python3 ~/.pi/agent/skills/imessage-cleanup/scripts/scan.py --db /path/to/chat.db
```

在 pi 里直接用 `sms_scan` 工具，或 `/sms-scan` 命令。

### 没有完全磁盘访问权限时怎么验证代码可用

用合成夹具库跑一遍完整链路（不碰真实数据）：

```bash
python3 ~/.pi/agent/skills/imessage-cleanup/scripts/fixture/make_test_db.py /tmp/imessage-fixture/chat.db
python3 ~/.pi/agent/skills/imessage-cleanup/scripts/scan.py --db /tmp/imessage-fixture/chat.db
```

夹具覆盖了真实 schema（含 `attributedBody` typedstream、tapback 表情回应、近删除表），
可以用来回归验证分类规则改动。

改过分类规则后跑回归（18 项断言，退出码 0 = 全过）：

```bash
python3 ~/.pi/agent/skills/imessage-cleanup/scripts/fixture/regression.py
```

## 白名单配置

`~/.pi/imessage-cleanup/config.json`（首次运行自动生成）：

```json
{
  "keep_exact": ["10086", "+8613800138000"],
  "keep_regex": ["^\\+86\\d{11}$", "^\\+1\\d{10}$"]
}
```

白名单**一票保留**，优先于所有分类规则。默认把 `+86` 手机号全部保留，
因为在中国的垃圾短信主要来自 `106` 端口而不是普通手机号。
如果白名单命中的会话内容疑似营销，报告里会打 `⚠` 标记出来供人工判断，但仍不改变「保留」结论。

## 报告在哪

- Markdown：`~/.pi/imessage-cleanup/reports/report-<时间戳>.md`
- JSON：同目录同名 `.json`

## 实现要点（改代码前读）

- **时间戳**：Apple 纪元，2001-01-01 起的**纳秒**。
- **`message.text` 经常是 NULL**，正文在 `attributedBody` 的 typedstream blob 里，
  需要按 `NSString\x01\x94\x84\x01\x2b` 标记 + 长度前缀解码。`scan.py` 的 `decode_attributed_body()` 负责这事。
- **tapback（表情回应）是独立 message 行**，`associated_message_type != 0`，必须跳过，否则计数和正文会被污染。
- **必须拷贝 WAL/SHM** 再读，否则主库可能是过期快照。
- 会话表里读列名时注意：SQL 表达式（`m.text`）不能直接当 dict 键用，读取时要用短键名
  （曾经因为这个 bug 导致正文、时间、去程计数全部读空）。
- 「最近删除」在 `chat_recoverable_message_join` 里，不是一个状态字段；已被删除的会话**仍然留在 `chat` 表**。

## 不在本 skill 范围内

**删除。** 本 skill 没有任何删除能力，也没实现删除步骤。

如果之后要加删除，正确的做法只有一条：用 UI 自动化驱动 Messages.app 的
`对话 → 删除对话…` 菜单，让每次删除都经过系统确认弹窗并进入
`显示 → 最近删除`（30 天内可撤销）。**不要**直接对 `chat.db` 执行 DELETE。
参考实现：https://github.com/junhey/imessage-spam-cleanup （MIT）。

另一个方向：系统自带的两项设置能覆盖一部分需求，值得先试——
验证码「使用后删除」（系统设置 → 通用 → 自动填充与密码）和信息保留期限
（信息 → 设置 → 通用 → 保留信息）。
