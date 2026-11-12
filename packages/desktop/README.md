# @crosscode/desktop — CrossCode 桌面端

托盘常驻的 Electron 外壳，把本地 daemon 与工作台打成一个可安装应用。

## 职责

| 能力 | 实现 |
| :--- | :--- |
| 内置 daemon | 主进程内 `startDaemonRuntime()` 启动 `@crosscode/daemon` 网关，用户无需安装 Node，也无需手动开终端 |
| 单源托管 | daemon 同时托管工作台构建产物（`/api/**` 前缀重写 + `/ws/session`），无 CORS、无代理 |
| 自动配对 | 首次启动生成并持久化 JWT 密钥与 PIN，自签 JWT 后通过 `?token=` 交给渲染进程，桌面端不弹配对框 |
| 托盘常驻 | 关窗仅隐藏；托盘菜单含打开窗口、浏览器打开、复制 PIN、开机自启、退出 |
| 原生审批通知 | daemon 收到 `requiresApproval` 工具调用 → 系统通知，点击直达工作台 |
| 全局快捷键 | `Alt+Shift+C` 唤起命令面板（可在 `main.ts` 的 `GLOBAL_PALETTE_SHORTCUT` 调整） |
| 安全边界 | `contextIsolation` + `sandbox` + 无 `nodeIntegration`；仅暴露 3 个能力的最小 preload 桥；外链一律交给系统浏览器 |

## 命令

```bash
pnpm install                                  # 根目录执行一次
pnpm --filter @crosscode/web build            # 先构建工作台（desktop package 会用到）
pnpm --filter @crosscode/desktop dev          # 构建主进程并启动 Electron（开发）
pnpm --filter @crosscode/desktop smoke        # 无窗口自检：daemon 启动、SPA/资源/API 前缀/鉴权
pnpm --filter @crosscode/desktop smoke:window # 真实渲染进程自检：preload 桥 + 页面加载
pnpm --filter @crosscode/desktop package      # 生成便携版 release/CrossCode/CrossCode.exe
pnpm --filter @crosscode/desktop installer    # 在便携版基础上产出 NSIS 安装包
```

根目录快捷命令：`pnpm desktop`（开发启动）、`pnpm desktop:dist`（构建工作台 + 便携版）。

## 环境变量

| 变量 | 说明 |
| :--- | :--- |
| `CROSSCODE_PORT` | daemon 监听端口，默认 `4610`；被占用时自动往后顺延最多 12 个端口 |
| `CROSSCODE_WORKSPACES` | 项目扫描根目录，多个用系统路径分隔符（Windows 为 `;`）拼接；默认 `~/cs`、`~/projects`、`~` |
| `CROSSCODE_WEB_DIST` | 覆盖工作台构建目录（默认自动探测打包后的 `resources/web`） |

## 打包说明

- `scripts/package.mjs` 直接复制已解压的 Electron 运行时（跳过 `default_app.asar`），把应用放进 `resources/app`、工作台放进 `resources/web`。这样避开了 electron-builder 在部分 Windows 机器上删除 `default_app.asar` 时遇到的 `EBUSY`（杀毒/索引服务持有句柄）。
- `scripts/installer.mjs` 用 `electron-builder --prepackaged` 基于上述目录生成 NSIS 安装包，不再重新解压 Electron。
- 图标由 `scripts/make-icons.mjs` 用代码生成（PNG 编码器自带），不依赖任何图像库，产物在 `build/`（已 gitignore，构建时自动补齐）。
- 未配置代码签名证书，安装包未签名；如需分发可设置 `CSC_LINK` / `CSC_KEY_PASSWORD`。

## 目录结构

```
src/
  main.ts           Electron 主进程：窗口、托盘、全局快捷键、通知、单实例锁
  daemon-runtime.ts 启动网关 + 静态托管 + 自签 JWT + 端口回退 + 配置持久化
  preload.ts        最小 contextBridge（3 个能力）
scripts/
  build.mjs         esbuild 打包 main/preload
  package.mjs       便携版输出（不重新解压 Electron）
  installer.mjs     NSIS 安装包
  make-icons.mjs    零依赖图标生成（含 PNG 编码）
```
