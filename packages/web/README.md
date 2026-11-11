# @crosscode/web — CrossCode 前端工作台

博采众长的高颜值响应式 Agent 工作台（Task 8）。React 19 + Vite 6 + Tailwind CSS v4 + Zustand 5 + lucide-react，深度对接 daemon 网关（`http-ws-gateway.ts`）的 REST 与 WebSocket 协议。

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

- 深邃曜石黑：主背景 `#090A0F`、面板 `#11131C`、1px 微高光边框 `rgba(255,255,255,0.07)`，精致圆角 + 内阴影；代码/日志等宽字体。
- Harness 品牌呼吸灯：CrossCode 极光紫 `#8b5cf6`、Claude 琥珀橙 `#d97757`、OpenCode 冰川青 `#22d3ee`、Codex 翡翠绿 `#10b981`、DeepSeek 深海蓝 `#3b82f6`、Qoder 玫红 `#e11d48`、ZCode 日晖橙 `#f59e0b`。
- 桌面三栏 IDE 布局（项目矩阵 / 统一事件流 / 三合一检视器），顶栏可分别收起；`Ctrl/Cmd+K` 命令面板；顶部自愈横幅按 `recoveryAction` 一键处置。
- 移动端（<768px）：单栏 + 底部大拇指导航 + 抽屉式切换器（Harness/Provider/模式）。
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
