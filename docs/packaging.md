# 打包与分发

M2 的分发目标是：没装 Node、npm 的测试同学拿到一个目录包就能用——doctor、录制、工作台、回放、报告都在包内完成，不读仓库目录。

## 范围与边界

- 只做 **未签名 / ad-hoc** 的 macOS 目录包。本机没有 Developer ID 签名身份，Gatekeeper 首次打开方式写在安装说明里。
- 不做自动更新服务；升级是覆盖安装。
- 不打包 `agent-desktop`，只检测版本并提示安装。它是外部二进制，Cuekeeper 锁定 **1.3.1**，版本不符会拒绝执行。
- 不改业务逻辑与 schema；打包只改变产物的物理布局和入口。

## 产物形态

选「固定目录 + 启动脚本 + 内置 Node 运行时」，不做 Node SEA 单文件。原因：SEA 单文件需要额外打包器把多文件 ESM 编译成一个脚本，仓库现有工具链只有 `tsc`，离线环境无法新增依赖；目录包可以直接复用 `dist/`、`workbench/` 和预编译录制器。

```
cuekeeper-<version>-macos-<arch>/
  bin/cuekeeper             # POSIX sh 启动脚本，exec 包内 runtime
  lib/
    dist/                   # tsc 产物 dist/cli.js 等
    dist/cuekeeper-capture  # 预编译录制器（ad-hoc 签名）
    workbench/              # index.html、app.js、style.css 等静态资源
    node_modules/           # 运行时依赖闭包：@sinclair/typebox、fflate
    package.json            # 版本回退来源
    build-info.json         # 版本、提交、架构、构建时间、Node 版本
  runtime/node              # 内置 Node 运行时
  manifest.json             # 每个文件的长度与 SHA-256
  README.md
  LICENSE
```

`workbench` 的读取路径是 `new URL('../workbench/', import.meta.url)`：源码布局落在仓库根，打包布局落在 `lib/workbench`。两种布局都不依赖当前工作目录。

## 构建

```sh
npm run package
# 等价于 node scripts/package.mjs
```

一条命令依次执行 `npm run build`、`sh scripts/build-recorder.sh`、组装目录、生成 `manifest.json`、打 `tar.gz`、写 `.sha256` 与发布说明。参数：

| 参数 | 用途 |
| --- | --- |
| `--out <dir>` | 输出目录，默认 `release/` |
| `--version <x.y.z>` | 覆盖产物版本；默认取 `package.json` |
| `--node <path>` | 内置的 Node 运行时，默认当前 `process.execPath` |
| `--skip-build` | 复用已有 `dist/`，不跑 `npm run build` |
| `--skip-recorder` | 复用已有 `dist/cuekeeper-capture` |
| `--allow-missing-recorder` | 允许产物缺录制器（仅用于离线检查，不作为发布产物） |
| `--no-archive` | 只产出目录与 `manifest.json`，不压缩 |
| `--json` | 输出单行 JSON 摘要 |

构建产物：

```
release/
  cuekeeper-<version>-macos-<arch>/         # 可直接运行的目录
  cuekeeper-<version>-macos-<arch>.tar.gz   # 分发包
  cuekeeper-<version>-macos-<arch>.tar.gz.sha256
  cuekeeper-<version>-RELEASE.md            # 版本、sha256、安装/升级/卸载
```

`manifest.json` 与 `.sha256` 是两级校验：前者覆盖解包后的每个文件，后者覆盖下载到的压缩包。发布说明同时写版本号与压缩包 SHA-256。

CI 在 `macos-latest` 的现有 job 里复用已构建的 `dist/` 与录制器打包，只做冒烟检查（`--version`、`flow validate`）并上传未签名产物；CI 不执行录制或回放，也不申请系统权限。

## 版本与命名

- 版本来源：`package.json` 的 `version`，可用 `--version` 覆盖；发布说明与 `lib/build-info.json` 使用同一值。
- 产物命名：`cuekeeper-<version>-macos-<arch>.tar.gz`，`arch` 取 Node 的 `arm64` / `x64`。
- `cuekeeper --version` 输出 `cuekeeper <version>`；发布包还带短提交，如 `cuekeeper 0.1.0 (2c2bd3e)`。
- 发布前先把版本号改到 `package.json` 并提交，再打包；`RELEASE.md` 与 `.sha256` 不要手工改。

## 安装、升级与卸载

```sh
shasum -a 256 -c cuekeeper-<version>-macos-<arch>.tar.gz.sha256
mkdir -p ~/Applications
tar -xzf cuekeeper-<version>-macos-<arch>.tar.gz -C ~/Applications
ln -sf ~/Applications/cuekeeper-<version>-macos-<arch>/bin/cuekeeper /usr/local/bin/cuekeeper  # 可选
cuekeeper doctor
```

- **Gatekeeper**：产物未签名、未公证。首次运行被拦截时右击 → 打开，或在「系统设置 → 隐私与安全性」选择「仍要打开」；也可 `xattr -dr com.apple.quarantine <安装目录>`。不要用 `sudo` 安装。
- **升级**：解到同一路径覆盖安装。路径不变时，macOS 更容易沿用录制器的权限授权；换路径、重新编译录制器都会改变 ad-hoc 身份（cdhash），需要重新授权。
- **卸载**：删除安装目录。行为库在 `~/.cuekeeper/behaviors`，日志与报告在用户自己指定的运行目录，都不会自动清理。
- 没有自动更新服务，也不写 LaunchAgent / 守护进程。

## 依赖处理

| 依赖 | 决策 | 原因 |
| --- | --- | --- |
| Node 运行时 | 随包：`runtime/node` | 目标用户没有 Node；固定运行时避免版本漂移 |
| `@sinclair/typebox`、`fflate` | 随包：`lib/node_modules` | 运行时必需，按依赖闭包复制，不放入 devDependencies |
| `agent-desktop` | 不随包，`doctor` 检测 1.3.1 | 外部二进制、独立分发；版本由 Cuekeeper 严格锁定，混入旧版会破坏回放契约 |
| Swift 录制器 | 构建时编译并随包 | 目标用户没有 Xcode / `swiftc` |

需要覆盖路径做排查时可用环境变量：`CUEKEEPER_AGENT_DESKTOP` 指向 agent-desktop 可执行文件，`CUEKEEPER_RECORDER` 指向录制器。两者都只影响本进程，不写配置。

## 权限、签名与首次引导

录制需要 **输入监控**（CGEventTap 监听）和 **辅助功能**（读取 AX 树与热键）。权限归属是发起请求的二进制，也就是包内的 `lib/dist/cuekeeper-capture`：

- 授权入口：
  - 辅助功能 `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
  - 输入监控 `x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent`
- `doctor` 只打印这两个入口，不打开、不代点、不修改系统设置。录制器用 `--permissions` 做只读预检（`AXIsProcessTrusted` / `CGPreflightListenEventAccess`），不会弹框。
- 重新编译录制器或覆盖安装后，ad-hoc cdhash 变化会被系统当成陌生程序，需要重新授权。分发时保持路径稳定，升级前提醒测试同学准备重新授权。
- 正式签名与公证需要 Developer ID 证书，另开单处理；本单只保证未签名包可用。

## `cuekeeper doctor`

只读检查，不开窗口、不占桌面、不申请权限：

| 检查 | 判定 |
| --- | --- |
| `platform` | 必须 macOS；其他平台后续检查标为 skip |
| `runtime` | Node 主版本 ≥ 22 |
| `files` | `dist/cli.js` 与 6 个 workbench 文件存在且非空 |
| `agent-desktop` | 能执行 `version`，版本等于 1.3.1 |
| `recorder` | 录制器存在且可执行 |
| `accessibility` | 录制器预检辅助功能 |
| `input monitoring` | 录制器预检输入监控 |

输出是可复制的纯文本；`--json` 返回同样的结构化结果（`checks[]`、`nextSteps[]`）。退出码 `0` 全部通过，`1` 有检查失败，`2` 参数或运行错误。

本机一次完整输出（节选）：

```text
cuekeeper 0.1.0 · darwin arm64 · node 25.2.1
install root: /Applications/cuekeeper-0.1.0-macos-arm64/lib/

[ok  ] platform         macOS 27.0.0 (darwin, arm64)
[ok  ] runtime          node 25.2.1 (>= 22 required)
[ok  ] files            dist/cli.js and 6 workbench files under /Applications/…/lib/
[ok  ] agent-desktop    1.3.1 (agent-desktop)
[ok  ] recorder         /Applications/…/lib/dist/cuekeeper-capture
[ok  ] accessibility    granted for the recorder
[ok  ] input monitoring granted for the recorder

Result: ready
```

`record` 在调用 agent-desktop 之前跑同一套录制器预检。录制器缺失、不可执行或权限未授予时以退出码 `2` 结束，错误码分别是 `RECORDER_MISSING`、`RECORDER_UNUSABLE`、`PERMISSIONS_REQUIRED`，并附系统设置入口；不会出现“先启动录制、再弹出权限框”的中间态。预检无法判定权限（例如录制器输出异常）时继续录制，由录制器自身报错，保持原有错误路径。

## macOS App 外壳（CueKeeper.app）

现有引擎和工作台保持不变；App 只加一层原生外壳：

```sh
npm run app:package
# 产物：
#   release/CueKeeper.app
#   release/CueKeeper-<version>-macos-<arch>.zip
#   release/CueKeeper-<version>-macos-<arch>.zip.sha256
```

- 外壳：Rust + Tauri 2，macOS 用系统 WKWebView 加载本地工作台，不是 Electron。
- 包内：`Contents/Resources/cuekeeper/` 放 `runtime/node`、`lib/dist`（含录制器）、`lib/workbench`；启动时由 Rust 启动 Node 工作台并加载 `http://127.0.0.1:17899`。
- 权限：首次启动由 App 调用 `AXIsProcessTrustedWithOptions` 和 `IOHIDRequestAccess`，系统会把 **CueKeeper** 加入「辅助功能 / 输入监控」并弹窗。录制器是 App 的子进程，继承 App 的 TCC 授权。
- 引导：App 模式下的 `GET /api/record/health` 返回 `appPath`，工作台引导显示「应用」和 `CueKeeper.app`，不再让用户去 Finder 找裸二进制。
- 生命周期：退出 App 时向 Node 进程组发 `SIGTERM`，让正在录制的 helper 有机会收尾。
- 日志：`~/Library/Logs/com.cuekeeper.app/workbench.log`；菜单「视图 → 打开日志目录」。
- 权限请求只会在每次安装后的首次启动自动发起一次；之后用引导或菜单「请求录制权限」，不会每次启动都弹。
- 引导同时列出 CueKeeper 和内置录制器；如果 macOS 只在辅助功能里列出录制器，用该行的「显示」直接定位 `cuekeeper-capture` 再添加。
- App 启动 Node 前会把 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 和内置 Node 运行时加入 PATH，并设置 `CUEKEEPER_AGENT_DESKTOP`；因此 LaunchServices 的极简 PATH 不会再导致 agent-desktop 缺失。
- App 自己的权限探测结果追加写入 `~/Library/Logs/com.cuekeeper.app/app.log`；工作台健康检查仍以录制器为准。

构建要求：Rust 1.77+（`cargo` 在 PATH 或在 `~/.cargo/bin`）、macOS、Node 22+。参数与目录包类似：`--skip-build`、`--skip-recorder`、`--skip-rust`、`--no-sign`、`--no-zip`、`--out`、`--version`。

图标按 Apple 的 1024 pt macOS 模板绘制：824 pt 圆角方、100 pt 透明边、185.4 pt 圆角，PNG 四周透明，不会出现白底。需要改图标时运行 `npm run app:icon`，它会调用 `desktop/icons/make-icon.swift` 并重新生成 `icon.png`/`icon.icns`。

首次打开：ad-hoc 签名未公证；若 Gatekeeper 拦截，右键 → 打开。安装建议把 App 放到 `~/Applications` 或 `/Applications` 后再授权，移动 App 会被 macOS 视为新位置。

签名边界：ad-hoc 签名的授权跟 cdhash 走，重新构建 App 本体后可能需要重新授权；重新编译录制器不需要，因为 TCC 授权在 App 上。正式分发需要 Developer ID + 公证。

已知限制：首次启动固定使用 17899；如果命令行工作台已占用该端口，App 会拒绝启动并在加载页显示日志路径。App 暂未实现自动更新。

## 已知限制

- 未签名、未公证：Gatekeeper 需要用户手动放行一次；企业分发、自动更新不在本单。
- 产物体积由内置 Node 运行时决定（约 70 MB 解包前、压缩后约 30 MB）。
- 重新编译录制器会导致重新授权；若后续加 Developer ID，应改为稳定签名身份。
- 需要真机验收的项（干净 macOS 用户走 doctor → 录制 → 工作台 → 回放 → 报告、Gatekeeper 首次打开、覆盖安装后的权限行为）登记在 HAOC-76，不在夜间离线任务里执行。
- Windows 分发未开始，口径见 [Windows 平台](windows.md)。

## macOS App 外壳

`CueKeeper.app` 是现有工作台的原生外壳：界面和引擎不变，App 只负责窗口、内置运行时、进程生命周期和 macOS 权限入口。它使用 Rust/Tauri 2 和系统 WebView，不引入 Electron。

```
CueKeeper.app/Contents/
  Info.plist
  MacOS/CueKeeper            # Rust 外壳
  Resources/AppIcon.icns
  Resources/cuekeeper/       # 目录发布包
    runtime/node
    lib/dist/                # CLI、录制器、原生辅助二进制
    lib/workbench/           # 现有工作台
```

### 构建

前置：macOS、Node 22+、Rust（`cargo` 在 PATH，或 `~/.cargo/bin/cargo`）。

```sh
npm run app:package
# 等价于 node scripts/package-app.mjs

open release/CueKeeper.app
```

产物：

```
release/
  CueKeeper.app
  CueKeeper-<version>-macos-<arch>.zip
  CueKeeper-<version>-macos-<arch>.zip.sha256
  CueKeeper-<version>-RELEASE.md
```

常用选项：

| 参数 | 用途 |
| --- | --- |
| `--skip-build` | 复用已有 `dist/` |
| `--skip-recorder` | 复用已有 `dist/cuekeeper-capture` |
| `--skip-rust` | 复用 `desktop/target/release/CueKeeper` |
| `--no-sign` | 不执行 ad-hoc codesign（仅调试） |
| `--no-zip` | 只产出 `.app` |
| `--json` | 输出单行 JSON 摘要 |

### 运行行为

- App 启动 `runtime/node lib/dist/cli.js workbench --port 17899`，窗口加载 `http://127.0.0.1:17899`。
- 关闭 App 会结束 Node 进程组，录制器随工作台一起停止。
- 首次启动由 Rust 调用 `AXIsProcessTrustedWithOptions` 和 `IOHIDRequestAccess`，把 **CueKeeper** 加入「辅助功能 / 输入监控」并弹窗。
- `cuekeeper-capture` 是 App 的子进程，macOS 按 App 的责任进程判定授权；因此重建录制器不需要重新授权。
- 工作台健康检查会把授权对象显示为 App；`使用引导`中的“应用”行可直接在 Finder 中定位 App。
- 日志：`~/Library/Logs/com.cuekeeper.app/workbench.log`；菜单「视图 → 打开日志目录」可直接打开。

### 签名与分发

当前只做 ad-hoc 签名，没有 Developer ID 和公证：

- 首次打开可能需要右键 App →「打开」，或在「系统设置 → 隐私与安全性」选择「仍要打开」。
- 重新构建 App 本体后，ad-hoc 签名变化，macOS 可能要求重新授权。
- 正式分发需要 Developer ID 签名、公证和稳定 bundle identity；届时 App 更新可以沿用授权。

App 使用固定端口 17899，便于工作台 `localStorage` 保持稳定。若端口被命令行工作台占用，App 会在启动页显示日志路径并退出，不会静默换端口。

`npm test` 中的 `test/app-bundle.test.mjs` 只检查 App 目录、Info.plist 和资源布局；Rust/Tauri 编译需要本机工具链，当前不在 CI 的快速 job 中执行。
