# Windows 首版（W1）范围决策与实施拆分

HAOC-74 在 [Windows 适配可行性与驱动边界](windows.md)（HAOC-67）之上给出范围决策：Windows 首版做哪些命令、驱动与录制各做到哪一步、怎么验收。

**本轮在 Windows 上执行过的命令数：0。** 本机是 macOS，所有 Windows 行为结论来自上游文档/探针与仓库代码阅读，逐条标注「代码事实 / 上游证据 / 推断 / 需实机」。这里没有一条 Windows 实测结论，也不把 macOS 上的离线回归当作 Windows 已验证。

## 1. 决策摘要

1. **回放先行，录制后置。** W1 = 在 Windows 上手工写/拾取 flow，并对已打开的目标应用回放；`record` 不在 W1，登记为 W2（见 §6 T3）。
2. **目标必须已运行、窗口已存在。** 不启动应用、不自动恢复最小化、不做前置条件修复；失败即阻塞，并给出人工操作提示。
3. **W1 的实时回放必须显式 `--headed`。** Windows 无头 `type` 返回 `POLICY_DENIED`；`run`/批量在 win32 上缺少 `--headed` 时直接报 `HEADED_REQUIRED`，不静默切换模式。
4. **不引入 Windows CI。** 离线分支在 macOS CI 用注入平台测；真实行为只在 T2 实机验收（HAOC-76）。
5. **flow 不跨平台迁移。** 应用标识、键名、坐标、UI 文案都按平台不同；跨平台只共享 schema、报告包与查看器。
6. **报告与查看器是跨平台的。** 归档条目名规范化为 `/`、ZIP 使用固定时间戳，查看器是自包含静态页（代码事实，见 §7.5）。

录制后置的三个理由：录制桥是独立原生工程（钩子 + HUD + 热键）；Windows 没有 macOS `IsSecureEventInputEnabled` 的对应物，密码输入无法在采集源头屏蔽；`LowLevelHooksTimeout` 静默移除、`WDA_EXCLUDEFROMCAPTURE` 版本差异都必须实机才能确认。先交付可验证的回放，录制等 W1 通过后再开。

## 2. 能力范围

| 能力 | W1 | 条件与依据 | 验收方式 |
| --- | --- | --- | --- |
| `flow validate`、`report pack`、viewer | **支持** | 纯 Node，无平台分支（`src/cli.ts:81`、`:271`） | 离线 |
| `run --dry-run --snapshot`、`pick --snapshot` | **支持** | 离线夹具路径，与平台无关 | 离线 |
| `pick`（实时） | **支持** | 只读快照，不点击不聚焦；依赖 T1 快照预算 | 实机 |
| `run --dry-run`（实时） | **支持** | 读 UIA 树解析定位器；不发送输入 | 实机 |
| `run --headed` | **支持（核心）** | 元素定位的 click/type/key；承诺 ASCII 文本（非 ASCII 未验证）；目标窗口标题在运行中必须不变（§7.1）；`delivered_unverified` 按现有语义接受，效果由断言或文件核对证明 | 实机 |
| `run --data`（批量） | **支持** | 复用 run 的每条约束 | 实机 |
| 断言：element `exists`/`visible`/`text`/`value`、window `exists`/`title` | **支持** | 走同一 UIA 读路径 | 实机 |
| 断言：window `screenshot` | **不做** | 上游 v1.3.1 Windows 文档未列 `screenshot`，本项目也没有其实机证据；计划阶段直接拒绝，实机确认后另开 | 实机 |
| `workbench` | **有限** | 打开运行目录、时间线、编辑、离线回放、报告查看可用；应用目录与实时回放不可用（`src/app-catalog.ts` 只用 `system_profiler`/`mdls`；`src/workbench.ts:93` 已把 live 限定 darwin） | 离线 + 实机 |
| `setup.ensure` | **有限** | 检查照常执行；win32 不提供修复（不启动、不聚焦）。未通过时 `ensure` 直接报 `ENSURE_FAILED`，提示手动打开目标窗口 | 实机 |
| `point` 点击 | **有限** | 必须 `--headed`；物理像素；只保证同机同缩放；优先用 ref | 实机 |
| 报告上传（HAOC-73） | **支持（以合入为准）** | 纯 Node HTTP 客户端；本分支 main 尚无 `upload` 子命令，合入后不需要平台分支，T2 附带核对一次 | 实机 |
| `record` | **不做（W2）** | 见 §1、§4 | — |
| shell 步骤 | **不做** | HAOC-79/82 的设计是 POSIX sudo + 固定任务；Windows 执行身份模型未定 | — |
| UWP/Store 应用、IME/中文、拖拽/滚轮/多窗口、锁屏/Session 0/其他用户、sandbox/held input/menubar、Windows CI、跨平台 flow 迁移 | **不做** | [Windows 适配](windows.md) §10 已列；W1 不重新评估 | — |

为什么 workbench 不开实时回放：录制的采集桥与回放共用 agent-desktop 的独占交互租约，同一时刻只能有一个 live 命令；工作台内再叠一层前端驱动，收益低、失败面大。W1 的工作台只用于整理与看报告，live 操作走 CLI。

为什么不让 `ensure` 启动应用：Windows 上 `--app`（`list-apps`/`list-windows`）收的是镜像名，而 `launch` 收绝对路径或 System32/Windows 裸名，一个字符串服务不了两个用途（[Windows 适配](windows.md) §4.6）。W1 不改 schema、不引入路径约定，直接要求目标已打开。

## 3. 驱动方案

### 3.1 抽象结论

`Desktop` 的 9 个方法里，除 `screenshot` 外的 8 个在上游 Windows 文档中都有实现路径，**不拆接口、不改现有签名**（`screenshot` 未在 Windows 文档列出，W1 不用它，见 §2）。缺的是三个"跑之前必须先确认"的能力，W1 把它做成 `withDesktop` 内部行为，只新增一个可选预检方法：

| 缺口 | W1 做法 | 不做的后果 |
| --- | --- | --- |
| 窗口是否最小化 | 快照后检查窗口根 `bounds`；缺失或零宽高即阻塞 | 最小化的窗口读得到、语义 click "成功"、实际什么都没发生（假通过） |
| 目标是否在前台 | 仅当本轮会发送输入时，`focus-window` 一次 + 1.5 s 轮询 `is_focused` | 前台锁导致 `focus-window` 失败后仍然键入，输入落到别的窗口 |
| provider 是否可执行 | win32 必须用 `CUEKEEPER_AGENT_DESKTOP` 指向原生 exe | `execFile` 拉不到 npm 的 `.cmd` shim，所有 live 命令直接不可用 |

UIA 与 agent-desktop 的边界：树读取、定位、动作全部经 agent-desktop；Node 侧不直接调 UIA/COM，W1 不新增任何原生代码。平台差异只体现在"传哪些参数、怎么解释错误、什么时候拒绝执行"。

### 3.2 文件级改动（W1）

| 文件 | 改动 | 离线验收 |
| --- | --- | --- |
| `src/desktop.ts:53` | provider 解析：win32 只接受 `CUEKEEPER_AGENT_DESKTOP` 指向的原生 exe；未设置或不是文件 → `DESKTOP_DEPENDENCY`（退出码 2）并给出设置示例。**不退回 `shell: true`**：`flow.target.app` 是自由字符串，会被 cmd 解释 | stub 环境断言错误的退出码与消息 |
| `src/desktop.ts:248` | `type` 在 win32 恒带 `--headed`，文本继续走 `--stdin`（不进命令行） | 断言参数数组 |
| `src/desktop.ts:32` | `PERM_DENIED` / `ACCESS_DENIED` / `PLATFORM_NOT_SUPPORTED` 标为依赖错误（退出码 2）；`POLICY_DENIED` 保持退出码 1，消息写明"被策略拒绝"而不是"依赖缺失" | 逐码断言 |
| `src/desktop.ts:117` | win32 快照预算：首读 ≥8000 ms；`INCOMPLETE_TREE` / `identity_unproven` 用 20000 ms 重试一次，仍失败即失败 | 断言只重试一次且第二次预算 |
| `src/desktop.ts:117` 附近 | `WindowInfo` 保留 `list-windows` 已返回的 `pid`，窗口绑定改为 `(id, pid, title)`；任一变化报 `WINDOW_CHANGED` | 替换 pid 的 fixture |
| `src/desktop.ts`（新增可选方法） | `preflight(target, { needsInput })`：绑定窗口 → 最小化检查 → 需要输入时确认前台 → 返回首个快照。`WINDOW_MINIMIZED`、`WINDOW_FOCUS_UNCONFIRMED` 都在任何动作之前抛出 | 最小化/未聚焦 fixture 断言零动作 |
| `src/desktop.ts:157` | win32 `ensure` 不启动、不聚焦：返回明确错误（报告 `ENSURE_FAILED`，非依赖退出码），提示手动打开目标窗口 | 断言未调用 `launch`/`focus-window` |
| `src/cli.ts:56` | `macOnly()` 改为按命令判断能力：`pick`/`run`/批量允许 darwin + win32；`record` 仍 darwin-only，消息指向 W2 | 断言各命令的平台门 |
| `src/cli.ts:94` | `--app` 校验分平台：win32 接受 `list-apps` 名字（可含空格与点，如 `notepad.exe`），拒绝路径分隔符、控制字符、首尾空白、`.`/`..`；macOS 保持 bundle ID 正则 | 新旧两份用例 |
| `src/cli.ts:139` | win32 的 `run`/批量：非 dry-run 且缺 `--headed` → `HEADED_REQUIRED`，退出码 1，**不静默加 headed**；dry-run 不受限 | 断言退出码与零驱动调用 |
| `src/cli.ts`（计划阶段） | win32 流程含截图断言 → 计划阶段拒绝（`UNSUPPORTED_PLATFORM`，退出码 2），不做"跑到那一步才发现" | 计划用例 |
| `src/run.ts` | 实时运行用 `preflight` 替代首个 `snapshot`；dry-run 和离线路径不变 | 现有用例回归 |

不改：`src/contracts.ts`、`schemas/*`、`src/locator.ts`、`src/record.ts`、`native/`、`.github/workflows/ci.yml`。`flow.target.app` 在 schema 里本来就是自由字符串（`src/contracts.ts:7`、`:27`），Windows 镜像名不需要 schema 改动。

### 3.3 错误码与退出码

| 情形 | 错误码 | 退出码 | 用户可见提示 |
| --- | --- | --- | --- |
| provider 缺失/不是原生 exe | `DESKTOP_DEPENDENCY` | 2 | 设置 `CUEKEEPER_AGENT_DESKTOP` 到原生 exe 的绝对路径 |
| 目标以管理员运行（UIPI） | `PERM_DENIED`（dependency） | 2 | 目标进程完整性更高，请用同级终端或非提权实例重跑 |
| flow 请求被策略拒绝（如 `alt+f4`） | `POLICY_DENIED` | 1 | 该组合键在 Windows 被驱动策略拒绝，改用其他步骤 |
| 目标窗口最小化 | `WINDOW_MINIMIZED` | 1 | 手动恢复窗口后重跑；W1 不自动恢复 |
| 前台锁导致无法确认焦点 | `WINDOW_FOCUS_UNCONFIRMED` | 1 | 手动把目标窗口切到前台后重跑；未发送任何输入 |
| 窗口身份变化 | `WINDOW_CHANGED` | 1 | 目标窗口已更换，重新拾取或重新录制 |
| 缺少 `--headed` | `HEADED_REQUIRED` | 1 | Windows 实时回放必须 `--headed` |

报告 schema 的 `code` 是自由字符串（`schemas/report.schema.json:101`），新增错误码不需要 schema 版本变更。

### 3.4 并发

agent-desktop 在 Windows 上有跨进程独占交互租约。W1 不做自己的锁：同一时刻只允许一个 live 命令（文档写明）；上游返回租约冲突时原样透出错误码与提示，不重试、不排队。

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
| R5 | HWND 是 16 位计数器，会话内可能复用 | 绑定 `(id, pid, title)`；长会话建议重录 |
| R6 | 前台锁导致 `focus-window` 失败 | 只做一次聚焦 + 轮询确认；失败零输入并提示人工前置 |
| R7 | 交互租约独占，录制与实时回放不能并行 | 文档写明；错误原样透出，不重试 |
| R8 | 锁屏 / Session 0 / 断开 RDP / 另一用户会话 | 不支持；preflight 只能间接发现（窗口不可见/无树），按观测失败阻塞 |
| R9 | 长路径：Node 不会自动加 `\\?\`；未启用 LongPathsEnabled 时 >260 字符路径会失败 | 不改写用户路径；文档写明启用方法；T2 用深路径负例记录实际错误（仓库设置的 `core.longpaths` 只影响 git） |
| R10 | 截图断言在 Windows 无证据 | W1 计划阶段拒绝，实机确认后再开 |
| R11 | flow 跨平台误用（`meta` 是 Win 键、`delete` 语义不同） | 按平台产物；不做迁移，文档写明 |
| R12 | 未签名 exe 触发 SmartScreen/杀软（W2 录制器） | W2 处理；W1 不引入新二进制 |
| R13 | 目标应用在运行中改窗口标题（编辑器标记未保存状态） | 每次快照都要求标题精确相等（`src/locator.ts:85`），编辑后第一步就 `WINDOW_MISMATCH`。W1 不改契约：门禁选标题稳定的应用（§7.1），限制写进文档；是否放宽交 mac-codex 决策 |

## 6. 实施拆分

三个子任务已作为 HAOC-74 子单登记为 `backlog`（缺实机，不提前开跑）：T1 = HAOC-84，T2 = HAOC-83，T3 = HAOC-85。

| 任务 | 一句话目标 | 可观察验收 | 依赖 |
| --- | --- | --- | --- |
| **W1-T1**（HAOC-84）驱动层平台化（离线） | 让 win32 分支按"回放-only"成型，并在 macOS 用注入平台 + stub provider 测出来 | §3.2 每一行都有对应用例：退出码、参数数组、重试次数、零动作；`pnpm build && pnpm test` 绿；macOS 旧用例全过 | 无实机、无 CI 改动 |
| **W1-T2**（HAOC-83）Windows 实机验收（W1 出口） | 手写 flow 对标题稳定的编辑器完成 pick → dry-run → headed 十轮 + 负例 | 十轮 10/10；保存后文件含预期字符串且标题不变；负例各自的错误码与"零输入"；报告在 macOS 可打开且 manifest 一致 | T1；Windows 实机 + 用户在场（HAOC-76） |
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

**经典记事本不能作为 W1 门禁。** Win10 1809+ 的记事本在标题栏标记未保存状态（`*`，需实机复核）；本项目每次快照都要求窗口标题与 flow 完全相等（`src/locator.ts:85`），所以 `type` 之后的第一步（`Ctrl+S` 前取快照）会以 `WINDOW_MISMATCH` 失败。这是平台行为与现有契约的冲突，**本单不改契约**。

机器上没有满足条件的编辑器时（例如 Win11 24H2 起 WordPad 已移除，新记事本同样标记修改）：停止验收，把「标题漂移是否放宽」交 mac-codex 决策。候选是 (a) 写进平台限制文档，(b) 绑定后以 `(id, pid)` 识别、不再逐次比对标题。不自行改契约，也不靠"改 flow 标题"绕过。

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
node dist/cli.js report pack out\run-01.json --flow out\w1.flow.json --out out\run-01.zip --json
```

### 7.3 十轮

| 轮次 | 起点 | 操作 | 通过判据 |
| --- | --- | --- | --- |
| 1–10 | 文件已清空并保存，编辑器窗口唯一且在前台 | `run --headed --report out\run-NN.json` | 3 步全 `passed`；窗口标题全程不变；保存后的文件包含预期 ASCII 字符串（逐字符），修改时间变化，未出现格式/确认对话框 |

每轮记录：报告文件名、三步状态、保存后文件内容、是否出现 `delivered_unverified`（允许，但要用文件内容核对证明生效）。任一轮失败即停止，保留现场与日志，不改契约硬凑。

### 7.4 负例

| 场景 | 预期 |
| --- | --- |
| 先最小化编辑器再运行 | `WINDOW_MINIMIZED`，零动作，文件未变 |
| 编辑器以管理员身份运行 | 首条动作 `PERM_DENIED`，退出码 2，文件未变，提示用非提权实例 |
| 目标未运行 / 标题不匹配 | `APP_NOT_FOUND` / `WINDOW_NOT_FOUND`，退出码 1，不尝试启动 |
| 切到别的窗口后立即运行 | `WINDOW_FOCUS_UNCONFIRMED`，零输入，别的窗口内容未变 |
| 去掉 `--headed`（非 dry-run） | `HEADED_REQUIRED`，零驱动调用 |
| 运行中把目标窗口另存为新名字（标题变化） | 下一步 `WINDOW_MISMATCH`；记录实际时序，不要求修复（R13） |
| 测试目录路径 >260 字符 | 记录实际错误（预期 `ENAMETOOLONG` 一类），不作为 W1 出口 |

### 7.5 报告跨平台读取

- 报告包结构固定：`index.html`、`report.json`、`flow.json`、`manifest.json`、可选 `assets/`；打包时条目名 `\` 统一成 `/`（`src/report.ts:20`），ZIP 时间戳固定为 1980-01-01（`src/report.ts:127`）。条目名与时间戳这两处平台差异已被消除，原则上同一份输入在两个平台打出的归档一致（仍需 T2 实机比对 manifest 确认，见 §8 第 16 条）；查看器是自包含静态页，不联网、不需要后端。
- 验收：Windows 上 `report pack` 后 `unzip -t` 通过；把 zip 拷到 macOS，解压打开 `index.html`，时间线、状态、失败详情与 Windows 上一致。再在 macOS 用同一份 `report.json` + `flow.json` 打一次包，比对 `manifest.json` 的每个 SHA-256（应一致）。
- 说明：`flow.json` 里的 `target.app`（如 `wordpad.exe`）与盘符路径在 macOS 只作展示，不解析本机应用；**不在 macOS 上回放 Windows 的 flow**。截图断言的基线是逐像素、按同一窗口尺寸和缩放，跨平台不通用，W1 也不开截图断言。
- 上传（HAOC-73 合入后）：Windows 生成的 zip 走一次 mock server 校验，记录结果，不作为 W1 出口。

## 8. 需实机确认（转 HAOC-76）

以下全部是**未验证**项，T2 逐条记录结果；与 [Windows 适配](windows.md) §11 重叠的部分以本节范围为准。

1. npm 包装出的原生 exe 在 win32/x64 与 arm64 上都能运行，`version` 报 1.3.1。
2. `snapshot --include-bounds --max-depth 50` 被接受；50 层是否触顶。
3. `type --headed --stdin` 的 delivery 分布，`delivered_unverified` 是否成为常态。
4. `focus-window` 在当前前台锁下的成功率，1.5 s 轮询是否够。
5. 首选应用（WordPad）的正文控件 role/name、`get --property text` 是否可读，`Ctrl+S` 是否静默。
6. 记事本（经典与 Win11 新记事本）编辑后窗口标题是否真的变化，确认 §7.1 的排除成立。
7. WordPad 编辑与保存过程中窗口标题是否不变；Win11 24H2+ 上是否还有可用替代。
8. 最小化窗口的窗口根 bounds 与 `is --property visible` 实测表现，确认 `WINDOW_MINIMIZED` 判据成立。
9. UIPI：管理员身份的编辑器上读成功、写失败的顺序与错误码。
10. 键名别名：`delete`/`backspace`/`pageup`/`pagedown`/`forwarddelete` 的实际物理键。
11. 物理像素坐标在 100%/150%/200% 缩放、双屏（含负坐标）下的表现。
12. `screenshot` 子命令在 Windows 是否可用（决定截图断言何时放开）。
13. 长时间会话中 HWND 复用是否让 `(id, pid, title)` 绑定失效。
14. 深路径（>260 字符）的实际错误与系统设置要求。
15. 交互租约冲突的错误码与文案。
16. `report pack` 在两个平台的 manifest 是否逐字节一致（离线可先在 macOS 侧准备脚本，Windows 侧实跑）。

## 9. 证据状态

**已实机验证：0 项。** 本轮没有 Windows 机器，没有在 Windows 上执行任何命令。

**代码事实**（本机 macOS 阅读，2026-11-21）：`src/cli.ts:56` 的 `macOnly` 与 4 处调用（`:105` pick、`:171` 批量、`:204` run、`:250` record）；`src/cli.ts:94` 的 bundle ID 正则；`src/desktop.ts:53` 的 `execFile` 解析、`:117` 的 3000 ms 默认快照、`:157` 的 darwin 门槛、`:248` 的无头 `type`；`src/workbench.ts:93` 的 live 门；`src/app-catalog.ts` 的 `system_profiler`/`mdls`；`src/record.ts:155` 把 `w-<数字>` 当窗口号、`:158` 的采集二进制名；`src/locator.ts:46` 的 bounds 正数校验、`:83` 的 `complete !== true` 判据与 `:85` 的窗口标题精确比对；`src/contracts.ts:7` / `:27` 的 `target.app` 自由字符串；`src/report.ts:20`、`:127` 的条目名规范化与固定时间戳；`schemas/report.schema.json:101` 的 `code` 自由字符串；`.github/workflows/ci.yml` 只有 macOS job。

**上游证据**：[Windows 适配](windows.md) §12 的 agent-desktop v1.3.1 文档/探针与 Windows 官方文档。本轮的 Windows 行为判断都建立在这些之上，属"上游可用"，不等于本项目实测。

**推断**：录制桥的语言选型与构建方式、HUD 版本降级行为、`Ctrl+Alt` 冲突可接受性、Win11 新记事本的树质量、`focus-window` 轮询 1.5 s 是否足够、深路径错误形态。

## 10. 与现有设计的关系

- 可行性、差异清单与未验证项：[Windows 适配](windows.md)（HAOC-67）。本文只做范围与实施决策，不重复其证据。
- 应用身份：W1 不启用 `target.appPath` 的 Windows 路径绑定（[应用副本身份](app-identity.md) 的路径校验与实例绑定属另一条线）；Windows 用 `list-apps` 镜像名，目标需已运行。
- 报告与上传：[离线报告包](report.md)、[报告上传协议](upload-protocol.md)、[上传架构](upload-architecture.md)。
- 断言：[M2 断言扩展设计](assertions.md)。W1 只开元素/窗口文本类断言，截图断言待实机。
- 录制：[TextEdit 现场验收](textedit.md) 是 macOS 的等价物；Windows 的录制验收在 W2-T3。
- 里程碑：`docs/architecture.md` 的 M3 段落补一句指向本文。
