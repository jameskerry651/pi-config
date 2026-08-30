# pi config — dotfiles 同步仓库

这是我的 [pi](https://github.com/earendil-works/pi-coding-agent) coding agent 配置，用于在多台电脑间同步。

> **⚠️ 安全说明**：
> 本仓库是公开的。任何密钥（`auth.json` 里的 API key）都**不会被提交**，
> 本机路径信息（`trust.json`、浏览器缓存）也已排除。API key 请留在各台机器的
> 本地文件或环境变量中。

## 包含内容

| 路径 | 说明 | 安全 |
|---|---|---|
| `settings.json` | 主题、默认 provider/model | ✅ 无敏感信息 |
| `models-store.json` | 已缓存的模型定义、成本 | ✅ 无敏感信息 |
| `agents/` | 自定义 agent（Explore / Plan / general-purpose） | ✅ |
| `extensions/` | 扩展源码（ask-user-question、browser），不含 node_modules / .profile | ✅ |
| `skills/` | 技能包（brainstorming 等） | ✅ |
| `npm/package.json` | npm 依赖清单（重装用） | ✅ |
| `install.sh` | 新机器一键初始化 | ✅ |

## 排除内容（已在 `.gitignore`）

- `auth.json` — API 密钥，绝不提交
- `sessions/` — 会话记录
- `node_modules/` — 依赖，用 `npm install` 重建
- `extensions/browser/.profile/` — 浏览器缓存/登录态
- `bin/`, `trust.json` — 本机专属（FD 二进制、绝对路径目录）

## 在新电脑上使用

前置：本机已安装 Node.js。

```bash
# 1) 安装 pi（若尚未安装）
npm i -g @earendil-works/pi-coding-agent

# 2) 克隆配置到 ~/.pi/agent（作为你的 pi 配置目录）
git clone https://github.com/jameskerry651/pi-config.git ~/.pi/agent

# 3) 安装依赖 + 配置 API key（推荐用脚本）
cd ~/.pi/agent && ./install.sh
```

`install.sh` 会：安装 npm 扩展依赖、可选安装 browser 扩展的 Chromium、检查 API key。

## 配置 API key（二选一）

- **环境变量**（推荐，适合 script / 多 provider）：
  ```bash
  export DEEPSEEK_API_KEY=sk-...
  # 可加入 ~/.zshrc / ~/.bashrc
  ```
- **交互式**：运行 `pi`，然后执行 `/login deepseek`，key 会写入本地 `~/.pi/agent/auth.json`（不会出现在 Git 里）。

## 更新与推送

在任一台机器上修改配置后：

```bash
cd ~/.pi/agent
git add -A
git commit -m "update config"
git push
```

其它机器拉取即可：

```bash
cd ~/.pi/agent && git pull
```

> 注意：`auth.json`、`sessions/` 已被 gitignore，`git add -A` 不会把它们加进去，
> 各台机器的 API key 和会话保持独立。

## 小贴士

- `models-store.json` 会在 pi 刷新模型目录时被重写，改动时可一并 commit。
- 有自定义本地改动又不想推上去时，可 `git stash`。
