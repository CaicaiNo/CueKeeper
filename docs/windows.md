# Windows 适配可行性与驱动边界

本文回答 M3 首版 Windows 能做什么、必须实机确认什么、不建议做什么，并给出文件级的接口改动清单。首版的范围决策与实施拆分见 [Windows 首版（W1）范围决策](windows-scope.md)（HAOC-74）。

本轮只做调研与设计，**没有在 Windows 上跑过任何命令**。本文所有"可用"都指上游实现或其探针证据支持，不等于本项目已实测；每条结论标注来源，未经实机验证的单独列在第 11 节。

## 1. 结论

**可行，但形态是"回放先行、录制后置"。**

- agent-desktop 1.3.1 自带 Windows 适配器（UIA），读树、语义点击、启动、窗口操作、等待在 Windows 上可用，`version` 与 JSON 信封和 macOS 相同，因此 `src/desktop.ts` 的调用协议基本不需要重写。
- 录制必须新建原生桥：现有 `native/*.swift` 是 CGEventTap + AppKit，Windows 上没有对应物，需要 WH_KEYBOARD_LL / WH_MOUSE_LL + 分层窗口 HUD。
- 现有代码有 **4 处会直接在 Windows 上失败**，不是"性能问题"而是"跑不起来"：`type` 固定无头（Windows 返回 `POLICY_DENIED`）、`execFile` 拉不到 npm 的 `.cmd` shim、`--app` 校验按 bundle ID、`record` 把 `w-<数字>` 当 macOS 窗口号。
- 最大的技术不确定性不在 agent-desktop，而在 UIA 的时延与失真：Chromium 冷启动首读只有 12 个节点（稳定后 165），耗时 10–25 秒；最小化窗口的元素 `IsOffscreen` 仍是 false，bounds 锚在 −32000 却不报错。

## 2. 证据等级

| 级别 | 含义 | 本文用法 |
| --- | --- | --- |
| **上游文档** | `vercel-labs/agent-desktop` v1.3.1 的 README 与 `skills/`、`apps/docs` | 能力矩阵、"需要 `--headed`"、错误码 |
| **上游探针** | 同版本仓库 `probes/windows/FINDINGS.md` 与其 captures | 具体毫秒数、节点数、UIPI 行为；单机单环境，不算产品契约 |
| **Windows 官方** | learn.microsoft.com | Win32 语义：钩子、分层窗、DPI、前景锁 |
| **本机静态** | 本机（macOS）阅读 `src/`、`native/` 得出 | 代码事实：哪一行会失败 |

上游自己的 Windows 平台文档也写明"it was not run for these docs"，所以上游文档只能证明"设计如此"，不能证明"这台机器能跑"。第 11 节把这些全部收敛成实机清单。

## 3. agent-desktop 在 Windows 的能力（本项目实际用到的命令）

| 命令 | Windows | 差异要点 | 对本项目的后果 |
| --- | --- | --- | --- |
| `version` | 可用 | 返回 `{version, target, os}` | `agentDesktopVersion = '1.3.1'` 的断言不变，但需实机确认 npm 包内的 Windows 二进制也报 1.3.1 |
| `snapshot` | 可用（UIA） | 默认 `--timeout-ms 3000`；`complete: false` 是**成功返回**，不是错误；`identity_unproven` 表示这次读没证明 ref 唯一 | 我们要求 `complete === true` 且无 `identity_unproven`，Dense 应用会直接 `INCOMPLETE_TREE` |
| `list-windows` | 可用 | 返回 `{id,title,app_name,pid,bounds,is_focused,accessible}`；`w-<HWND>`；被遮挡的窗口仍可驱动 | 精确标题匹配逻辑可复用；`w-` 前缀正则天然通过 |
| `list-apps` | 可用 | `--app` 是**名字子串**过滤，不是等值 | `ensure: app_running` 用列表长度判唯一，子串会误判 `AMBIGUOUS_TARGET` |
| `launch` | 可用 | 收绝对路径，或 System32 / Windows 目录下的裸名（`notepad`、`notepad.exe`）；**不收显示名** | 现有 flow 的 `app` 若写成路径，`list-windows --app` 就匹配不上，见 §4.6 |
| `focus-window` | 可用但不可靠 | 受前台锁（foreground lock timeout）限制；探针在空载下 5/5 首次失败、5/5 第二次也失败 | `ensure: window_ready` 用 `focused.id` 断言，会报 `WINDOW_CHANGED`，属于误报 |
| `click` | 无头可用 | 语义路径：Invoke / Toggle / SelectionItem / Legacy DoDefaultAction；`--headed` 才走物理点击 | 我们的 `click(ref)` 不变 |
| `type` | **需 `--headed`** | 无头由 `SendInput` 实现，严格无头返回 `POLICY_DENIED`；headed 下经常 `delivered_unverified`（字段没有可读 Text selection） | HAOC-97 后 headed 回放已带 `--headed`；win32 无头路径仍会 `POLICY_DENIED`，W1 要求 win32 恒带 `--headed` |
| `press` | 无头可用 | 永远是物理键盘输入；`--window-id` 可定向；非前台 App 的无头定向 press 会 fail closed；`meta`/`cmd` 是 Win 键 | 组合键语义与 macOS 不同，见 §4.5 |
| `mouse-click --xy` | 需 `--headed` | 坐标是**物理像素**，适配器按 Per-Monitor V2 启动 | `clickPoint` 已要求 headed；坐标不能跨 DPI 复用 |
| `get` / `is` | 可用 | `get --property text|value`；`is --property visible` | `snapshotProperty` 逻辑可复用 |
| `permissions` | 可用，但无弹框 | `accessibility: granted`（UIA 能应答时）、`automation: not_required`；`--guide` 返回 `PLATFORM_NOT_SUPPORTED` | 不需要 TCC 流程；权限改为"完整性级别"问题 |
| `status` | 可用 | 含 `supported_surfaces` | 可作为 preflight |
| 沙箱 / `key-down` / `menubar` / `close-window` | 不可用 | 沙箱无 Windows；held input 在所有平台 fail closed；无 `menubar` surface；没有单窗口关闭命令 | 不在首版范围 |

`--include-bounds`、`--max-depth 50`、`--window-id`、`--stdin` 这些我们已在用的参数在 Windows 文档中没有被标为不支持，但 `--max-depth` 的默认值是 10 且文档建议用 `--root` 下钻，50 是否被接受需要实机确认（第 11 节）。

## 4. 与 macOS 的差异清单

### 4.1 权限模型：没有授权弹框，只有完整性级别

- Windows 没有 UIA 的授权对话框。`permissions` 是现读 UIA 的探针，`automation: not_required`。
- **读可以跨边界，写不能**：Medium 进程能读 High（管理员）进程的 name/class/control type/pid/bounds，`WM_GETTEXT` 也能读；`SendInput` 被 UIPI 拦住，ref 动作返回 `PERM_DENIED` + `platform_detail: COM HRESULT 0x80070005 (E_ACCESSDENIED)`。
- 探针还测到两件容易写错的事：
  - `SendInput` 的返回值证明不了投递。Medium 和 High 两个分支的 `SendInput` 都报"6 events accepted, lastError 0"，只有回读目标才知道有没有落到（A9-3）。
  - **`focus-window` 能跨边界成功**。`SetForegroundWindow` 受前台锁限制，不受完整性限制；所以同一对进程上"激活成功、输入失败"是正常结果（A24-16）。
- 后果：`ensure: window_ready` 可能通过，然后第一条 `click`/`type` 才报 `PERM_DENIED`。首版必须把这种情况解释成"目标以管理员运行，请用同级终端"，而不是"控件找不到"。

### 4.2 坐标：物理像素，且受 DPI 感知影响

- 适配器启动时设 Per-Monitor V2，因此 `bounds` 与 `--xy` 都是**物理像素**；macOS 侧是逻辑点。两者数值上差一个缩放倍数（150% 屏上 1.5 倍）。
- 若宿主进程先锁定了不兼容的 DPI 感知上下文，headed 坐标会整体偏移；上游的建议是"从普通终端跑，优先用 ref 而不是 `--xy`"。
- 多显示器：`list-displays` 返回 `{id,bounds,is_primary,scale}`；虚拟桌面坐标是各屏 bounds 的并集，负坐标合法（副屏在左/上）。我们的 `parseBounds` 允许负 x/y，但 `contains` 与录制点击都按同一坐标系，没问题；**风险在录制机与回放机的缩放/排布不同**。

### 4.3 UIA 树的时延与失真（最关键）

上游探针的实测数字（单机、单环境，非产品契约）：

| 场景 | 数字 | 来源 |
| --- | --- | --- |
| Chromium/Electron 冷启动首读 | 12 个后代节点 | A16-11 |
| 同一窗口稳定后 | 165 个节点（13.75 倍差距），settle 需 10–25 秒 | A16-11 |
| 单 ref 严格解析（含证据读） | 进程内 16.7ms / WinForms 跨进程 121.8ms / WPF 跨进程 201.6ms | A17-4 |
| 单元素证据批量读 | 0.35 / 0.17 / 0.019ms | A17-5 |
| 语义动作（Invoke/Toggle/SetValue/Select/Scroll，含 re-find） | 205–226ms | A19-8 |
| 176 节点全树走读 | 141.6–175.8ms（Notepad） | A24-17 |
| 窗口枚举 | ~3ms | A23-6 |

对我们的直接含义：

1. `record()` 起点用默认 3000ms 快照，冷启动的 Chromium 目标会拿到 `complete: false` 或极薄树，`parseSnapshot` 抛 `INCOMPLETE_TREE`。需要一次长预算预热快照（30s）再进入逐事件快照。
2. 逐事件快照现在是 1200ms。原生控件够用（单次 140–180ms），Chromium 稳态后也够用，但**预热之前不够**；`record.ts` 另有"事件落后 2000ms 就 `STALE_CAPTURE`"的判据，会在慢树上直接放弃。
3. `--max-depth 50` + 要求 `complete` 在深树上是不小的预算。WPF/Chromium 的深树建议保持 50，但把超时放大到 8–15s，并把 `INCOMPLETE_TREE` 变成"重试一次更大预算"而不是立即失败。
4. 反向的坑：`complete: true` 也不代表语义完整。WPF 在 automation peer 建好之前读到的是一棵"空的通用 provider"，重读才恢得（上游明确要求新快照，进程内重试无效）。

### 4.4 窗口身份与生命周期

- `w-<HWND>`：HWND 的唯一性计数器是 16 位，探针在 90 秒内造了 91,923 个窗口，第 65,535 个开始出现**完整句柄复用**（A24-8）。我们的 flow 绑定 `windowId` 并在变化时报 `WINDOW_CHANGED`；HWND 复用会让"ID 相同"不再是"窗口相同"的证据。
- 最小化窗口：树仍然完整，但只有顶层 window 报空 rect，子元素报**真实宽高 + −32000 锚点**，且 `IsOffscreen` 全为 false（A1-2）。于是：
  - `parseBounds` 会接受这些 bounds（宽高为正），定位器能解析；
  - `is --property visible` 返回 true；
  - 语义 click 可能"成功但无效果"。
  首版必须显式拒绝最小化窗口（先 `restore --app`），不能依赖 visible/offscreen。
- provider 的 `BoundingRectangle` **不按视口裁剪**：列表项可以给出超出容器的 rect（A18-2）。我们的 `hitTest` 用 `contains` 取最小命中，在 Windows 上可能把点击记到滚动区外的元素上。

### 4.5 键盘语义

| 事项 | macOS（现状） | Windows |
| --- | --- | --- |
| 主修饰键 | `meta` = Command | `meta`/`cmd` = **Win 键**；复制是 `ctrl+c` |
| 危险组合 | `cmd+q` 等需 `--force` | `alt+f4`、`win+l`、`win+d`、`alt+tab`、`win+r`、`win+x`、`win+e`、`ctrl+shift+esc` 及其超集，无 `--force` 时 `POLICY_DENIED`；`ctrl+alt+delete` 无法合成 |
| 投递证明 | `press` 报 `delivered_unverified` | 同样 `delivered_unverified`：只能靠 `wait`/断言证明生效 |
| `type` | 无头可用 | 必须 `--headed` |

`schemas/flow.schema.json` 的 `key` 枚举里有 `backspace`、`forwarddelete`、`pageup`、`pagedown`、`delete`，而上游文档只列了 `return/escape/tab/space/delete/up/down/left/right/f1..f12`。**键名别名是否等价，必须实机逐个确认**（第 11 节）。特别注意 `delete`：macOS 语境下它常指退格，Windows 语境下是 Delete 键，跨平台录制会得到不同的物理键。

### 4.6 应用标识：一个字符串服务不了两个用途

- macOS：`--app` 收显示名或 bundle ID；`launch` 也收 bundle ID。
- Windows：`--app`（list-*）收 `list-apps` 打印的名字（如 `notepad.exe`）；`launch` 收绝对路径或 System32/Windows 下的裸名，**不收显示名**。
- 后果：`flow.target.app` 只能是镜像名，而 `launch` 对非系统目录应用需要路径。首版建议的边界是：**目标应用必须已在运行**，`setup.ensure` 只用 `app_running` 或 `window_ready`（不触发 launch）；需要启动时，仅支持 System32/Windows 目录下的裸名。这样不需要改 schema。
- UWP/Store 应用：顶层窗口属于 `ApplicationFrameHost`，应用自身 pid 是另一个进程；`list-apps` 的名字读出来是宿主（A1-3）。首版不承诺支持。

### 4.7 并发

agent-desktop 在 Windows 上有跨进程**独占交互租约**（按 token 派生）。两个进程不能同时做聚焦/点击/输入。`record` 与 `workbench --allow-live-replay`、或两个 CLI 同时跑，会互相阻塞或失败。首版应在 CLI 层给出明确错误，而不是重试。

## 5. 现有 `src/desktop.ts` 抽象够不够

**够覆盖 M1 动作集，缺 3 个能力。** `Desktop` 的 7 个方法（`snapshot/property/ensure/click/clickPoint/type/press`）在 Windows 上都有对应实现路径，不需要拆接口。缺的是：

1. **窗口状态**：没有"是否最小化 / 恢复"的能力。Windows 最小化窗口读得到、点得动、却没效果（§4.4），必须有前置判断，否则会出现"报告 passed、实际什么都没发生"。
2. **可驱动性 preflight**：没有"目标进程完整性是否高于我"的查询。`PERM_DENIED` 现在要等到第一条动作才暴露，且被当成普通动作失败（退出码 1），用户看不出是权限问题。
3. **平台标识**：报告与错误里没有"这是 Windows"的痕迹。`report` schema 不改，因此只能进 `entry.message`／CLI 错误文本，不能进报告结构。

`ensure` 的 `process.platform !== 'darwin'` 硬门槛、`cli.ts` 的 `macOnly()`、`workbench.ts` 的 `allowLive` 都是"平台开关"，不是接口缺陷。

## 6. 驱动接口改动清单（文件级，调研建议）

> **本节的定位**：这是 HAOC-67 调研阶段列出的候选改动，**不是 W1 实施契约**。现行文件级改动、平台门禁与验收以 [Windows 首版（W1）范围决策](windows-scope.md) §3.2、§3.3、§6 为准；两处不一致时按该文执行。本节保留作差异来源与背景说明。

不改 flow/report/behavior/setup schema，不改 `Desktop` 方法签名。下表是调研阶段认为需要改的地方。

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `src/desktop.ts` | `commandRunner`：Windows 上不要直接 `execFile('agent-desktop', …)` | npm 在 Windows 上生成的是 `agent-desktop.cmd`（`npm/lib/windows-bin.js` 把 `.cmd` 改写成直指原生 exe）。Node 文档明确 `.bat/.cmd` 不能用 `execFile` 启动。建议：`CUEKEEPER_AGENT_DESKTOP` 指向原生 `.exe`；未设置时在 win32 上探测 `.exe`，探测不到就报 `DESKTOP_DEPENDENCY` 并给出设置方法，**不要退回 `shell: true`**（`flow.target.app` 是自由字符串，会被 cmd 解释） |
| 同上 | `type` 分平台：Windows 传 `--headed` | 无头 `type` 在 Windows 返回 `POLICY_DENIED`。文本仍走 `--stdin`，不进命令行 |
| 同上 | `DesktopFault` 对 `PERM_DENIED`/`POLICY_DENIED`/`PLATFORM_NOT_SUPPORTED` 标 `dependency = true` | 现在这些是普通失败（退出码 1），应走依赖错误（退出码 2），并在消息里区分"权限/策略" |
| 同上 | `snapshot`：平台相关预算，`INCOMPLETE_TREE`/`identity_unproven` 重试一次更大预算 | Chromium 冷启动 10–25s；现有 3s/6s 预算必挂 |
| 同上 | `ensure` 的 win32 处理：**调研建议**是"`is_focused` + 一次重试"；**W1 决定不修复**——win32 `ensure` 直接报 `ENSURE_FAILED`，提示手动打开目标窗口（[范围决策](windows-scope.md) §3.2） | `focus-window` 受前台锁，探针空载 5/5 失败；W1 不替用户抢前台 |
| 同上 | 新增（可选）`restore?(target)`、`status?()` | §5 的两个缺口；`restore` 只为最小化兜底，`status` 只为 preflight。不加这两个方法也能出首版，但最小化会静默假通过 |
| `src/cli.ts` | `macOnly()` → 按命令的平台能力判断（live 命令允许 `darwin` 与 `win32`；`record` 只允许"有采集桥"的平台） | 现在 Windows 上 `pick`/`run`/`record` 一律 `UNSUPPORTED_PLATFORM` |
| 同上 | `--app` 校验分平台：**调研建议**接受镜像名与绝对路径；**W1 只接受镜像名**（拒绝路径分隔符，`flow.target.app` 只用于 `list-*`，见[范围决策](windows-scope.md) §3.2）；macOS 保持 bundle ID | 现有正则要求"带点的两段"，会拒绝 `Notepad` 之类名字，又会接受语义错误的 `foo.bar` |
| `src/record.ts` | 采集桥路径与扩展名：`dist/cuekeeper-capture.exe`（win32），二进制缺失时给"用 `npm run build:recorder` 构建"的提示 | `fileURLToPath(new URL('./cuekeeper-capture', …))` 在 Windows 上找不到 `.exe` |
| 同上 | 窗口标识：不要用 `/^w-([1-9]\d*)$/` 提取"窗口号"再当 macOS 参数传；改为把 `windowId`（含平台语义）和 `target.app` 传给采集桥 | 现在这段只在 macOS 有意义；HWND 是句柄不是序号 |
| 同上 | 预热快照：录制开始前先做一次长预算快照（30s），失败直接报错而不是开始计时 | Chromium 冷启动 |
| `src/locator.ts` | 无 schema 改动。可在 `parseSnapshot` 加"bounds 明显异常（−32000 锚点）→ `INCOMPLETE_TREE`"的判定，或保持现状由 §5 的窗口状态兜底 | 最小化窗口的假 bounds |
| `src/run.ts` | **调研建议**是"无需改动"；**W1 需要改**：首个快照前 `preflight`、后续快照传预检窗口 ID、输入前确认焦点（[范围决策](windows-scope.md) §3.1.1、§3.2） | 预检绑定必须传到后续调用，否则焦点丢失可能仍然输入 |
| `src/workbench.ts` | **调研建议**是 `allowLive && (darwin || win32)`；**W1 决定不开** win32 实时回放，只保留离线查看（[范围决策](windows-scope.md) §2、§7.4） | 交互租约 + 工作台叠前端驱动收益低 |
| `native/windows/`（新增） | 采集桥：hooks + 指示窗 + 热键 host，输出与现有 `native/recorder.swift` **完全相同的 JSON 行协议** | §7 |
| `scripts/build-recorder.sh` | 改为按平台分派（mac: swiftc；win: 独立脚本），`package.json` 的 `build:recorder` 保持一个入口 | 现在脚本开头 `uname -s` 不是 Darwin 直接 exit 2 |
| `.github/workflows/ci.yml` | **不改**（本轮边界：不引入 Windows CI） | — |

## 7. Windows 录制器设计

目标是让 `src/record.ts` 几乎不改：它消费的协议是 stdout 上的 JSON 行，`kind` 只有 `ready / focus / boundary / warning / click / text / key / click_trace / error`。新桥复刻这套协议，录制编排逻辑就不用分平台。

### 7.1 全局输入：低层钩子，不是 Raw Input

- 用 `SetWindowsHookEx(WH_KEYBOARD_LL / WH_MOUSE_LL, …, 0)`。低层钩子虽然是全局作用域，但**不注入其他进程**：回调在安装线程的上下文里执行，线程必须有消息循环。
- 因此不需要 DLL 注入，也不需要 32/64 位双份钩子；但必须有一个专用线程跑 `GetMessage` 循环，回调里只做"拷贝 → Post 给工作线程 → 立即返回"。
- 硬约束：回调耗时超过 `LowLevelHooksTimeout`（Win10 1709 起上限 1000ms）时，系统会把钩子**静默移除且不通知**。缓解：定时（如每 5s）卸载并重装钩子，或用一个"最近 N 秒无事件"的看门狗报 `TAP_INTERRUPTED` 风格的 warning。
- 官方还建议"需要监控输入时优先用 Raw Input"，但 Raw Input 拿不到"吞掉热键"的能力。我们的热键必须阻止目标应用收到，所以低层钩子仍是主路径，Raw Input 只能作为旁路校验。

### 7.2 焦点与命中门控

- 焦点：`GetForegroundWindow` → `GetWindowThreadProcessId`，与目标窗口的 HWND/pid 比对；状态变化时发 `{"kind":"focus","active":bool}`（与 macOS 的 `frontmostApplication` 等价）。
- 点击：`WindowFromPoint(MSLLHOOKSTRUCT.pt)` → `GetAncestor(GA_ROOT)`，与目标 HWND 比对；不同则发 `{"kind":"boundary"}`。UWP 要走 `GA_ROOTOWNER`，首版不支持 UWP。
- 指示窗自身要排除：`WS_EX_TRANSPARENT` 的窗口在命中测试中会被跳过（官方文档：带该样式的分层窗"形状被忽略，鼠标事件传给下层窗口"），因此正常不会被 `WindowFromPoint` 命中；仍建议按 HWND 显式排除。
- 时间戳：`t` 用启动后的毫秒，`seen` 用 `Date.now()`，与 Swift 实现一致，`record.ts` 的 2 秒落后判据才成立。

### 7.3 文本还原（Windows 最脏的一段）

- 键盘钩子只给 `vkCode` + `scanCode` + 修饰键状态。要把按键变成字符，需要用 `ToUnicodeEx` + 当前布局 + `GetKeyboardState`/`GetKeyState`（Shift、CapsLock）。
- `ToUnicodeEx` 对 dead key 有副作用（会改变内部状态），处理不当会把后续输入弄错。首版策略应当是"保守"：只还原 ASCII 可打印字符（与现有 `^[ -~]{1,16}$` 过滤一致），还原不了的按键**不发 `text`，改发 `key`**，或按 `UNSUPPORTED_EVENT` 跳过。
- IME、中文、全角标点一律不还原。这既是能力边界也是安全边界：不要试图记录原始输入序列。
- 密码字段：Windows 没有 macOS 的 `IsSecureEventInputEnabled`，钩子能看到密码键入。现有保护是"快照里 focused 节点带 `secure` 就整段中止"（`Recording.add` 抛 `SECURE_INPUT`），这属于**事后**保护。首版必须：不在内存外落盘任何裸按键；把"Windows 上无法在采集源头屏蔽密码输入"写进使用说明；不把按键写进日志或 `--trace-clicks`。

### 7.4 指示窗（HUD）

| 需求 | 做法 | 依据 |
| --- | --- | --- |
| 不抢焦点 | `WS_EX_NOACTIVATE`、`WS_EX_TOOLWINDOW`，创建后不 `SetForegroundWindow` | 激活会打乱 `focus` 门控 |
| 点击穿透 | `WS_EX_LAYERED` + `WS_EX_TRANSPARENT` | 官方：`WS_EX_TRANSPARENT` 时形状被忽略，事件传给下层 |
| 半透明 | `SetLayeredWindowAttributes(alpha)` 或 `UpdateLayeredWindow` | 同上 |
| 置顶 | `WS_EX_TOPMOST` + `SetWindowPos(HWND_TOPMOST)` | 需要在目标窗口之上 |
| 不进入截图 | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` | Win10 2004+；更早版本等同 `WDA_MONITOR`（窗口内容变空白），需要按版本降级 |
| 高 DPI | 进程 Per-Monitor V2，HUD 按目标屏物理像素定位 | 与 UIA bounds 同坐标系 |
| 就绪证据 | ready 行里带 `window/display/level/bounds` | `announceIndicator` 要求正整数 + 4 个有限数；Windows 上 `window` 用 HWND（可能超出 32 位，但仍为 safe integer），`display` 用 `list-displays` 的序号，`level` 用自增的 HUD 层级 |

HUD 内容（边框 + 计时 + 暂停状态）沿用 macOS 的呈现，不需要逐像素一致。

### 7.5 热键

- 复用 `Ctrl+Option+P` / `Ctrl+Option+X` 的语义，Windows 上映射为 `Ctrl+Alt+P` / `Ctrl+Alt+X`，在钩子里 `return 1` 吞掉，避免目标应用收到。
- 状态机照抄 Swift：暂停只发一次 `boundary`；停止时先"停止接收动作"，等 key-up 或 750ms 兜底再退出。这样 `record.ts` 的完成判定与部分录制语义不变。
- 需要注意 `Ctrl+Alt` 是很多应用的组合键前缀，首版接受这一冲突（与 macOS 的 `Ctrl+Option` 同类），并在文档里写明可换键。

### 7.6 采集桥与 Node 的交界

- 二进制：`dist/cuekeeper-capture.exe`，参数 `app windowId seconds [--no-indicator] [--sound] [--trace-clicks]`。
- 启动失败、权限缺失、HUD 未确认，都沿用现有错误码：`CAPTURE_DEPENDENCY` / `CAPTURE_START_TIMEOUT` / `INDICATOR_UNCONFIRMED` / `HOTKEY_FILTER_UNCONFIRMED`。Windows 上 `INPUT_MONITORING_REQUIRED` / `ACCESSIBILITY_REQUIRED` 不适用，不要伪造它们。
- 实现语言建议 Rust 或 C#（Win32 + UIA 都现成）；不建议用 Node 原生模块，避免 node-gyp 进入 CI。

## 8. 风险清单

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | 无头 `type` 被 `POLICY_DENIED` | win32 无头回放的文本输入第一步失败（HAOC-97 后 headed 回放已带 `--headed`） | §6 第一优先修复；W1 在 win32 恒带 `--headed` |
| R2 | `.cmd` shim 无法 `execFile` | Windows 上 provider 完全不可用 | 解析原生 exe；不退回 shell |
| R3 | Chromium 冷启动 10–25s，首读 12 vs 165 节点 | 录制/回放误判"控件不存在" | 预热快照 + 预算放大 + `INCOMPLETE_TREE` 重试 |
| R4 | UIPI：可读不可写 | 管理员应用"定位成功、动作全失败" | 提前 preflight；`PERM_DENIED` 升为依赖错误并给出同级终端提示 |
| R5 | 前台锁导致 `focus-window` 失败 | `ensure: window_ready` 误报 `WINDOW_CHANGED` | 改用 `is_focused` 轮询 + 一次重试，单独错误码 |
| R6 | HWND 16 位计数器回绕复用 | 旧 `windowId` 可能命中新窗口 | 首版接受；长会话录制建议按"标题 + 进程 + ID"复验 |
| R7 | 最小化窗口 bounds 为 −32000 且 `IsOffscreen` false | 报告 passed 但无效果（静默假通过） | 动作前查窗口状态（§5 缺口 1） |
| R8 | provider rect 不按视口裁剪 | 点到了容器外的元素 | 命中判定加窗口/视口交集；记录时优先 ref，慎用 point |
| R9 | 坐标是物理像素 | 换机器/换缩放后 point 定位失效 | 首版声明"point 目标只保证同机同缩放"；优先 ref |
| R10 | 同角色同名控件无法区分（Windows 拒绝 identical twins） | v1 的 `index` 兜底在 Windows 失效 | 首版按现状报 `AMBIGUOUS_TARGET`；兜底是 `--headed mouse-click --xy`（需 point 动作，schema 已支持） |
| R11 | 钩子是键盘记录器的原语；二进制未签名 | SmartScreen / Smart App Control / 杀软拦截；合规质疑 | 明示只在本机录制、不落盘裸按键、不联网；签名与分发另议 |
| R12 | 交互租约独占 | 录制与实时回放不能并行 | CLI 层明确报错 |
| R13 | 锁屏 / Session 0 / 其他用户会话 / 断开 RDP | 观测与动作失败或为空 | 列入不支持；preflight 提示 |
| R14 | `delete`/`backspace` 等键名别名不确定 | 快捷键录错键 | 实机确认（§11），必要时在文档里给出映射 |
| R15 | `meta` 在 Windows 是 Win 键 | macOS 录的流程在 Windows 上语义改变 | flow 是**按平台**的产物；不做跨平台迁移 |

## 9. 起步任务（调研建议，已被 HAOC-74 的拆分取代）

> **不要按本节的任务名开工。** 本节是 HAOC-67 调研阶段的三任务草案，已被 [Windows 首版（W1）范围决策](windows-scope.md) §6 取代：现在 T1 = HAOC-84（驱动层平台化，离线可测，不上实机），T2 = HAOC-83（实机验收，含批量/断言/point/workbench 与负例），T3 = HAOC-85（录制桥，不在 W1）。本节保留作历史背景；验收以范围决策 §7 为准。

调研阶段的依赖顺序：T1 → T2 → T3。每个实机任务一台 Windows 10 1809+/11 实机，且不引入 Windows CI。

**T1 · 驱动层平台化（无录制）——调研草案，已被 HAOC-84 取代**
调研目标：在 Windows 上用一条手写 flow 对记事本完成 `pick` → `run --dry-run` → `run --headed` 全链路（现行验收不再用记事本作门禁，改标题稳定编辑器，见 [范围决策](windows-scope.md) §7.1；T1 本身改为 macOS 离线用例）。
验收：同一份 flow 在 Windows 上 dry-run 全部 `resolved`；`--headed` 回放"点击 + 文本输入 + 快捷键"三步后报告 `passed`，且输入内容与文档内容一致（读回文件/文本核对）；全程不使用 `--snapshot`。
覆盖参数：原生 exe 解析、`type --headed`、平台化 `--app`、快照预算、错误码分级、$4.6 的"应用已运行"前置。

**T2 · 采集桥最小闭环——调研草案，现为 HAOC-85（W2，不在 W1）**
目标：`record` 在记事本录出 3 步 flow（点击、ASCII 输入、快捷键），HUD 可见且可确认，停止后立刻能回放。
验收：录制产物 `flow validate` 通过；`run --dry-run` 全解析；`--headed` 回放 `passed`；HUD 在录屏中不出现（`WDA_EXCLUDEFROMCAPTURE` 生效）且录制期间不抢焦点（目标窗口保持前台）；`Ctrl+Alt+P/X` 生效且目标应用收不到这两个组合键。
不含：Chromium、IME、拖拽、右键菜单。

**T3 · 高延迟与失真的目标（Chromium/WPF）——调研草案，W1 之后另议**
目标：冷启动的 Electron 应用（VS Code/Obsidian 一类）能在一次录制里稳定拿到完整树，而不是被薄树或 `identity_unproven` 打断。
验收：两次独立冷启动各录一条 3 步 flow（含一次点击 + 一次文本输入），两次都通过回放；录制期间不出现 `INCOMPLETE_TREE` / `STALE_CAPTURE` 中止；报告里能看出"预热耗时"与"逐事件快照耗时"（不进 schema，用 stderr 或 CLI 输出）。

## 10. 边界

**现在能做（本机 macOS，不接触桌面）**
- 本文与后续设计文档；`src/desktop.ts`/`cli.ts` 的平台分支骨架与单元测试（用现有 fixture，不新增演示脚手架）。
- 离线路径（`--snapshot`、`report pack`、`viewer`、`flow validate`）的跨平台验证：这些代码没有平台分支。
- 用 macOS 数据构造的 flow 做纯解析/报告回归。

**必须 Windows 实机**
- 任何 live 行为：snapshot/bounds、语义 click、headed type、press、mouse-click。
- UIPI、DPI、多显示器、最小化、HWND 复用、前台锁。
- 钩子与 HUD：`LowLevelHooksTimeout`、静默移除、穿透、`WDA_EXCLUDEFROMCAPTURE` 版本差异。
- Chromium/WPF 的时延与树失真。
- npm 包内 Windows 二进制与 `version` 输出、SmartScreen/SAC。

**不建议做（首版）**
- 中文/IME 文本录制与回放；拖拽、滚轮、多窗口、弹窗自动应答。
- UWP/Store 应用、`ApplicationFrameHost` 深挖。
- 服务/Session 0/锁屏/安全桌面/另一用户会话上的自动化。
- Windows CI 或任何需要桌面会话的 CI 自动化。
- 沙箱、held input、`menubar` surface、跨平台 flow 迁移。
- 用 `shell: true` 调 provider 换取"兼容性"。

## 11. 未实机验证清单（必须在 Windows 上逐条确认）

1. npm `agent-desktop@1.3.1` 在 win32/x64 与 win32/arm64 上都装得上，`version` 输出 `1.3.1`，`status` 报 `supported_surfaces`。
2. `snapshot --include-bounds --max-depth 50` 被接受；50 层是否触顶。
3. `identity_unproven` 在真实目标上的出现频率，以及重试一次更大 `--timeout-ms` 是否足够。
4. `press --window-id` 在目标非前台时是否可用（文档只写了 `--app` 的 fail closed）。
5. `key` 枚举里 `backspace`、`forwarddelete`、`pageup`、`pagedown`、`delete` 的实际键名与物理键。
6. `type --headed --stdin` 的 `delivery` 分布（`delivered_unverified` 是否成为常态），以及 `ACTION_FAILED/post_action_verification` 的触发条件。
7. `focus-window` 在本机的前台锁下的成功率，以及 `ensure: window_ready` 的期望值要不要改成 `is_focused` 轮询。
8. WH_KEYBOARD_LL 是否能看到发往 High 完整性窗口的按键（本文没有证据，不能假设"看得到"或"看不到"）。
9. `ToUnicodeEx` 在目标布局/大写/Shift 下的还原正确率，以及 dead key 的副作用。
10. `WDA_EXCLUDEFROMCAPTURE` 在目标 Windows 版本上的实际效果（录屏 / 截图两条路径）。
11. 最小化窗口的 `bounds` 与 `is --property visible` 实测表现，确认"静默假通过"是否真实存在。
12. HWND 在长时间会话中的复用是否会让旧 `windowId` 命中新窗口。

## 12. 来源

- agent-desktop v1.3.1 仓库：`README.md`、`skills/agent-desktop-windows/SKILL.md`、`skills/agent-desktop-windows/references/{permissions-and-elevation,troubleshooting}.md`、`skills/agent-desktop/references/{commands-observation,commands-interaction,commands-system}.md`、`apps/docs/content/docs/platforms/windows.mdx`、`npm/lib/windows-bin.js`、`npm/package.json`、`probes/windows/FINDINGS.md`（行号 A1-2/A1-3/A9-2/A9-3/A16-11/A17-1/A17-4/A17-5/A18-2/A18-7/A19-8/A21-6/A23-6/A24-8/A24-16/A24-17）、`crates/windows/src/tree/{roles,states}.rs`。当前仓库固定的版本见 `src/desktop.ts` 的 `agentDesktopVersion`。
- Windows 官方文档：`SetWindowsHookExW`、`LowLevelMouseProc`（安装线程上下文、消息循环、`LowLevelHooksTimeout`、静默移除、Raw Input 建议）、`SetWindowDisplayAffinity`（`WDA_EXCLUDEFROMCAPTURE`，Win10 2004+）、`Window Features`（分层窗口、`WS_EX_TRANSPARENT` 穿透、前景锁 `SetForegroundWindow` 限制）。
- Node.js 官方文档：`child_process` 的 "Spawning .bat and .cmd files on Windows"（`.bat`/`.cmd` 不能用 `execFile` 启动）。
- 本仓库代码事实：`src/desktop.ts`（`commandRunner`、`type` 的 headed 取值、`ensure` 的 darwin 门槛、`snapshot` 预算）、`src/cli.ts`（`macOnly`、`--app` 正则）、`src/record.ts`（`w-<n>` 窗口号、1200ms 逐事件快照、`STALE_CAPTURE` 2s 判据、`[ -~]` 文本过滤）、`src/locator.ts`（`parseBounds`、`contains`、`hitTest`）、`native/*.swift`（采集协议与热键状态机）、`scripts/build-recorder.sh`、`.github/workflows/ci.yml`。
