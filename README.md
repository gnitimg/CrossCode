<div align="center">

# ⚡ CrossCode

**Local Unified Coding Agent Orchestrator · Cross-App Project Hub · Shared Skill & MCP Engine**  
**本机统合编程 Agent 平台与跨项目远程控制中心**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-Monorepo-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![MCP](https://img.shields.io/badge/MCP-Unified_Hub-8B5CF6)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/Tests-149_Passed-10B981)](#测试与质量保障)

</div>

---

## 📖 项目背景与核心定位

当本地开发机同时安装了 **OpenCode、Claude Code、Codex、Qoder、ZCode、DeepSeek Harness** 等多款 AI 编程工具时，开发者往往面临四大痛点：
1. **项目极度碎片化**：不同项目散落在不同工具的历史会话与私有配置中，难以在统一视图下管理，更无法通过手机/远程设备随时接管。
2. **模型与工具切换割裂**：当某家 API 额度耗尽、触发 429 限流，或希望用不同工具接力同一个项目时，上下文无法无缝继承。
3. **Skills 与高阶能力孤岛**：各家工具的 `SKILL.md` 互不相通；**内置受控浏览器（Built-in Browser）**、**外置真实浏览器（External Chrome Bridge）**、**桌面级控制（Computer Use）** 等能力被特定客户端独占。
4. **报错码五花八门**：各家工具的认证失败、配额耗尽、上下文溢出、文件锁冲突报错格式完全不同，难以自动化排障与切流自愈。

**CrossCode** 正是为了彻底解决上述问题而生的**本地统合编程 Agent 平台**：
- **双栖智能体内核**：它**自身就是一个完整的一等公民编程 Agent（`CrossCode Native Harness`）**，支持 `Plan / Build / Orchestrate` 三种模式；同时通过标准适配器（Adapters）统合调度本机已安装的 6 大编程工具。
- **全能力共享中心**：一处安装 Skill，全平台零拷贝共享；内置 **Unified MCP Hub**，让本机所有编程 Agent 都能直接调用内置浏览器、外置 Chrome 扩展桥接以及 Windows 原生 Computer Use。
- **统一 `CC-XXXX` 错误码与一键自愈**：实时拦截并归一化各家异构报错，支持一键切换备用 Provider 或热切换至另一款编程 Agent 无缝接力。
- **多端自适应远程工作台**：提供桌面端三栏 IDE 级审查布局与手机竖屏单手操控模式。

---

## ✨ 核心特性

### 1. 🗂️ 散落项目全盘自动发现与 `.agent` 协议接力
- **多源扫描器 (`ProjectScanner`)**：自动解析工作区根目录及 `~/.claude`、`~/.local/share/opencode`、`~/.codex`、`~/.qoder`、`~/.zcode`、`~/.deepseek` 等本地历史与注册表，按真实物理路径去重合并，标注项目来源标签。
- **`.agent/` 跨智能体共享工作区**：
  - 自动在项目根目录维护 `.agent/{plans,context,runtime,logs}`，并自动写入 `.gitignore` 与 `.git/info/exclude`，**确保中间记忆文件永不污染 Git 提交**。
  - 当你在同一个项目中从 `Claude Code` 切换到 `OpenCode` 或 `CrossCode Native` 时，新引擎自动挂载 `.agent/context/project-memory.md` 与 `active-task.json`，从断点处无缝继续。

### 2. 🤖 双栖 Agent 引擎：`CrossCode Native` + 6 大外部适配器
- **`crosscode-native`（自研内建引擎）**：
  - 内置高速文件读写、精准行级编辑（`edit_file`）、正则/文件名检索、受控 Shell 与 Git Diff 工具链。
  - 支持 **Orchestrate（元编排模式）**：可作为主控架构师（Lead Agent），将子任务自动派发给本机的 `claude-code`、`opencode` 或 `codex` 并行协同完成。
- **6 大标准化外部适配器 (`IHarnessAdapter`)**：
  - 原生对接 `opencode`、`claude-code`、`codex`、`qoder`、`zcode`、`deepseek-harness` 的 JSON-RPC / Stream-JSON 或交互式终端流，统一转化为标准 `UnifiedStreamEvent`。

### 3. 🧩 Skills 虚拟化同步与 Unified MCP 全能力共享
- **Skills 虚拟化引擎 (`SkillVirtualizer`)**：
  - 将中心技能库（如 `~/.agents/skills`）与各 App 私有技能双向归集，通过 Windows 目录联接（`Junction` 零拷贝软链接，免管理员权限）与 Frontmatter 自动转译，实现**“一处编写，全家可用”**。
- **Unified MCP Hub (`@crosscode/mcp-hub`)**：自动注入各家工具的 MCP 配置，统一暴露三大高阶能力：
  - 🌐 **Built-in Browser (`browser_builtin_*`)**：基于 Playwright 的受控浏览器池，提供无障碍快照树（`@e1`, `@e2` 引用点按）、表单填充、截图、Console 与网络日志采集。
  - 🔗 **External Browser Bridge (`browser_external_*`)**：通过本地 WebSocket 桥接真实 Chrome/Edge 浏览器活动标签页，直接复用用户已登录的复杂网页环境。
  - 🖥️ **Windows Computer Use (`computer_*`)**：零原生编译依赖封装 Win32 桌面截图、坐标点击/拖拽、快捷键输入、窗口枚举与聚焦，并内置敏感窗口黑名单与远程人工审批围栏（Safety Guard）。

### 4. 🛡️ `CC-XXXX` 统一错误码体系与故障自愈
实时拦截各家 CLI Stdout/Stderr 与 API 异常，映射为 11 类标准错误码并绑定自愈策略：

| 标准错误码 | 分类 | 典型触发场景（跨工具统一识别） | 自动恢复 / 远程交互动作 |
| :--- | :--- | :--- | :--- |
| `CC-AUTH-1001` | 认证鉴权 | API Key 无效/缺失 (`401`, `invalid_api_key`, `Not logged in`) | `SWITCH_PROVIDER`（一键切换可用密钥/渠道） |
| `CC-AUTH-1002` | 认证鉴权 | OAuth 令牌过期或权限不足 (`403`, `permission_error`) | `SWITCH_PROVIDER`（刷新令牌或切换备用提供商） |
| `CC-QUOTA-2001` | 配额限流 | 请求速率超限 (`429`, `rate_limit_exceeded`, `Too Many Requests`) | `RETRY_BACKOFF`（指数退避重试或切流） |
| `CC-QUOTA-2002` | 配额限流 | 账户余额不足或配额耗尽 (`insufficient_quota`, `billing_hard_limit`) | `SWITCH_PROVIDER`（保存 `.agent` 快照并热切至备用引擎） |
| `CC-CTX-3001` | 上下文模型 | 上下文窗口超限 (`context_length_exceeded`, `prompt is too long`) | `COMPACT_CONTEXT`（自动压缩历史至 `.agent/context`） |
| `CC-CTX-3002` | 上下文模型 | Tool Call JSON 截断或参数解析异常 (`invalid_tool_input`) | `RETRY_BACKOFF`（自动注入格式修正提示词重试） |
| `CC-TOOL-4001` | 工具与 MCP | MCP 工具调用超时或子服务断连 | `RESTART_PROCESS`（自动重连 MCP 子服务） |
| `CC-TOOL-4002` | 工具与 MCP | 浏览器/Computer Use 高危操作等待人工审批 | `AWAIT_APPROVAL`（向 Web/手机端推送审批卡片） |
| `CC-TOOL-4003` | 工具与 MCP | 本地文件占用锁冲突或权限受限 (`EBUSY`, `EPERM`) | `RETRY_BACKOFF`（退避重试或提示释放句柄） |
| `CC-PROC-5001` | 进程与网络 | 底层 CLI 进程非零退出或异常崩溃 | `RESTART_PROCESS`（记录 `.agent/logs` 并从检查点拉起） |
| `CC-PROC-5002` | 进程与网络 | 上游模型网络断连或代理超时 (`ECONNRESET`, `ETIMEDOUT`) | `RETRY_BACKOFF`（检测网络通道并自动重连） |

### 5. 🖥️ 桌面端与移动端自适应工作台 (`@crosscode/web` + `@crosscode/desktop`)
- **OpenCode Desktop / Cursor 级三栏布局**：左侧项目与 Agent 矩阵 + 中间统一流式推理与工具时间线 + 右侧三合一检视器（**Git Diff 审查合入/回滚**、**内置浏览器/Computer Use 实时远程画面点按**、**`.agent` 记忆脑图**）。
- **Cherry Studio 风格顶部复合切换栏**：一键切换当前项目的执行 Harness、Provider 渠道与 `Plan / Build / Orchestrate` 模式，带实时延迟与配额状态灯。
- **Cline / Roo Code 风格透明工具审批卡**：折叠展示思考链与工具入参/出参，高危操作支持远程一键 `Approve / Reject`。
- **Linear / Raycast 风格 `Ctrl/Cmd + K` 命令面板**：全键盘极速切换项目、切换底层 Agent、触发上下文压缩或直接发送指令。
- **移动端与微信小程序就绪**：支持 6 位动态 PIN 码设备配对换取 JWT，手机竖屏访问自动切换为底部大拇指导航栏与抽屉式极速遥控视图。
- **Electron 桌面端**：内置 daemon 与工作台，无需预装 Node、无需手动开终端；托盘常驻、单实例锁、`Alt+Shift+C` 全局唤起命令面板、`CC-TOOL-4002` 系统原生通知（点击直达审批），可打包为 NSIS 安装包。

---

## 🏗️ 仓库目录结构 (Monorepo)

本项目基于 `pnpm workspaces` 构建，包含 5 个核心子包：

```text
CrossCode/
├── packages/
│   ├── shared/                   # @crosscode/shared: 核心类型契约、流事件协议、CC-XXXX 错误码归一化引擎
│   │   ├── src/types.ts
│   │   └── src/error-normalizer.ts
│   ├── mcp-hub/                  # @crosscode/mcp-hub: 跨平台 Skills 虚拟化同步器 + Unified MCP Server
│   │   ├── src/skills/skill-virtualizer.ts
│   │   ├── src/tools/builtin-browser.ts
│   │   ├── src/tools/external-browser-bridge.ts
│   │   ├── src/tools/computer-use-win32.ts
│   │   └── src/server.ts
│   ├── daemon/                   # @crosscode/daemon: 本地常驻守护服务、项目扫描器、双栖 Agent 引擎与网关
│   │   ├── src/workspace/agent-workspace.ts
│   │   ├── src/scanner/project-scanner.ts
│   │   ├── src/harnesses/        # CrossCodeNativeHarness + OpenCode/Claude/Codex/Qoder/ZCode/DeepSeek 适配器
│   │   ├── src/providers/provider-switchboard.ts
│   │   └── src/server/http-ws-gateway.ts
│   └── web/                      # @crosscode/web: React 19 + Tailwind v4 响应式桌面/移动端远程工作台
│       └── src/components/
│   └── desktop/                  # @crosscode/desktop: Electron 桌面壳（托盘常驻、内置 daemon、原生审批通知）
│       ├── src/main.ts
│       └── scripts/package.mjs
├── .gitignore                    # 默认全局忽略 .agent/ 中间目录，防止污染 Git 历史
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## 🚀 快速开始

### 环境要求
- **Node.js**: `>= 22.0.0`（推荐使用 v22 LTS 或 v24）
- **pnpm**: `>= 9.0.0`（项目锁定 `pnpm@10.33.0`）
- **操作系统**: Windows 10 / 11（Computer Use 与 Junction 虚拟化针对 Windows 深度优化，核心服务跨平台兼容 macOS/Linux）

### 1. 安装依赖

```bash
git clone https://github.com/gnitimg/CrossCode.git
cd CrossCode
pnpm install
```

### 2. 全量构建

```bash
pnpm build
```

### 3. 运行测试套件

```bash
pnpm test
```

### 4. 启动开发与预览

启动前端工作台开发服务器：
```bash
pnpm --filter @crosscode/web dev
```

启动桌面端（Electron，内置 daemon）：
```bash
pnpm --filter @crosscode/web build   # 工作台产物由 daemon 直接托管
pnpm desktop                         # 构建主进程并启动
```

桌面端关窗即隐藏到托盘，`Alt+Shift+C` 全局唤起命令面板；打包为可安装应用：
```bash
pnpm desktop:dist                    # → packages/desktop/release/CrossCode/CrossCode.exe
pnpm --filter @crosscode/desktop installer   # → release/CrossCode-<version>-setup.exe
```

在代码中启动本地守护进程网关与 Skills 虚拟化中心：
```typescript
import { createDaemonSessionManager, createGateway } from '@crosscode/daemon';
import { SkillVirtualizer, createUnifiedMcpServer } from '@crosscode/mcp-hub';

// 1. Skills 虚拟化：扫描中心技能库并零拷贝同步到各 App（Windows Junction，免管理员权限）
const skills = new SkillVirtualizer(); // 默认 SSOT 为 ~\.agents\skills，目录均可注入
await skills.scan();
await skills.syncToApps();

// 2. 启动 Unified MCP Server（18 个共享工具，含内置/外置浏览器与 Computer Use 审批决议出口）
const mcpServer = createUnifiedMcpServer({ skills });

// 3. 创建 Daemon 组合根 SessionManager（默认开启 enforceApprovalGate 阻塞审批，并桥接 MCP CC-TOOL-4002）
const sessionManager = createDaemonSessionManager({
  computerUse: mcpServer.computerUse,
});

// 4. 启动本地 REST + WebSocket 统合网关
const gateway = createGateway({
  jwtSecret: process.env.CROSSCODE_JWT_SECRET!, // HS256 签名密钥（必填）
  pin: '884866',                                // 远程设备 6 位配对码；省略则每次启动随机生成
  scanOptions: { workspaceRoots: ['F:\\cs'] },  // 项目扫描范围（可选，默认全量默认目录）
  sessionManager,
});
await gateway.app.listen({ port: 4399, host: '127.0.0.1' });
```

---

## 🔌 核心 API 与 WebSocket 协议概览（微信小程序 / 远程端直接对接）

CrossCode Daemon 原生提供结构化 REST 与双向 WebSocket 接口，后期包装为**微信小程序**或对外暴露为**顶层 MCP Server** 时无需修改核心逻辑：

| 端点 / 通道 | 方法 | 说明 |
| :--- | :--- | :--- |
| `/pair` | `POST` | 输入本机 6 位配对 PIN 码（连续失败触发速率锁定），换取远程设备访问 `JWT Token` |
| `/projects` | `GET` | 获取本机跨 App 自动归集的全量项目列表、活跃 Agent 与 `.agent` 状态 |
| `/providers` | `GET` | 获取 Provider 目录（内置 6 家 + 自定义 OpenAI 兼容端点）与环境变量注入规格 |
| `/projects/:id/harness` | `POST` | 无缝热切换指定项目的底层执行引擎 `Harness`（并同步 `.agent/manifest.json`） |
| `/projects/:id/provider` | `POST` | 无缝热切换指定项目的模型 `Provider`（持久化至 `.agent/runtime/provider-state.json`） |
| `/skills` | `GET / PUT` | 查询全局共享 Skills 注册表，逐项启用/禁用 |
| `/projects/:id/diff` | `GET` | 获取当前项目工作区未提交的变更文件列表与 Unified Diff 补丁（`core.quotepath=off`，中文路径原生显示） |
| `/projects/:id/diff/accept` | `POST` | 远程确认并暂存（`git add`）Agent 生成的代码变更 |
| `/projects/:id/diff/discard` | `POST` | 远程一键回滚（`git checkout --`）不满意的文件修改 |
| `/ws/session` | `WebSocket` | 双向实时流：下行推送 `UnifiedStreamEvent`（思考流、工具调用、代码变更、`CC-XXXX` 报错）、`approval_request` 审批卡与 `screen_frame` 实时屏幕帧；上行发送 `auth`、`approve`、`reject`、`send_prompt`、`switch_provider` |

---

## 🧪 测试与质量保障

本项目严格遵循 **TDD（测试驱动开发）** 构建，内置 11 个测试套件共 **149 项自动化测试**：
- `@crosscode/shared`: 核心契约校验 + 11 类 `CC-XXXX` 跨应用报错正则与自愈策略全覆盖测试。
- `@crosscode/mcp-hub`: Skills 目录虚拟化（Windows Junction + Frontmatter 转译）测试 + 内置浏览器、外置浏览器桥接、Win32 Computer Use 与安全围栏测试。
- `@crosscode/daemon`: `.agent` 工作区幂等初始化与 Git 忽略测试 + 跨 6 大编程 App 项目扫描去重测试 + `CrossCodeNativeHarness` 与外部 Adapter 故障自动漂移接力测试 + JWT 配对与 Git Diff 网关集成测试。
- `@crosscode/web`: WebSocket 自动重连客户端、工具审批卡片、`CC-XXXX` 错误一键自愈横幅、`Ctrl+K` 命令中心交互组件测试。

---

## 🗺️ 演进路线图 (Roadmap)

- [x] **Phase 1**: `.agent` 跨平台工作区规范、`@crosscode/shared` 核心契约与 `CC-XXXX` 统一错误码引擎
- [x] **Phase 2**: 散落项目多源扫描器 (`ProjectScanner`) 与 Skills 虚拟化零拷贝同步器 (`SkillVirtualizer`)
- [x] **Phase 3**: Unified MCP Hub（内置受控浏览器 + 外置 Chrome WebSocket 桥接 + Windows Computer Use）
- [x] **Phase 4**: 双栖 Agent 核心（`CrossCodeNativeHarness` + OpenCode / Claude Code / Codex / Qoder / ZCode / DeepSeek 适配器）
- [x] **Phase 5**: 本地守护网关与响应式 Web 控制台 (`@crosscode/web`)
- [ ] **Phase 6**: 微信小程序端轻量化遥控面板（扫码配对、微信消息推送工具审批提醒、语音下发编程任务）
- [ ] **Phase 7**: Top-Level MCP Server 模式（将 CrossCode 自身作为超级 MCP 节点暴露给异地设备与云端工作流）

---

## 📄 License

MIT License © 2026 gnitimg
