# @crosscode/web — CrossCode 前端工作台

React 19 + Vite 6 + Tailwind CSS v4 + Zustand 5 + lucide-react，对接 daemon 网关（`http-ws-gateway.ts`）的 REST 与 WebSocket 协议。同一份构建产物既用于浏览器访问，也由桌面端（`@crosscode/desktop`）直接托管。

## 快速开始

```bash
pnpm install                 # 仓库根目录执行一次即可（workspace 链接）
pnpm --filter @crosscode/web dev   # http://localhost:5273
pnpm --filter @crosscode/web build # tsc --noEmit + vite build
pnpm --filter @crosscode/web test  # jsdom 组件测试
pnpm test                    # 仓库根：所有包测试一条命令全绿（vitest.workspace.ts）
```

## 连接 daemon

- 开发服务器默认端口 **5273**，并把 `/api`（REST，去掉前缀）与 `/ws`（WebSocket 升级）代理到 daemon。
- daemon 目标地址默认 `http://127.0.0.1:4610`，可通过环境变量覆盖（优先级：`CROSSCODE_DAEMON_URL` > `VITE_DAEMON_URL` > 默认值；`.env` 文件同样生效）。
- 无地址（同源）时 REST 走 `/api/**` 代理；配置了地址时直连该 origin。

### 配对流程

未配对/断线时展示 PIN 配对界面：输入 daemon 显示的 6 位 PIN → `POST /pair` → 得到 HS256 JWT（30 天）→ 存入 `localStorage`（key: `crosscode.gateway.jwt`）→ `GET /projects|/providers|/skills` 预热 → 连接 `WS /ws/session?projectPath=…` 并以 `{type:"auth", token}` 鉴权。JWT 被拒（WS close 4001）会回到配对界面。

### 协议对接摘要

| 方向 | 内容 |
| --- | --- |
| 下行 | `UnifiedStreamEvent` 全量 8 种（thinking/text delta、tool_call_start/result、file_change、normalized_error、harness_switched、screen_frame）+ `approval_request` / `approval_resolved` / `session_attached` / `provider_switched` / `auth_ok` / `error` |
| 上行 | `auth` / `approve` / `reject` / `send_prompt` / `switch_provider` |
| REST | `/pair`、`/projects`、`/providers`、`/projects/:id/harness`、`/projects/:id/provider`、`/projects/:id/diff(+/accept|/discard)`、`/skills (GET/PUT)` |

## 离线演示模式

daemon 未启动时自动静默降级（REST 探测失败或 WS 重连耗尽），内置 mock 数据可完整浏览所有 UI，包含一条 `CC-QUOTA-2002` 自愈错误事件、待审批卡与 screen_frame 画面。强制进入：`VITE_DEMO=1`；配对界面也有手动入口。演示模式下发送提示词会得到回声回复。

## 布局与设计语言

- 工业碳素黑：主背景 `#0A0A0C`、面板 `#111114`、1px 结构分割线 `rgba(255,255,255,0.065)`，4px 微圆角，无渐变光晕。
- Harness 标识色：CrossCode `#e4e4e7`、Claude Code `#d97757`、OpenCode `#38bdf8`、Codex `#10b981`、DeepSeek `#60a5fa`、Qoder `#f43f5e`、ZCode `#f59e0b`。
- 桌面三栏布局（工作区 / 事件流 / 检视器），顶栏可分别收起；`Ctrl/Cmd+K` 命令面板；顶部自愈横幅按 `recoveryAction` 一键处置。
- 事件流采用纵向文档流（非聊天气泡）：用户指令左侧亮边标识，思考折叠为单行，工具调用与文件变更使用紧凑等宽行。
- 移动端（<768px）：单栏 + 底部导航 + 抽屉式切换器（Harness/Provider/模式）。
- 空态、加载骨架、断线重连横幅、离线演示徽标均有对应 UI。

## 目录结构

```
src/
  api/        REST client（pair/JWT、projects、harness/provider、skills、diff）+ WS 会话客户端（鉴权/重连/事件解析/审批上行）
  store/      Zustand：连接状态、项目矩阵、会话事件流（timeline 折叠）、approvals、skills、diff、演示数据
  lib/        设计工具（harness 品牌色、相对时间、diff 解析、轻量 markdown、引导/配对流程）
  components/ SidebarProjectMatrix · TopSwitchboardBar · UnifiedAgentStream · ToolCallStepCard
              InspectorRightPane · CommandPalette · ErrorSelfHealBanner · MobileNav
tests/        jsdom + @testing-library/react：WS 事件解析、审批上行、自愈横幅映射、命令面板键盘导航
```
