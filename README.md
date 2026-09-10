# pi config — pi coding agent 配置同步仓库

这是我的 [pi](https://github.com/earendil-works/pi-coding-agent) coding agent 配置，用于在多台 Mac 间同步：
模型 / provider 定义、扩展、技能、子 agent，以及新机器的一键初始化脚本。

仓库根目录**就是** pi 的配置目录 `~/.pi/agent`，克隆下来即可直接被 pi 读取。

> **⚠️ 安全说明**
> 本仓库是**公开**的。任何密钥（`auth.json` 里的 API key、Bark Device Key、邮箱授权码）都**不会被提交**：
> 相关文件已全部写入 `.gitignore`，密钥改从各台机器的本地文件或环境变量注入。
> 提交前请确认 `git status` 里没有出现 `auth.json` / `config.json` 之类的文件。

---

## 快速开始（新机器）

前置：已安装 Node.js。

```bash
# 1) 安装 pi（若尚未安装）
npm i -g @earendil-works/pi-coding-agent

# 2) 克隆配置到 ~/.pi/agent（作为 pi 的配置目录）
git clone https://github.com/jameskerry651/pi-config.git ~/.pi/agent

# 3) 安装依赖 + 检查 API key
cd ~/.pi/agent && ./install.sh
```

`install.sh` 会：安装 npm 扩展依赖（`npm/`、`extensions/browser/`）、可选下载 browser 扩展的
Chromium、检查 API key 并提示配置方式。

完成后运行 `pi` 即可。

---

## 仓库内容

### 核心配置

| 路径 | 说明 |
|---|---|
| `settings.json` | 主题、默认 provider/model、启用的 package 与资源开关 |
| `models.json` | 自定义 provider/model 定义（如 DeepSeek V4.1 Flash：contextWindow、价格、thinking 级别映射） |
| `models-store.json` | pi 缓存的模型目录与成本表（会被 pi 自动重写） |
| `agents/` | 子 agent 定义（见下） |
| `npm/package.json` | npm 扩展依赖清单（重装用） |
| `install.sh` | 新机器一键初始化 |

当前默认：`theme=dark`、`defaultProvider=deepseek`、`defaultModel=deepseek-flash`、`tuiMode=fullscreen`。

### 扩展 `extensions/`

| 扩展 | 作用 | 工具 / 命令 |
|---|---|---|
| `ask-user-question.ts` | 交互式提问 UI（选项 + Other 自由输入），供 agent 在关键决策点向人确认 | `ask_user_question` |
| `browser/` | Playwright 无头 Chromium，像人一样驱动真实 SPA：看 localStorage、console、网络请求 | `browser_goto` / `_eval` / `_console` / `_network` / `_fill` / `_click` / `_screenshot` / `_close`；`/browser on\|off`（默认关闭省 token） |
| `pi-bark-watch/` | 任务超时完成、或 AI 提问阻塞任务时，经 Bark 推送到 iPhone → Apple Watch | `/bark-watch`（测试推送） |
| `resource-manager/` | 交互式管理 skills / extensions / prompts / themes，兼容内置 `pi config` 的 `+path` / `-path` 约定 | `/resources`、`/resources-reload`；`resource_manager` |
| `imessage-cleanup.ts` | **只读**扫描 iMessage/短信库，分类（验证码/营销/服务通知/真人/群聊/白名单）并生成清理候选报告 | `sms_scan` |
| `ssh.ts` | 示例扩展：把 read/write/edit/bash 委托到远端机器执行 | `pi -e ./ssh.ts --ssh user@host` |
| `pimail` → 符号链接 | 邮件扩展（Gmail / QQ / Outlook 走 IMAP/SMTP，写操作风险分级 + 人工审批） | `mail_*` 系列 |

> `imessage-cleanup` 明确**不包含删除能力**：只拷贝 `chat.db` 快照 + `SELECT`，原库永不写入。
> 它需要运行 pi 的终端 App 拥有「完全磁盘访问权限」（系统设置 → 隐私与安全性）。

### 技能 `skills/`

| 技能 | 说明 | 状态 |
|---|---|---|
| `brainstorming` | 通过对话把想法打磨成设计/规格；仅在用户显式要求「头脑风暴」时触发 | 仓库内保留，`settings.json` 中默认**禁用** |
| `imessage-cleanup` | `sms_scan` 背后的扫描脚本与分类规则 | 启用 |
| `training-monitor` → 符号链接 | RL 训练启动流程：后台子 agent 每 N 个 update 只读分析日志、给建议，不干预训练 | 仓库内保留，默认**禁用** |

用 `/resources` 可以随时把禁用的技能打开（或做「仅本会话生效」的临时启用）。

### 子 agent `agents/`

| Agent | 类型 | 说明 |
|---|---|---|
| `Explore.md` | 只读 | 快速定位代码：按模式找文件、grep 符号/关键字 |
| `Plan.md` | 只读 | 软件架构：探索代码库并设计实现方案 |
| `general-purpose.md` | 全工具 | 通用多步任务（研究、搜索、执行） |

三者均默认使用 `deepseek/deepseek-flash`。

### npm packages（由 `settings.json` 的 `packages` 管理）

| Package | 提供 |
|---|---|
| `@tintinweb/pi-subagents` | `Agent` / `SubagentWorkflow` 子智能体编排 |
| `pi-web-access` | `web_search` / `fetch_content` / `source_check` / `get_search_content` |
| `@narumitw/pi-chrome-devtools` | `chrome_devtools_*` 真实 Chrome 控制 |
| `@sentiolabs/pi-frontend-design` | 前端设计 skill + prompt（当前在 `settings.json` 中禁用） |

---

## 排除内容（已在 `.gitignore`）

| 排除项 | 原因 |
|---|---|
| `auth.json` | API 密钥，**绝不提交** |
| `sessions/` | 会话记录，体积大且是本机状态 |
| `node_modules/` | 依赖，用 `npm install` 重建 |
| `bin/` | 本机专属二进制（`fd`）与 shell wrapper |
| `trust.json` | 本机绝对路径 / 项目信任记录 |
| `extensions/browser/.profile/` | 浏览器缓存与登录态 |
| `extensions/pimail`、`skills/training-monitor` | 符号链接，源码在上述链接指向的项目仓库里 |
| `/pimail/` | 邮件扩展的本地账户配置与日志 |
| `extensions/pi-bark-watch/config.json` | 含 Bark Device Key |
| `pi-web-update-check.json` | 运行时状态（更新检查缓存） |
| `.DS_Store` 等 | 系统垃圾文件 |

---

## 配置 API key（二选一）

- **环境变量**（推荐，适合脚本 / 多 provider）：加入 `~/.zshrc` 或 `~/.bashrc`
  ```bash
  export DEEPSEEK_API_KEY=sk-...
  ```
- **交互式**：运行 `pi` 后执行 `/login deepseek`，key 写入本地 `~/.pi/agent/auth.json`（不入库）。

其它扩展的密钥同样走环境变量，例如 Bark：`PI_BARK_WATCH_KEY`、`PI_BARK_WATCH_MINUTES`。

---

## 更新与推送

修改配置后：

```bash
cd ~/.pi/agent
git status          # 确认没有 auth.json / *.config.json 之类的敏感文件
git add -A
git commit -m "update config"
git push
```

其它机器拉取：

```bash
cd ~/.pi/agent && git pull
```

`auth.json`、`sessions/` 已被忽略，各台机器的密钥与会话保持独立。

---

## 小贴士 / 机器相关项

- **`settings.json` 的 `shellPath`** 指向 `~/.pi/bin/zsh-wrapper`（本机绝对路径），而 `bin/` 不入库。
  新机器上要么把该字段改成 `/bin/zsh`，要么重建这个 wrapper —— 它的作用是先 `source ~/.zshrc`
  让别名/函数在 bash 工具里生效：
  ```bash
  mkdir -p ~/.pi/bin && cat > ~/.pi/bin/zsh-wrapper <<'EOF'
  #!/bin/zsh
  if [[ "${1:-}" == "-c" ]]; then
    source ~/.zshrc 2>/dev/null || :
    eval "$2"
  else
    exec /bin/zsh "$@"
  fi
  EOF
  chmod +x ~/.pi/bin/zsh-wrapper
  ```
- `models-store.json` 会在 pi 刷新模型目录时被重写，有变更可一并 commit。
- 新增扩展/技能后，若 `settings.json` 未显式启用，用 `/resources` 打开比手改 JSON 更省事。
- 有本地改动又不想推上去时，用 `git stash`。
