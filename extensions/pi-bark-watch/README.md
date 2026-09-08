# Pi Bark-Watch 扩展

当 Agent 执行的任务**超过限定时间**（默认 3 分钟）并**完成**时，通过 **Bark** 推送一条系统通知到你的 iPhone，并进一步转发到 **Apple Watch**。

此外，当 AI **向用户提问**（`ask_user_question` 或任何会阻塞任务的弹窗）导致任务被问题阻塞时，也会推送一条提醒，让你知道需要及时回来处理。

---

## 为什么需要 Bark，而不是直接发到 Mac？

macOS 的原生通知（`display notification` / `terminal-notifier`）只显示在 Mac 上，**不会**出现在 Apple Watch 上。要让通知到达手表，需要走一条「推送服务 → iPhone → 手表」的通路：

```
Pi agent_settled  ──POST──▶  Bark 服务器  ──APNs──▶  iPhone  ──Notification Mirroring──▶  Apple Watch
```

Bark 是免费、开源、支持自定义服务端的推送工具，一条 HTTP 请求即可推送，非常适合这种场景。

---

## 使用步骤

### 1. 安装 Bark 并获取 Device Key

1. 在 iPhone 上安装免费 App [Bark](https://apps.apple.com/us/app/bark-custom-notifications/id1403753865)。
2. 打开 Bark，首页会显示一个 **Device Key**（一串字符）和一条测试推送 URL。
3. 记下这个 Device Key。

### 2. 配置本扩展

方式 A — 编辑扩展目录旁的 `config.json`（请勿把真实密钥提交到 Git）：

```json
{
  "server": "https://api.day.app",
  "deviceKey": "把这里的字符串换成你的 Device Key",
  "minutes": 3,
  "sound": "minuet",
  "level": "active",
  "notifyOnQuestion": true,
  "questionDelaySec": 3,
  "questionCooldownSec": 30
}
```

方式 B（推荐）— 使用环境变量（会覆盖配置文件，适合不想落盘密钥的场景）：

```bash
export PI_BARK_WATCH_KEY="你的 Device Key"
export PI_BARK_WATCH_MINUTES=3
```

如果使用 `config.json` 保存密钥，请限制文件权限：

```bash
chmod 600 config.json
```

Device Key 一旦泄露，应在 Bark 中轮换后再更新配置。

### 3. 让通知到达 Apple Watch

在 iPhone 上：

1. 打开 **Watch App** → 进入「通知」。
2. 找到 **Bark**，打开 **「镜像 iPhone 通知」**。
3. 确保手表处于解锁、佩戴状态，且 iPhone 在手表范围内、屏幕已熄屏/未在主动使用 —— 此时通知会自动转发到手表。
4. 说明：自定义提示音可能不会在手表上播放（手表通知音效受限）。

### 4. 测试

在 Pi 里运行：

```
/bark-watch
```

你的 iPhone / Apple Watch 收到「Pi Bark-Watch 测试」即表示通路正常。

---

## 配置项说明

| 配置项 | 环境变量 | 含义 | 默认值 |
|--------|-----------|------|--------|
| `server` | `PI_BARK_SERVER` | Bark 服务地址（可自托管） | `https://api.day.app` |
| `deviceKey` | `PI_BARK_WATCH_KEY` | 你的设备 Key（必填） | 无 |
| `minutes` | `PI_BARK_WATCH_MINUTES` | 超过该分钟数才提醒 | `3` |
| `sound` | `PI_BARK_WATCH_SOUND` | 系统提示音 | `minuet` |
| `level` | `PI_BARK_WATCH_LEVEL` | 通知级别（`critical`/`active`/`timeSensitive`/`passive`） | `active` |
| `notifyOnQuestion` | `PI_BARK_WATCH_QUESTION` | AI 提问阻塞时是否提醒 | `true` |
| `questionDelaySec` | `PI_BARK_WATCH_QUESTION_DELAY` | 提问后等待多少秒才推送（用户马上回答则不推） | `3` |
| `questionCooldownSec` | `PI_BARK_WATCH_QUESTION_COOLDOWN` | 两次提问提醒的最小间隔（秒） | `30` |

- 若 `server` 为自托管地址（例如局域网内的 bark-server），跨网络需要可访问，外网建议用默认 `https://api.day.app`。
- 国内网络若连不上 `api.day.app`，可自托管 bark-server 并改为你的地址。

## AI 提问阻塞提醒

当 AI 调用 `ask_user_question`（或任何通过 `ctx.ui.*` 弹出、阻塞任务的确认/选择/输入框）时，Pi 会触发 `ui_prompt_start` 事件，代表此刻开始**等待用户输入**。本扩展借此向你的 iPhone / 手表推送一条「任务已暂停，需要你回答」的提醒，让你在离开键盘时能及时回来处理。

默认行为：

- **延迟 3 秒**才推送（`questionDelaySec`）——如果你就在终端前、马上回答了，`ui_prompt_end` 会取消定时器，你不会收到多余的推送；若你不在，3 秒后即收到提醒。
- **30 秒冷却**（`questionCooldownSec`）——避免一连串弹窗时持续轰炸手表。
- 想立即推送（不等待延迟），把 `questionDelaySec` 设为 `0`。

> 该提醒复用 Bark 推送通路，且同样只在**顶层会话**生效（子代理会话静默，见下）。

## 子代理（Sub-agent）不推送

安装 `@tintinweb/pi-subagents` 后，`Agent` / `SubagentWorkflow` 工具会在**同进程**内为每个子代理创建独立的 `AgentSession`，而子会话同样会加载本扩展。因此不加防护时，**每个子代理任务结束都会触发一次推送**。

本扩展会在 `agent_settled` 里识别子会话并保持静默，只允许**顶层会话**（你直接对话的主任务）推送。判定依据：

1. 会话 header 带 `parentSession`（`rememberAgents` 默认开启时，持久化子代理会话会记录父会话，顶层会话没有此字段）；
2. 无会话文件（内存会话，嵌套子代理 / workflow 子代理的默认形态），且进程内存在 pi-subagents 的 manager 注册表（`Symbol.for("pi-subagents:manager")`）。

任何识别失败都会回退为「顶层会话」处理 —— 宁可多推一条，也不沉默地丢失通知。

> 已知边界：极少数使用 `ctx.newSession()` 做会话替换的扩展（如 handoff）也会在新会话 header 里写 `parentSession`，此时新会话也会被当作子代理而静默。未使用这类扩展则无影响。

---

## 工作原理（Pi 事件）

- `agent_start`：记录本次任务开始时间（同一轮里的自动重试 / 压缩不算新任务，只保留首次开始）。
- `agent_end`：记录本轮最终结果；失败或手动取消的任务不会冒充“完成”发送通知。
- `agent_settled`：Pi 确认不会自动继续运行后触发，计算耗时；若处于**子代理会话**（Agent / workflow 子任务）则直接静默返回；仅顶层会话中成功任务在 `耗时 >= minutes` 且已配置 `deviceKey` 时发送 Bark 推送，并在本地 TUI 弹出一条通知。Bark 请求最多等待 10 秒。
- `ui_prompt_start`：Pi 开始**等待用户输入**时触发（`ask_user_question` 或其他 `ctx.ui.*` 弹窗）。若处于子代理会话则静默；否则按 `notifyOnQuestion` 开关与延迟/冷却策略发送提问提醒。
- `ui_prompt_end`：用户回答完毕、Pi 不再等待时触发；若在 `questionDelaySec` 前回答，会取消尚未发送的定时推送。
- `session_shutdown`：清理状态，防止同一进程里跨会话残留旧时间。

> 为什么用 `agent_settled` 而不是 `agent_end`：`agent_end` 只是某一次底层运行的结束，Pi 可能还会自动重试/压缩/继续排队任务；`agent_settled` 才是「任务彻底结束、等待用户输入」的信号。
