# dsh-qq-bridge · QQ Bridge for DeepSeek Harness

<p align="center">
  <img src="https://img.shields.io/badge/DSH-0.2.1--rc.3-2563eb?style=flat-square" alt="DSH 0.2.1-rc.3">
  <img src="https://img.shields.io/badge/QQ-NapCat%20%2F%20OneBot-12b7f5?style=flat-square" alt="NapCat OneBot">
  <img src="https://img.shields.io/badge/QQ%20Bot-Official-00a870?style=flat-square" alt="QQ Official Bot">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/License-MIT-555?style=flat-square" alt="MIT License">
</p>

**把 DeepSeek Harness（DSH）与 AI 陪伴会话接到 QQ：手机上随时聊、派活、看提醒，无需开放公网端口。**

本仓库是 [TomoyoNatsume/dsh-qq-bridge](https://github.com/TomoyoNatsume/dsh-qq-bridge) 的个人深度适配版（包名 `@yachangchang/dsh-qq-bridge`，面向 DSH `0.2.1-rc.3`），在保留上游 QQ 遥控与双协议接入的基础上，重点增强了**持久分气泡投递、好友与群聊隔离、铃芽 RIN 记忆联动、四角色并行聊天、以及 Antigravity (`agy`) 私聊接入**。

---

## 架构一览

```text
手机 QQ ──► NapCat (OneBot WS) 或 腾讯官方 QQ Bot
                │
                ▼
         dsh-qq-bridge（白名单鉴权 · 图文准入 · 会话串行化 · 持久分气泡投递）
                │
      ┌─────────┼───────────────────────┐
      ▼         ▼                       ▼
  单 Agent    四角色并行聊天         Antigravity (agy) 私聊
(+ dsh-rin-memory) (4×独立会话)     (ACP 会话复用 + 图片直传)
```

## 本版核心能力

- **双协议 QQ 接入**：同时支持 **NapCat / OneBot**（个人单号/双号，限制少）与 **腾讯官方 QQ Bot**（开放平台，扫码零烦恼，支持 `npm run pair:official` 一次配对）。
- **三种聊天模式**：
  - **单 Agent 模式**（默认）：支持主人私聊、白名单好友独立私聊、白名单群 `@机器人` 群聊（同群共享会话并保留成员署名）。
  - **四角色模式**：同一条消息并行派给 4 个独立人设与模型的 DSH 会话，按完成顺序以 `<角色名>: ...` 发回，并按条增量同步共同聊天历史。
  - **Antigravity (`agy`) 私聊**：Provider 选 `agy` 后直连本地 ACP 会话，主人与获准好友各自持有独立人格与历史，支持纯图、图文混发与多图透传。
- **自然分气泡 + 崩溃不重发**：回复按自然换行拆成独立气泡，代码块、列表与引用保持整体，发送时剥去首尾空行，每条间隔约 0.8–2 秒。分段与进度按账号命名空间持久落盘至 `delivery.json`（Unicode 码点计数 + 稳定 `outputId`），崩溃或断线只续投已知未发片段，绝不重发已发消息。
- **与 [dsh-rin-memory](https://github.com/lxl8182/dsh-rin-memory) 无缝联动**：
  - 核对主人与授权好友身份及记忆就绪状态，回报真实图文输入与实际送达气泡正文，支撑无感上下文换段与跨段续聊。
  - 在设置页提供「好友记忆与续聊压缩」实时开关；关闭、撤销授权或暂停记忆时，已接入记忆的好友会话自动切回纯聊天新段。
  - 出站自动剥离私有元数据（`<下次联系>`、`<选题>`）与独立一行的闭合中文咒语标签，支持 `查资料` / `翻本子` 单次回填并补全来源链接；通过 `qqBridgeEvents.deliverByIndex` 复用同一队列投递主动搭话。
- **会话与效率控制**：支持 `/dir`、`/model`、`/reasoningEff`、`/permission`、`/new-session` 等指令及自然语言控制；支持一次性定时提醒、持久化 memo、非 QQ Web 会话完成自动提醒，以及网页归档会话后下一条 QQ 消息自动重开新会话。

---

## 快速开始

### 系统要求

- 已安装 DeepSeek Harness（`0.2.1-rc.3`），Node.js `20+`。
- **NapCat 路径**：已安装 NapCat（Linux / WSL2 可使用 CLI，服务器亦可走 Docker 容器仅绑回环端口）。
- **官方 Bot 路径**：已在 [QQ 开放平台机器人控制台](https://q.qq.com/qqbot/dashboard/) 创建应用并取得 AppID / AppSecret。

> 自动安装向导 `setup` 面向 Linux / WSL2；Windows 桌面端建议直接在 DSH 设置页完成配置。

### 安装与启用

从本仓库构建打包后，通过 DSH 插件管理安装（本机桌面与服务器 Web 需在各自 profile 分别安装）：

```bash
npm install
npm run build
npm pack
```

在 DSH Web profile 中安装生成的包（或使用上游 npm 包）：

```bash
pnpm dsh plugin --profile web add <生成的 .tgz 路径或包名>
```

安装后默认 `enabled: false`。启动 `dsh web`（或重开桌面端），进入左下角 **设置 → QQ bridge**：

1. 在「通用配置」中设定聊天模式、Provider / Model / 思考强度、工作目录与访问白名单（修改自动保存）。
2. 选择 **NapCat / OneBot** 或 **腾讯官方 QQ Bot** 填入接入信息并启动。
3. 在 QQ 发送 `ping`，收到回复即联通。

> 更新本地插件包或修改关键配置后，请**完全退出并重启** DSH。

---

## 接入方式与模式配置

### 1. NapCat / OneBot（推荐个人使用）

支持**双号模式**（推荐，机器人号收消息、主号发指令）与**单号模式**（主号给自己发消息，需开启 `selfLogInput` 监听日志）。OneBot 正向 WebSocket 推荐仅监听 `127.0.0.1:3001` 并配置强 access token：

```yaml
platform: napcat
napcat:
  wsUrl: ws://127.0.0.1:3001
  token: "<NapCat OneBot access token>"
```

- **Linux / WSL2 安装 NapCat**：
  ```bash
  curl -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh
  bash napcat.sh --docker n --cli y
  ```
- **掉线自愈**：设置页可勾选「掉线后自动重启并提示扫码」，仅监控本机 NapCat CLI 的新增 `[KickedOffLine]` 日志，内置频控（10 分钟最多 1 次、每小时最多 3 次），**请勿与旧脚本 `scripts/keep-napcat-alive.sh` 同时运行**。
- **频繁强制下线排查**：如反复出现 `[KickedOffLine]`，可参考 [docs/napcat-offline-diagnosis.md](docs/napcat-offline-diagnosis.md)，或使用固定版本修复脚本 `bash scripts/reinstall-napcat-4.15.19.sh`（QQ `3.2.21-42086` + NapCat `4.15.19`，会备份现有 `~/.config/QQ` 与 `~/Napcat` 后重装，需重新扫码）。

### 2. 腾讯官方 QQ Bot

无需扫码，但受官方平台限制默认关闭 `notifications.agentReply.enabled`（避免触发 `40034122` 主动消息额度上限）：

```yaml
platform: official
official:
  appId: "<AppID>"
  appSecret: "<AppSecret>"
  adminOpenId: "<管理员 openid>"
  allowlistOpenIds: []
  sandbox: false
access:
  mode: whitelist
notifications:
  agentReply:
    enabled: false
```

首次获取 `adminOpenId` 可在仓库目录运行一次配对向导（不修改 DSH profile）：

```bash
npm run pair:official
```

按提示输入 AppID 与 AppSecret，用管理员 QQ 向机器人发送终端显示的配对口令，将输出的 OpenID 复制回设置页即可。

### 3. 四角色聊天（`agent.mode: multi`）

在「设置 → QQ bridge → 通用配置」切换为 **四角色**，分别为 4 个角色设置名称、人设、Provider、Model 与思考强度（手动配置对应 `agent.mode: multi` 与 `agent.roles` 四项，保持每项 `id` 稳定可在改名或换模型后继续沿用原 DSH 会话）：

- 每条消息并行交给 4 个独立 DSH 会话，角色看到各自人设与共享完整聊天记录（含用户及四角色发言），且仅增量追加未同步的新条目。
- 谁先生成完谁先发（如 `gpt: ...`），同一聊天的新消息等待本轮结束；私聊与各群独立存储记录于 `plugins/dsh-qq-bridge/<账号命名空间>/role-chat.json`。
- 发送 `/new-session` 会等当前轮发完，归档记录与旧会话并重建四个新会话。

### 4. Antigravity (`agy`) 私聊

在通用配置的 Provider 菜单选择 `agy` 并选定模型与思考强度后，主人与获准好友的私聊走独立 ACP 会话（活跃聊天自动复用，纯图/多图随当轮透传，新会话回放文字历史）。

Linux 服务部署需向 DSH 进程提供以下环境变量，并先以专用账号完成 `agy` 登录：

| 环境变量 | 用途 |
|---|---|
| `DSH_QQ_AGY_ROOT` | 安装目录，含 `bin/agy`、`workspace` 与 `public-workspace`（两个工作区需含 `.agents/agents`） |
| `DSH_QQ_AGY_USER` | DSH 通过 `runuser` 启动 `agy` 使用的专用系统账号 |
| `DSH_QQ_AGY_HOME` | 专用账号保存 `agy` 登录状态的 HOME 目录 |
| `DSH_QQ_AGY_PERSONA_DIR` | 存放 `persona_versions.json` 与 `qq_public_persona.json` 的目录 |
| `DSH_QQ_AGY_PROXY` | 可选，传递给 `agy` 子进程的 HTTP / HTTPS 代理地址 |

---

## 指令与自然语言控制

默认空前缀（`access.commandPrefix: ""`）时，白名单用户可直接发送以下内置控制命令（命中后由 Bridge 独占消费，不进入 Agent）；如配置了前缀（如 `/dsh`），需加前缀调用：

| 指令 | 作用 |
|---|---|
| `/help` | 查看 Bridge 内置控制命令说明 |
| `/dir <目录>` | 切换当前 QQ 会话工作目录（下一条消息启用新会话） |
| `/models` | 列出当前 Provider 可用模型 ID |
| `/model <模型名>` | 动态切换当前会话模型（下一次请求生效） |
| `/reasoningEff <等级>` | 切换当前会话思考强度 |
| `/permission [preset]` | 查看或通过 DSH 原生命令切换当前 live session 权限（如 `workspace-write`） |
| `/new-session` | 等本轮发完后新开会话（保留目录、模型、推理等级及 memo / timer） |

在 QQ 专用预设下，也支持直接用自然语言切换目录/模型/权限、新开会话、设一次性定时提醒（如“明天中午 12 点提醒我提交报告”）或记录 memo（按同 target + 稳定 key 更新），数据落盘于 `~/.dsh/storages/dsh_qq_bridge.json`。

---

## 安全与可靠性约定

- **坚持白名单**：保持 `access.mode: whitelist`，仅放行 `adminQq` / `allowlist` / `groupAllowlist`（或官方 Bot 的 `adminOpenId` / `allowlistOpenIds`）。
- **只监听回环地址**：OneBot WS 绑定 `127.0.0.1:3001` 并启用随机 token，勿直接暴露公网。
- **凭据不入库**：严禁提交 `cordis.patch.yml`、OneBot token、AppSecret、API Key、`delivery.json`、`role-chat.json` 与个人 QQ 号。
- **Shell 默认关闭**：保持 `shell.enabled: false`，避免 QQ 消息直接触发本机 Shell。
- **单号模式禁重放**：保持 `selfLogInput.replayOnStart: false`，防止重启把历史日志重跑一遍。

---

## 常见问题

- **发送后没回复**：NapCat 路径先查 `napcat log <QQ号>`，确认在线、正向 WS 端口 `3001` 与 token 一致、发信 QQ 在白名单内；若 DSH 正在等待工具审批，请到 Web 端确认或调整权限。
- **官方 Bot 日志报 `40034122`**：主动提醒额度已满，保持 `notifications.agentReply.enabled: false`，不影响正常问答回复。
- **本地只测 QQ 链路不走 Agent**：可用 `DSH_QQ_ADMIN=<QQ号> DSH_QQ_TOKEN=<token> bash scripts/start-local-echo.sh`，发 `ping` 返回 `echo: ping`。
- **改完源码未生效**：插件实际加载编译后的 `dist/`，改完 `src/` 必须运行 `npm run build` 并重新打包安装，再重启 DSH。

---

## 开发、上游关系与许可

```bash
npm install
npm test          # 运行 40 个 vitest 测试文件
npm run build     # 编译 TypeScript 与设置页客户端（dist/ 为提交型产物）
```

详细设计背景与部署排查见 [docs/project-overview.md](docs/project-overview.md) 与 [docs/deploy-wsl2-local.md](docs/deploy-wsl2-local.md)。

本仓库基于 [TomoyoNatsume/dsh-qq-bridge](https://github.com/TomoyoNatsume/dsh-qq-bridge) 开发，仅用于个人适配与演进，不向上游提交 PR。沿用上游 **MIT License**（见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)），感谢原作者以及 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)、[OneBot](https://github.com/botuniverse/onebot) 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 社区。
