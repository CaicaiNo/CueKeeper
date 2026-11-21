# Windows 首版（W1）范围决策与实施拆分

HAOC-74 在 [Windows 适配可行性与驱动边界](windows.md)（HAOC-67）之上给出范围决策：Windows 首版做哪些命令、驱动与录制各做到哪一步、怎么验收。

**本轮在 Windows 上执行过的命令数：0。** 本机是 macOS，所有 Windows 行为结论来自上游文档/探针与仓库代码阅读，逐条标注「代码事实 / 上游证据 / 推断 / 需实机」。这里没有一条 Windows 实测结论，也不把 macOS 上的离线回归当作 Windows 已验证。

## 1. 决策摘要

1. **回放先行，录制后置。** W1 = 在 Windows 上手工写/拾取 flow，并对已打开的目标应用回放；`record` 不在 W1，登记为 W2（见 §6 T3）。
2. **目标必须已运行、窗口已存在。** 不启动应用、不自动恢复最小化、不做前置条件修复；失败即阻塞，并给出人工操作提示。
3. **W1 的实时回放必须显式 `--headed`。** Windows 无头 `type` 返回 `POLICY_DENIED`；`run`/批量在 win32 上缺少 `--headed` 时直接报 `HEADED_REQUIRED`，不静默切换模式。
4. **不引入 Windows CI。** 离线分支在 macOS CI 用注入平台测；真实行为只在 T2 实机验收（HAOC-76）。
5. **flow 不跨平台迁移。** 应用标识、键名、坐标、UI 文案都按平台不同；跨平台只共享 schema、报告包与查看器。
6. **报告与查看器是跨平台的。** 归档条目名规范化为 `/`、ZIP 使用固定时间戳，查看器是自包含静态页（代码事实，见 §7.6）。
7. **W1 只支持 legacy 目标。** `flow.target` 用 `target.app`（镜像名）定位，不带 `target.appPath`；路径固定身份的实现只对 darwin 开放（`src/app-identity.ts:269`），Windows 路径绑定后续再议。

录制后置的三个理由：录制桥是独立原生工程（钩子 + HUD + 热键）；Windows 没有 macOS `IsSecureEventInputEnabled` 的对应物，密码输入无法在采集源头屏蔽；`LowLevelHooksTimeout` 静默移除、`WDA_EXCLUDEFROMCAPTURE` 版本差异都必须实机才能确认。先交付可验证的回放，录制等 W1 通过后再开。

## 2. 能力范围

| 能力 | W1 | 条件与依据 | 验收方式 |
| --- | --- | --- | --- |
| `flow validate`、`report pack`、viewer | **支持** | 纯 Node，无平台分支（`src/cli.ts:113`、`:393`） | 离线 |
| `run --dry-run --snapshot`、`pick --snapshot` | **支持** | 离线夹具路径，与平台无关 | 离线 |
| `pick`（实时） | **支持** | 只读快照，不点击不聚焦；依赖 T1 快照预算 | 实机 |
| `run --dry-run`（实时） | **支持** | 读 UIA 树解析定位器；不发送输入 | 实机 |
| `run --headed` | **支持（核心）** | 元素定位的 click/type/key；承诺 ASCII 文本（非 ASCII 未验证）；目标窗口标题在一次运行中必须保持不变，标题是否真的漂移由 T2 实测（§7.1）；`delivered_unverified` 按现有语义接受，效果由断言或文件核对证明 | 实机 |
| `run --data`（批量） | **支持** | 复用 run 的每条约束 | 实机 |
| 断言：element `exists`/`visible`/`text`/`value`、window `exists`/`title` | **支持** | 走同一 UIA 读路径；`text`/`value` 能否从目标控件读回由 T2 实测，读不到记 `PROPERTY_UNAVAILABLE`，不影响 `exists`/`visible`/`title` 门禁 | 实机 |
| 断言：window `screenshot` | **不做** | 上游 v1.3.1 Windows 文档把 `screenshot` 列为无头可用的观察命令，但 CueKeeper 的截图断言整条链路（采集 → 基线 → 区域比对 → 报告证据 → 跨平台基线）在 Windows 上没有验收证据；计划阶段直接拒绝，T2 单独记录子命令结果后再决定何时放开 | 实机 |
| `workbench` | **有限** | 打开运行目录、时间线、编辑、离线 dry-run（目录需有 `snapshot.json`）、报告查看可用；应用目录与实时回放不可用（`src/app-catalog.ts` 只用 `system_profiler`/`mdls`；`src/workbench.ts:112` 已把 live 限定 darwin） | 离线 + 实机 |
| `setup.ensure` | **有限** | 检查照常执行；win32 不提供修复（不启动、不聚焦）。未通过时 `ensure` 直接报 `ENSURE_FAILED`，提示手动打开目标窗口 | 实机 |
| `target.appPath`（路径身份） | **不做** | 实现与 `native/app-identity.swift` 均为 macOS 专用，win32 实时 `preflight` 直接 `UNSUPPORTED_PLATFORM`（`src/app-identity.ts:269`）；离线读取仍可 | 离线 + 实机 |
| `point` 点击 | **有限** | 必须 `--headed`；物理像素；只保证同机同缩放；优先用 ref | 实机 |
| 报告上传（HAOC-73，已合入） | **支持** | `report upload` 与队列是纯 Node（`src/cli.ts:430`、`src/upload.ts`），无平台分支；T2 附带核对一次 | 实机 |
| `record` | **不做（W2）** | 见 §1、§4 | — |
| shell 步骤 | **不做** | 实现基于 POSIX `sh` 固定 PATH 与 sudo/sudoers（`src/shell.ts`），win32 无对应。门禁按入口分开（§3.3）：win32 非 dry-run 运行在计划阶段拒绝；`--dry-run` 只预览不执行，允许；批量与 `report pack` 在现有代码里本来就拒绝含 shell 定义的 flow | 离线 + 实机 |
| `doctor` | **不做** | 现状把平台检查固定为 macOS（`src/doctor.ts:239`），Windows 上 `platform` 一项必然 fail；不影响 live 命令，W1 文档写明。补 win32 检查另开 | 离线 |
| UWP/Store 应用、IME/中文、拖拽/滚轮/多窗口、锁屏/Session 0/其他用户、sandbox/held input/menubar、Windows CI、跨平台 flow 迁移 | **不做** | [Windows 适配](windows.md) §10 已列；W1 不重新评估 | — |

为什么 workbench 不开实时回放：录制的采集桥与回放共用 agent-desktop 的独占交互租约，同一时刻只能有一个 live 命令；工作台内再叠一层前端驱动，收益低、失败面大。W1 的工作台只用于整理与看报告，live 操作走 CLI。

为什么不让 `ensure` 启动应用：Windows 上 `--app`（`list-apps`/`list-windows`）收的是镜像名，而 `launch` 收绝对路径或 System32/Windows 裸名，一个字符串服务不了两个用途（[Windows 适配](windows.md) §4.6）。W1 不改 schema、不引入路径约定，直接要求目标已打开。

## 3. 驱动方案

### 3.1 抽象结论

`Desktop` 现在有 13 个方法；W1 只走 legacy 路线（`target.app` 名字匹配，不传 `appPath`），因此实际依赖的是 `snapshot`/`property`/`ensure`/`click`/`clickPoint`/`type`/`press`/`listWindows`/`listAllWindows` 这一组，**不拆接口、不改现有签名**。`snapshotWindow`/`focusWindow`/`screenshotWindow` 只服务路径固定流程（W1 不做）；`screenshot` 上游在 Windows 上可用（§2 截图行），但 CueKeeper 的截图断言链路未验收，W1 不用它。缺的是三个"跑之前必须先确认"的能力，W1 把它做成 `withDesktop` 内部行为，只新增一个可选预检方法，并给窗口清单补一个只读字段：

| 缺口 | W1 做法 | 不做的后果 |
| --- | --- | --- |
| 窗口是否最小化 | 快照后检查窗口根 `bounds`；缺失或零宽高即阻塞 | 最小化的窗口读得到、语义 click "成功"、实际什么都没发生（假通过） |
| 目标是否在前台 | 仅当本轮会发送输入时，`focus-window` 一次 + 1.5 s 轮询 `is_focused`；运行中每次物理输入前再确认一次 | 前台锁导致 `focus-window` 失败后仍然键入，输入落到别的窗口 |
| provider 是否可执行 | win32 必须用 `CUEKEEPER_AGENT_DESKTOP` 指向原生 exe | `execFile` 拉不到 npm 的 `.cmd` shim，所有 live 命令直接不可用 |

UIA 与 agent-desktop 的边界：树读取、定位、动作全部经 agent-desktop；Node 侧不直接调 UIA/COM，W1 不新增任何原生代码。平台差异只体现在"传哪些参数、怎么解释错误、什么时候拒绝执行"。

#### 3.1.1 预检绑定的窗口怎么传到后续调用

W1 的绑定不是"记住标题、每次让驱动重新找"，而是把预检得到的 `windowId` 当作本轮运行的身份，显式传给后续每一次窗口读取与定向动作。现状与 W1 要求逐项对应：

| 调用 | 现状（代码事实） | W1 要求 |
| --- | --- | --- |
| `snapshot`（普通读取） | `src/run.ts:227` 只在 `exactWindow` 为真时把已选 ID 传下去；普通读取在 `src/run.ts:243` 传 `undefined`，驱动每次按 app + title 重新选窗 | win32 实时 legacy 运行把预检 ID 作为默认 `selected` 传给 `snapshot`，argv 恒带 `--window-id`；驱动返回的 ID 不是它 → `WINDOW_CHANGED`。这样"预检成功"与"后续动作作用在同一窗口"才是同一件可验证的事 |
| `press` | 已带 `--window-id`（`src/desktop.ts:297`） | 不变 |
| `click` / `type` | 只传 ref（`src/desktop.ts:283`、`:296`），没有窗口参数 | ref 只能取自绑定窗口的最新快照；动作前必须确认焦点仍在绑定窗口，否则零输入。ref 是否跨 driver 子进程有效属上游契约，T2 用连续动作验证 |
| `clickPoint` | `src/desktop.ts:284` 自己 `focus-window`，随后不带 ID 重取快照 | win32 改为使用 `current.windowId`：先确认焦点，再按该 ID 取快照并校验 ID，最后 `mouse-click --xy`；不自行把窗口切到前台，焦点不确认就零输入 |
| `ensure(window_ready)` | 用 `focused.id` 断言 | win32 `ensure` 不提供修复，直接 `ENSURE_FAILED`（§3.2），不走这条路径 |

**任何物理输入之前的焦点判据**：`listWindows(target.app)` 里绑定 `windowId` 的窗口存在且 `is_focused === true`；不成立就报 `WINDOW_FOCUS_UNCONFIRMED`，本轮不发出任何 `click`/`type`/`press`/`mouse-click`。"快照后目标被别的窗口盖住"也走这条判据——物理输入进入前台窗口，不进入快照里的窗口。运行中不做第二次 `focus-window` 抢前台：确认不了就停，不替用户切换窗口。

**串行前提**：一次只跑一个 live 命令；批量在单进程内按行串行。W1 不实现自己的锁。上游的独占交互租约是**每次子进程调用**的租约，不能证明覆盖 CueKeeper 一整轮多调用运行（每次 driver 调用都是新的子进程），所以不能拿它替代"同一时刻只跑一个 live 命令"这个人工前提；两个终端同时跑时冲突错误原样透出，不重试。

### 3.2 文件级改动（W1）

| 文件 | 改动 | 离线验收 |
| --- | --- | --- |
| `src/desktop.ts:78` | provider 解析：win32 只接受 `CUEKEEPER_AGENT_DESKTOP` 指向的原生 exe；未设置或不是文件 → `DESKTOP_DEPENDENCY`（退出码 2）并给出设置示例。**不退回 `shell: true`**：`flow.target.app` 是自由字符串，会被 cmd 解释 | stub 环境断言错误的退出码与消息 |
| `src/desktop.ts:296` | `type` 在 win32 恒带 `--headed`，文本继续走 `--stdin`（不进命令行） | 断言参数数组 |
| `src/desktop.ts:40` | `PERM_DENIED` / `ACCESS_DENIED` / `PLATFORM_NOT_SUPPORTED` 标为依赖错误（退出码 2）；`POLICY_DENIED` 保持退出码 1，消息写明"被策略拒绝"而不是"依赖缺失" | 逐码断言 |
| `src/desktop.ts:142` | win32 快照预算：首读 ≥8000 ms；`INCOMPLETE_TREE` / `identity_unproven` 用 20000 ms 重试一次，仍失败即失败 | 断言只重试一次且第二次预算 |
| `src/desktop.ts:10` | `WindowInfo` 增加可选 `isFocused?: boolean`，从驱动 `list-windows` 的 `is_focused` 映射；缺字段视为未知（不当作 true） | stub 返回 true/false/缺失三种断言 |
| `src/desktop.ts:54` | 窗口清单已由 HAOC-80 带上可选 `process_instance`。W1 在 win32 上不依赖它：驱动是否返回未验证（§8 第 13 条），没有它时仍按 `id + title` 绑定，长会话按 R5 重录 | 无 |
| `src/desktop.ts`（新增可选方法） | `preflight(target, { needsInput })`：`findWindow` → 按 ID 取首个快照 → 最小化检查 → 需要输入时 `focus-window` 一次 + 1.5 s 轮询 `is_focused` → 返回 `{ snapshot, windowId }`。`WINDOW_MINIMIZED`、`WINDOW_FOCUS_UNCONFIRMED` 都在任何动作之前抛出 | 最小化 / 未聚焦 fixture 断言零动作，且返回的 ID 被后续调用使用 |
| `src/desktop.ts:183` | win32 `ensure` 不启动、不聚焦：返回明确错误（报告 `ENSURE_FAILED`，非依赖退出码），提示手动打开目标窗口 | 断言未调用 `launch`/`focus-window` |
| `src/desktop.ts:284` | `clickPoint` 在 win32 走 §3.1.1 的绑定路径：不自行聚焦，焦点不确认即零输入，快照必须返回同一 ID | 断言调用顺序与零 `mouse-click` |
| `src/cli.ts:69` | `macOnly()` 改为按命令判断能力：`pick`/`run`/批量允许 darwin + win32；`record` 仍 darwin-only，消息指向 W2 | 断言各命令的平台门 |
| `src/cli.ts:134` | `--app` 校验分平台（含 `--snapshot` 离线分支，它先于实时平台门）：win32 接受 `list-apps` 名字（可含空格与点，如 `notepad.exe`），拒绝路径分隔符、控制字符、首尾空白、`.`/`..`；macOS 保持 bundle ID 正则 | 新旧两份用例 |
| `src/cli.ts:196` | win32 的 `run`/批量：非 dry-run 且缺 `--headed` → `HEADED_REQUIRED`，退出码 1，**不静默加 headed**；dry-run 不受限 | 断言退出码与零驱动调用 |
| `src/cli.ts`（计划阶段） | win32 实时（非 dry-run）流程含 shell 步骤，或任何模式含截图断言 → 计划阶段拒绝（`UNSUPPORTED_PLATFORM`，退出码 2），不做"跑到那一步才发现"；dry-run 的 shell 预览不拒绝（§3.3） | 计划用例 |
| `src/run.ts:227` | legacy 实时运行把预检窗口 ID 作为默认 `selected`，所有 `snapshot` 带 `--window-id`；路径固定分支与离线路径不动 | 断言每次 snapshot 的 argv 都含同一 ID |
| `src/run.ts:534` | win32 物理输入前（`click`/`type`/`press`/`clickPoint`）确认绑定窗口仍在焦点；不成立即 `WINDOW_FOCUS_UNCONFIRMED`，零输入 | stub 在第二次读取时把 `is_focused` 置 false，断言动作调用数为 0 |
| `src/run.ts`（首个快照前） | legacy 实时运行在首个 `snapshot` 前调用 `preflight`；路径固定分支与离线路径不动 | 现有用例回归 |

不改：`src/contracts.ts`、`schemas/*`、`src/locator.ts`、`src/record.ts`、`native/`、`.github/workflows/ci.yml`。`flow.target.app` 在 schema 里本来就是自由字符串（`src/contracts.ts:7`、`:34`），Windows 镜像名不需要 schema 改动。

### 3.3 平台门禁的适用范围

"Windows 上拒绝 shell / 截图"不是一条全局规则，而是按入口分别成立。现状（代码事实）与 W1 行为：

| 入口 | 现状 | Windows W1 |
| --- | --- | --- |
| `flow validate` | 无平台分支（`src/cli.ts:113`），只校验 schema 与计划 | 照常。含 shell 步骤或截图断言的**旧 v1 flow** 也能校验，不在这一步拒绝 |
| `run --dry-run` | shell 步骤只预览、不执行（`src/run.ts:375` 的 `previewShell`）；desktop 只在需要时才建 | 照常预览，**不因 Windows 拒绝 shell**；这是 Windows 唯一允许含 shell 步骤的运行入口，且零执行 |
| `run --dry-run --snapshot` | 离线分支在 `macOnly` 之前（`src/cli.ts:301`） | 照常解析快照，不触发 provider；旧 v1 快照必须能读 |
| `pick --snapshot` | 同上（`src/cli.ts:138`），但 `--app` 先过 bundle ID 正则（`:134`） | 按 §3.2 分平台校验后照常工作 |
| `run`（非 dry-run）含 shell | `shellGate` 在 `src/run.ts:151` 拦截；shell 实现本身是 POSIX | 在 `shellGate` 之前直接 `UNSUPPORTED_PLATFORM`（退出码 2），不进入运行 |
| `run` / 批量含截图断言 | 无平台分支 | 计划阶段 `UNSUPPORTED_PLATFORM`（退出码 2） |
| 批量 | 任何平台都先拒绝含 shell 定义的 flow（`src/cli.ts:241`） | 保持该错误；其余按 `run` 的 headed 门禁 |
| `report pack` | 始终拒绝含 shell 定义的 flow（`src/report.ts:69`） | 同左。纯离线比对加 `--no-upload`，避免存在上传配置时排入队列 |
| 旧 v1 flow / snapshot / report | v1 schema 未变 | 必须能读：`flow validate`、快照解析、旧 `report.json` 的 `report pack` 与查看器 |

"计划阶段拒绝"的实现位置在 `src/cli.ts`，不是 `src/run.ts` 的逐条执行；T1 的离线用例按本表逐行断言，其中旧 v1 文件的读取与 `--no-upload` 属于 W1 门禁（§7.7）。

### 3.4 错误码与退出码

| 情形 | 错误码 | 退出码 | 用户可见提示 |
| --- | --- | --- | --- |
| provider 缺失/不是原生 exe | `DESKTOP_DEPENDENCY` | 2 | 设置 `CUEKEEPER_AGENT_DESKTOP` 到原生 exe 的绝对路径 |
| 目标以管理员运行（UIPI） | `PERM_DENIED`（dependency） | 2 | 目标进程完整性更高，请用同级终端或非提权实例重跑 |
| flow 请求被策略拒绝（如 `alt+f4`） | `POLICY_DENIED` | 1 | 该组合键在 Windows 被驱动策略拒绝，改用其他步骤 |
| 目标窗口最小化 | `WINDOW_MINIMIZED` | 1 | 手动恢复窗口后重跑；W1 不自动恢复 |
| 前台锁导致无法确认焦点（预检或运行中） | `WINDOW_FOCUS_UNCONFIRMED` | 1 | 手动把目标窗口切到前台后重跑；本轮未发送任何输入 |
| 窗口身份变化 | `WINDOW_CHANGED` | 1 | 目标窗口已更换，重新拾取或重新录制 |
| `setup.ensure` 在 win32 上需要修复 | `ENSURE_FAILED`（报告条目） | 1 | 手动打开目标窗口后重跑；W1 不启动、不聚焦 |
| 缺少 `--headed` | `HEADED_REQUIRED` | 1 | Windows 实时回放必须 `--headed` |

报告 schema 的 `code` 是自由字符串（`schemas/report.schema.json:118`），新增错误码不需要 schema 版本变更。

### 3.5 并发

agent-desktop 在 Windows 上有跨进程独占交互租约。W1 不做自己的锁：同一时刻只允许一个 live 命令（文档写明）；上游返回租约冲突时原样透出错误码与提示，不重试、不排队。

需要说清租约的边界：每次 `src/desktop.ts` 调用都是一次独立的子进程（`execFile`），上游文档只证明同一时刻的交互不会并行，没有证明"一次运行持有的租约覆盖整轮 N 次调用"。因此 W1 把租约当成"单次调用的互斥"，整轮互斥由"同一台机器一次只跑一个 live 命令"的人工前提保证（§3.1.1）。`workbench` 在 win32 上不开实时回放，正是为了避免工作台与 CLI 在同一轮里交叉。

## 4. 录制层结论（W2 设计基线，W1 不实现）

| 事项 | 结论 | 证据等级 |
| --- | --- | --- |
| 全局输入 | `WH_KEYBOARD_LL` / `WH_MOUSE_LL`，回调在安装线程；专用线程跑消息循环，回调只做拷贝 + Post | 上游官方文档 |
| 静默移除 | 超过 `LowLevelHooksTimeout` 会静默卸载；每 5 s 卸载重装 + 无事件看门狗报 warning | 上游官方文档 |
| 文本还原 | `ToUnicodeEx` + 当前布局；只还原 ASCII 可打印字符（与现有 `[ -~]` 过滤一致），其余发 `key` 或跳过；IME/中文一律不还原 | 推断 + 现有代码 |
| 密码输入 | Windows 没有采集源头的安全输入标志；只能靠"快照发现 secure 字段就中止"事后保护。**不在内存外落盘裸按键，不写日志** | 代码事实（`native/recorder.swift` 对应逻辑）+ 推断 |
| 指示窗 | `WS_EX_NOACTIVATE`/`TOOLWINDOW`/`LAYERED`/`TRANSPARENT`/`TOPMOST`；`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`（Win10 2004+，更早版本降级 `WDA_MONITOR` 会在录屏里显示空白，需按版本告警） | 上游官方文档 |
| DPI | 进程 Per-Monitor V2；HUD 与 UIA bounds 都用物理像素 | 上游探针 |
| 热键 | `Ctrl+Alt+P` / `Ctrl+Alt+X`，钩子里吞掉；与 macOS 的 `Ctrl+Option` 同义 | 推断 |
| 协议 | 复用 `ready/focus/boundary/warning/click/text/key/click_trace/error` JSON 行，`t` 为启动后毫秒、`seen` 为 `Date.now()`，`src/record.ts` 不改协议 | 代码事实 |
| 二进制与工具链 | `dist/cuekeeper-capture.exe`；C#/.NET P/Invoke，`dotnet publish -r win-x64 --self-contained` 单文件（不引入 node-gyp；代价是构建机需 .NET SDK） | 推断，开单时定 |
| 提权 | 不需要 TCC 类授权；UAC 弹框只能由用户触发，录制器不请求提权、不尝试跨 UIPI 边界；管理员窗口的输入是否可见列入实机确认 | 推断 |
| 断言 | 录制 Windows 上无法在采集源头屏蔽密码，必须在文档与首次引导里明示 | 决策 |

## 5. 风险清单

| # | 风险 | W1 处置 |
| --- | --- | --- |
| R1 | 提权窗口（UIPI）可读不可写，首条输入才暴露 | 快照能成功、动作报 `PERM_DENIED` 时给"同级终端"提示，退出码 2 |
| R2 | 多显示器：坐标是物理像素，负坐标合法，换屏/换缩放后 point 失效 | 只保证同机同缩放；文档要求优先 ref；点选坐标写入 flow 时标注限制 |
| R3 | UIA 树冷启动失真（Chromium 12→165 节点，10–25 s） | 预算放大 + 一次重试；W1 门禁应用不选 Chromium，高延迟目标 W1 通过后另开 |
| R4 | 最小化窗口 bounds 为 −32000 且 `IsOffscreen` 为 false | 窗口根 bounds 检查阻塞，不依赖 visible/offscreen |
| R5 | HWND 是 16 位计数器，会话内可能复用；驱动是否给 `process_instance` 未验证 | 绑定 `id + title`（现状）；长会话建议重录；拿到 `process_instance` 后再加严 |
| R6 | 前台锁导致 `focus-window` 失败 | 只做一次聚焦 + 轮询确认；失败零输入并提示人工前置 |
| R7 | 交互租约独占，录制与实时回放不能并行 | 文档写明；错误原样透出，不重试 |
| R8 | 锁屏 / Session 0 / 断开 RDP / 另一用户会话 | 不支持；preflight 只能间接发现（窗口不可见/无树），按观测失败阻塞 |
| R9 | 长路径：Node 不会自动加 `\\?\`；未启用 LongPathsEnabled 时 >260 字符路径会失败 | 不改写用户路径；文档写明启用方法；T2 用深路径负例记录实际错误（仓库设置的 `core.longpaths` 只影响 git） |
| R10 | 截图断言整条链路在 Windows 无验收证据（上游文档把 `screenshot` 列为无头可用） | W1 计划阶段拒绝；T2 记录 `screenshot` 子命令结果，链路验收后再开 |
| R11 | flow 跨平台误用（`meta` 是 Win 键、`delete` 语义不同） | 按平台产物；不做迁移，文档写明 |
| R12 | 未签名 exe 触发 SmartScreen/杀软（W2 录制器） | W2 处理；W1 不引入新二进制 |
| R13 | 目标应用在运行中改窗口标题（编辑器标记未保存状态），**标题实际是否变化待实机确认** | 只有实测标题变化时才触发本风险：每次快照都要求标题精确相等（`src/locator.ts:87`），编辑后第一步就 `WINDOW_MISMATCH`。W1 不改契约：门禁选标题稳定的应用（§7.1）并写进限制；是否放宽交 mac-codex 决策 |
| R14 | 交互租约只覆盖单次 driver 子进程调用，不覆盖整轮多调用运行 | 整轮互斥靠"同一台机器一次只跑一个 live 命令"的人工前提（§3.1.1、§3.5）；不实现自有锁 |
| R15 | 只有一台 x64 实机，无法覆盖 arm64、不同缩放与双屏 | arm64 / 150%–200% 缩放 / 双屏（含负坐标）只做记录，不作为 W1 出口（§7.7、§8） |
| R16 | 绑定窗口后驱动仍可能把目标切回前台，使"焦点丢失"负例假通过 | 负例不只看是否切换窗口，还要确认 `is_focused` 未被驱动改回；记录驱动实际行为（§7.5） |

## 6. 实施拆分

三个子任务已作为 HAOC-74 子单登记：T1 = HAOC-84，T2 = HAOC-83，T3 = HAOC-85。T1 是离线任务，可在 macOS 完成；T2 是 W1 出口，需要实机与用户在场；T3 只在 W1 通过后细化。缺实机时 T2/T3 保持 `backlog`。

| 任务 | 一句话目标 | 可观察验收 | 依赖 |
| --- | --- | --- | --- |
| **W1-T1**（HAOC-84）驱动层平台化（离线） | 让 win32 分支按"回放-only"成型，并在 macOS 用注入平台 + stub provider 测出来 | §3.1.1、§3.2、§3.3 每一行都有对应用例：预检 ID 贯穿每次 `snapshot` 与 `clickPoint`、焦点丢失零输入、退出码、参数数组、重试次数、平台门矩阵、旧 v1 flow/snapshot/report 读取、`--no-upload`；`pnpm build && pnpm test` 绿；macOS 旧用例全过 | 无实机、无 CI 改动 |
| **W1-T2**（HAOC-83）Windows 实机验收（W1 出口） | 手写 flow 对标题稳定的编辑器完成 pick → dry-run → headed 十轮，并覆盖批量、断言、point、有限 workbench 与负例 | §7.3 十轮 10/10；§7.4 每项能力各有一个可观察结果；§7.5 负例错误码与"零输入"；§7.6 报告在 macOS 可打开且 manifest 一致；§7.7 的 W1 门禁逐项记录 | T1；Windows 实机 + 用户在场（HAOC-76） |
| **W2-T3**（HAOC-85）Windows 录制桥（仅登记） | 复用 JSON 协议在标题稳定编辑器录出 3 步 flow | 录制→validate→dry-run→headed 回放全通过；HUD 不抢焦点、录屏不可见；热键被吞；无裸按键落盘 | T1/T2 通过后细化；实机 + .NET SDK |

## 7. 验证方案（T2 执行清单）

### 7.1 验收应用：标题稳定的经典 Win32 编辑器

TextEdit 的等价物必须同时满足四条，全部可观察：

1. 窗口标题唯一，且**编辑与保存过程中不变**。
2. 正文是一个可读的文本控件（`pick` 能看到，`get --property text` 可读）。
3. `Ctrl+S` 在已存在的文件上原地保存，不弹格式/确认对话框。
4. 保存后的文件能被外部读取核对。

**首选 WordPad**（Win10 1809–22H2 自带；用开始菜单启动，进程名是 `wordpad.exe`，`write.exe` 只是启动器），用已存在的 `Cuekeeper-W1.rtf`。开跑前逐条确认，任一不成立就停：

- `list-apps --app wordpad.exe` 恰一个结果；窗口 owner 不是 `ApplicationFrameHost`。
- `list-windows` 标题恰等于 `<文件名> - WordPad` 且唯一。
- 手动输入一个字符后窗口标题不变；`Ctrl+S` 静默保存。
- `pick` 能看到唯一的正文控件（role 以实机输出为准）。

**经典记事本能否作为 W1 门禁，整段待实机确认（推断）。** Win10 1809+ 的记事本可能在标题栏标记未保存状态（`*`）。如果实测标题确实变化，本项目每次快照都要求窗口标题与 flow 完全相等（`src/locator.ts:87`），`type` 之后的第一步（`Ctrl+S` 前取快照）就会以 `WINDOW_MISMATCH` 失败；如果实测标题不变，这条限制不触发，记事本仍可作为候选。两种情况都先记录，不在本单改契约。

机器上没有满足条件的编辑器时（例如 Win11 24H2 起 WordPad 已移除，新记事本同样标记修改）：停止验收，把「标题漂移是否放宽」交 mac-codex 决策。候选是 (a) 写进平台限制文档，(b) 绑定后以 `(id, process_instance)` 识别、不再逐次比对标题。不自行改契约，也不靠"改 flow 标题"绕过。

**不作为门禁**：Win11 新记事本、Chromium/Electron 应用（高延迟目标，W1 之后）、UWP/Store 应用。

### 7.2 准备

- Windows 10 1809+ / 11 x64；Node 22；pnpm 10.28.2；agent-desktop 1.3.1 原生 exe。
- `set CUEKEEPER_AGENT_DESKTOP=C:\path\to\agent-desktop.exe`
- 测试目录 `C:\cuekeeper-w1`，文件 `Cuekeeper-W1.rtf`（已存在），内容固定为 ASCII 字符串（例如 `Cuekeeper W1 round 01`）。每轮在编辑器里全选删除并 `Ctrl+S`，确认文件已空，再开始回放。
- flow 三步：正文 click → type 固定字符串 → `ctrl+s`。定位器来自 `pick --select`；把结果手写进 `out\w1.flow.json` 后先 `flow validate`。

```sh
node dist/cli.js pick --app wordpad.exe --window "Cuekeeper-W1.rtf - WordPad" --json
node dist/cli.js flow validate out\w1.flow.json --json
node dist/cli.js run out\w1.flow.json --dry-run --json
node dist/cli.js run out\w1.flow.json --headed --report out\run-01.json --json
node dist/cli.js report pack out\run-01.json --flow out\w1.flow.json --out out\run-01.zip --no-upload --json
```

### 7.3 十轮

| 轮次 | 起点 | 操作 | 通过判据 |
| --- | --- | --- | --- |
| 1–10 | 文件已清空并保存，编辑器窗口唯一且在前台 | `run --headed --report out\run-NN.json` | 3 步全 `passed`；窗口标题全程不变；保存后的文件包含预期 ASCII 字符串（逐字符），修改时间变化，未出现格式/确认对话框 |

每轮记录：报告文件名、三步状态、保存后文件内容、是否出现 `delivered_unverified`（允许，但要用文件内容核对证明生效）。任一轮失败即停止，保留现场与日志，不改契约硬凑。

### 7.4 能力覆盖（每项一个最小可观察结果）

§2 承诺的每一项能力在 T2 都要有一次可观察结果，不再只跑 click/type/key：

| 能力 | 最小可观察结果 | 备注 |
| --- | --- | --- |
| `run --data`（批量） | 两行数据分别写两个不同 ASCII 字符串；两行都 `passed`，退出码 0；第二次运行后文件内容等于第二行的字符串 | 单进程按行串行；每行报告与主报告都能读 |
| 元素断言 | flow 增加 `assert`：正文控件 `exists: true` 且 `visible: true`；headed 回放 `passed`，报告里有该条目 | `text`/`value` 可读时再加一条；读不到记 `PROPERTY_UNAVAILABLE`，不作为门禁（§8 第 5 条） |
| 窗口断言 | `assert` window `title` equals 当前标题、`exists: true`；`passed` | 精确等于，不引入正则 |
| `point` 点击 | 用 `pick` 输出的坐标构造 `point` 动作（先 click 再 type）；保存文件含预期字符串 | 只保证同机同缩放；单独一轮，不混进十轮 |
| 有限 `workbench` | 把 `flow.json` + `report.json` 放同一目录，`workbench <dir> --port 0`；页面显示 3 条步骤与最终状态 | 只验离线查看；`--allow-live-replay` 在 win32 不启用 live（`src/workbench.ts:112`） |

五项任一失败：记下报告、命令与现场，作为 W1 不通过的证据；不为了凑通过删减 §2 的承诺。

### 7.5 负例

| 场景 | 预期 |
| --- | --- |
| 先最小化编辑器再运行 | `WINDOW_MINIMIZED`，零动作，文件未变 |
| 编辑器以管理员身份运行 | 首条动作 `PERM_DENIED`，退出码 2，文件未变，提示用非提权实例 |
| 目标未运行 / 标题不匹配 | `APP_NOT_FOUND` / `WINDOW_NOT_FOUND`，退出码 1，不尝试启动 |
| 切到别的窗口后立即运行 | `WINDOW_FOCUS_UNCONFIRMED`，零输入，别的窗口内容未变；同时记录 `is_focused` 的实际值，确认不是"驱动自己把目标切回前台"造成的假通过（R16） |
| 运行中切走焦点（首个动作之后） | 下一步之前 `WINDOW_FOCUS_UNCONFIRMED`，零输入，别的窗口内容未变 |
| 去掉 `--headed`（非 dry-run） | `HEADED_REQUIRED`，零驱动调用 |
| 运行中把目标窗口另存为新名字（标题变化） | 若标题真的变化，下一步 `WINDOW_MISMATCH`；记录实际时序，不要求修复（R13） |
| 测试目录路径 >260 字符 | 记录实际错误（预期 `ENAMETOOLONG` 一类），不作为 W1 出口 |

### 7.6 报告跨平台读取

- 报告包结构固定：`index.html`、`report.json`、`flow.json`、`manifest.json`、可选 `assets/`；打包时条目名 `\` 统一成 `/`（`src/report.ts:20`），ZIP 时间戳固定为 1980-01-01（`src/report.ts:127`）。条目名与时间戳这两处平台差异已被消除，原则上同一份输入在两个平台打出的归档一致（仍需 T2 实机比对 manifest 确认，见 §8 第 16 条）；查看器是自包含静态页，不联网、不需要后端。
- 验收：Windows 上 `report pack --no-upload` 后 `unzip -t` 通过；把 zip 拷到 macOS，解压打开 `index.html`，时间线、状态、失败详情与 Windows 上一致。再在 macOS 用同一份 `report.json` + `flow.json` 打一次包（同样 `--no-upload`），比对 `manifest.json` 的每个 SHA-256（应一致）。
- 说明：`flow.json` 里的 `target.app`（如 `wordpad.exe`）与盘符路径在 macOS 只作展示，不解析本机应用；**不在 macOS 上回放 Windows 的 flow**。截图断言的基线是逐像素、按同一窗口尺寸和缩放，跨平台不通用，W1 也不开截图断言。
- 上传（HAOC-73 合入后）：Windows 生成的 zip 走一次 mock server 校验，记录结果，不作为 W1 出口。纯离线比对一律加 `--no-upload`，避免存在上传配置时排队。

### 7.7 W1 门禁与只记录项

W1 出口只认下表的可观察结果；表外实机项只记录，不作为通过/不通过依据。

| 项 | 来源 | 通过判据 |
| --- | --- | --- |
| 驱动层离线用例 | T1（macOS） | §3.1.1、§3.2、§3.3 全覆盖；`pnpm build && pnpm test` 绿 |
| 旧 v1 兼容（离线） | T1（macOS） | 旧 flow `flow validate` 通过；旧 `snapshot.json` 在 `run --dry-run --snapshot` 与 `pick --snapshot` 下解析成功；旧 `report.json` + 对应 `flow.json` 能 `report pack --no-upload`，放进同一目录后能被 workbench 打开；含 shell 的旧 flow 在 `validate`/dry-run 可读，在 `pack` 按现有规则被拒 |
| pick / dry-run / headed 十轮 | T2 | §7.3 全过 |
| 批量、断言、point、workbench | T2 | §7.4 五项全过 |
| 负例 | T2 | §7.5 各项错误码与零输入符合 |
| 报告跨平台 | T2 | §7.6 全过 |
| 环境自证 | T2 | `version` 报 1.3.1；§7.1 的四条逐条成立 |

只记录、不作为 W1 出口：

- **arm64**：本次只有一台 x64 机器，arm64 不覆盖，不得用 x64 结果推断 arm64。
- **不同 DPI / 双屏**：100% 以外的缩放、双屏（含负坐标）只记录；W1 只保证同机同缩放。
- **`screenshot` 子命令**：记录是否可用与输出，不放开截图断言。
- **HWND 复用 / 长会话 / `process_instance`**：记录实际行为，不改变 `id + title` 绑定。
- **深路径 >260 字符**、**租约冲突文案**、**键名别名**：只记录实际结果；十轮只用 `ctrl+s`，不依赖别名。

## 8. 需实机确认（转 HAOC-76）

以下全部是**未验证**项，T2 逐条记录结果；与 [Windows 适配](windows.md) §11 重叠的部分以本节范围为准。

1. npm 包装出的原生 exe 在 win32/x64 与 arm64 上都能运行，`version` 报 1.3.1。
2. `snapshot --include-bounds --max-depth 50` 被接受；50 层是否触顶。
3. `type --headed --stdin` 的 delivery 分布，`delivered_unverified` 是否成为常态。
4. `focus-window` 在当前前台锁下的成功率，1.5 s 轮询是否够。
5. 首选应用（WordPad）的正文控件 role/name、`get --property text` 是否可读，`Ctrl+S` 是否静默。
6. 记事本（经典与 Win11 新记事本）编辑后窗口标题是否真的变化，确认 §7.1 的待确认结论。
7. WordPad 编辑与保存过程中窗口标题是否不变；Win11 24H2+ 上是否还有可用替代。
8. 最小化窗口的窗口根 bounds 与 `is --property visible` 实测表现，确认 `WINDOW_MINIMIZED` 判据成立。
9. UIPI：管理员身份的编辑器上读成功、写失败的顺序与错误码。
10. 键名别名：`delete`/`backspace`/`pageup`/`pagedown`/`forwarddelete` 的实际物理键。
11. 物理像素坐标在 100%/150%/200% 缩放、双屏（含负坐标）下的表现。
12. `screenshot` 子命令在 Windows 的实际输出与窗口选择（上游 Windows 文档把它列为无头可用；本项验证的是 CueKeeper 截图断言链路的可用性，不改变上游能力描述）。
13. 长时间会话中 HWND 复用是否让 `id + title` 绑定失效；驱动是否在 Windows 返回 `process_instance`。
14. 深路径（>260 字符）的实际错误与系统设置要求。
15. 交互租约冲突的错误码与文案。
16. `report pack` 在两个平台的 manifest 是否逐字节一致（离线可先在 macOS 侧准备脚本，Windows 侧实跑）。
17. win32/arm64 的原生 exe 与 `version` 输出：本次若只有 x64 机器，保留为待取证，不推断 arm64 结果。
18. 100% 以外的缩放与双屏（含负坐标）：本次若只有单屏，保留为待取证；不得用单屏 100% 结果外推。

> 第 1、11、17、18 条受机器数量限制：只有一台 x64 单屏实机时，这些项只能记录或明确写"未取证"，不能算 W1 通过。

## 9. 证据状态

**已实机验证：0 项。** 本轮没有 Windows 机器，没有在 Windows 上执行任何命令。

**代码事实**（本机 macOS 阅读，2026-11-22，基线 `1ac17d7` 之上阅读当前 `src/`）：`src/cli.ts:69` 的 `macOnly` 与 4 处调用（`:149` pick、`:262` 批量、`:308` run、`:370` record）；`src/cli.ts:135`、`:365` 的 bundle ID 正则；`src/cli.ts:138`、`:301` 的 `--snapshot` 离线分支先于 `macOnly`；`src/cli.ts:241` 批量拒绝含 shell 的 flow；`src/desktop.ts:78` 的 `execFile` 解析、`:142` 的 3000 ms 默认快照、`:183` 的 darwin 修复门槛、`:283` 的 `click`/`:296` 的 `type`/`:297` 的 `press`、`:284`–`:286` 的 `clickPoint` 自行聚焦，`WindowInfo` 在 `:10`、可选 `processInstance` 在 `:14`；`src/run.ts:227`、`:243` 的窗口 ID 传递、`:534` 的输入前快照、`:151` 的 shell 门、`:375` 的 shell 预览；`src/workbench.ts:112` 的 live 门；`src/app-catalog.ts:35`、`:53` 的 `mdls`/`system_profiler`；`src/record.ts:179` 把 `w-<数字>` 当窗口号、`:185` 的采集二进制名；`src/locator.ts:50` 的 bounds 正数校验、`:83` 的 `complete !== true` 判据与 `:87` 的窗口标题精确比对；`src/contracts.ts:34` 的 `target.app` 自由字符串；`src/app-identity.ts:269` 的实时平台门；`src/doctor.ts:239` 的 macOS 平台检查；`src/shell.ts:11` 的 POSIX 固定 PATH；`src/report.ts:21`、`:133` 的条目名规范化与固定时间戳、`:69` 的含 shell flow 拒绝；`schemas/report.schema.json:118` 的 `code` 自由字符串；`src/cli.ts:430` 的 `report upload`；`.github/workflows/ci.yml` 只有 macOS job。

**上游证据**：[Windows 适配](windows.md) §12 的 agent-desktop v1.3.1 文档/探针与 Windows 官方文档。本轮的 Windows 行为判断都建立在这些之上，属"上游可用"，不等于本项目实测。

**推断**：录制桥的语言选型与构建方式、HUD 版本降级行为、`Ctrl+Alt` 冲突可接受性、Win11 新记事本的树质量、`focus-window` 轮询 1.5 s 是否足够、深路径错误形态、经典/Win11 记事本的标题是否真的漂移。

**设计未实现**：§3.1.1、§3.2、§3.3 描述的是 W1 的实施要求；本轮只改文档，没有写任何对应代码，因此条目中的行号指向现状基线，不是已完成的改动。

## 10. 与现有设计的关系

- 可行性、差异清单与未验证项：[Windows 适配](windows.md)（HAOC-67）。本文只做范围与实施决策，不重复其证据。
- 应用身份：[应用副本身份](app-identity.md) 已实现（HAOC-80），但路径固定与实例绑定是 macOS 原生探针；W1 只用 legacy 模式（`list-apps` 镜像名），目标需已运行。
- 报告与上传：[离线报告包](report.md)、[报告上传协议](upload-protocol.md)、[上传架构](upload-architecture.md)、[上传客户端](upload-client.md)。
- 断言：[M2 断言扩展设计](assertions.md)。W1 只开元素/窗口文本类断言，截图断言待实机。
- 录制：[TextEdit 现场验收](textedit.md) 是 macOS 的等价物；Windows 的录制验收在 W2-T3。
- 打包与首次引导：[打包与分发](packaging.md) 的 `doctor` 目前以 macOS 为准；shell 步骤见 [Shell 安全](shell-security.md)。
- 里程碑：`docs/architecture.md` 的 M3 段落补一句指向本文。
