# CueKeeper macOS 全局录制与跨 App 回放

HAOC-108 · 设计评审稿 · 基线 `3ada404`

`cuekeeper record --global` 开启当前 macOS 登录会话的录制。用户可切换 App 和窗口，工作台按实际顺序展示操作。全局 flow 使用 `version: 2`，每步声明作用域，回放按同一顺序验证并执行。归属不明、界面不可验证或涉及敏感数据时，时间线上留下可见的缺口，运行前要求用户处理。HAOC-107 的一键窗口识别继续走 v1。

## 1. 捕获与作用域

现有 `native/recorder.swift` 使用会话级 CGEvent tap，按目标 App 和原生窗口过滤事件。`src/record.ts` 固定读取一个窗口，并在焦点变化时切断文本与滚动合并。v2 复用这些边界和输入归一化逻辑，在原生捕获端先判定事件归属，再交给 TypeScript 生成步骤。CGEvent 提供事件时间，AX 与前台通知各自存在可见延迟。[Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent) · [Apple AX 通知](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/notifications)

| 输入 | 归属证据 | 切换规则 |
| --- | --- | --- |
| 键盘 | 事件时刻的前台 PID、AX focused window 和 focused element。事件提供目标 PID 时要求一致 | 只接受可证明落到对应窗口的输入。Cmd+Tab 等切换在最终 App 和窗口得到确认后形成导航步骤，候选经过的 App 无步骤 |
| 点击、悬停、滚动 | 从事件点进行原生命中测试，核对 AX owner PID、窗口号、层级与上层遮挡 | 鼠标按下冻结作用域。已证明只激活窗口的点击生成导航。有证据交付给控件的点击保留为点击。无法区分时记缺口，避免回放时预聚焦改变第一次点击的含义 |
| 点击目标身份 | 命中元素自身有名字就用它；否则沿 item 角色（cell/row/statictext/image）向上找有名字的项，文件项标签的名字也可以来自其 value | 只有角色没有名字的点击不是目标：记坐标并告警 `UNTARGETED_FILE_CLICK` / `UNTARGETED_ELEMENT_CLICK`，回放前必须改成有名字的元素；回放遇到无名元素目标按 `AMBIGUOUS` 拒绝，不会静默点同角色的其他元素 |
| 拖拽 | 记录按下和抬起的 owner / window，拖拽期间绑定原窗口 | v2 先支持单窗口内拖拽。跨窗口、跨 App 拖放记 `CROSS_SCOPE_GESTURE` |
| 焦点变化 | `NSWorkspace` 激活通知、AX focused window 变化和原生窗口清单 | 同 App 切窗也推进焦点世代。由上一步引发且可验证的切换用 `focusAfter`，有明确用户切换证据的生成独立步骤。仅有迟到通知时记缺口 |

`list-windows` 提供 `pid`、`id`、`is_focused` 等字段，按 `pid` 与 `list-apps` 的 `bundle_id` 关联。录制开始与窗口归属冲突时，查询清单并交叉核实原生观察，要求前台 App 下只有一个一致的 focused window。PID 与进程启动标识只在当前会话缓存，进程退出或身份发生变化时失效。清单是查询时刻的状态，不能倒推已经结束的事件。原生 AX 系统级命中可区分叠在普通窗口上的界面。[Apple AX 命中测试](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition) · [Apple 前台应用](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication) · [agent-desktop 清单字段](https://github.com/vercel-labs/agent-desktop/blob/main/skills/agent-desktop/references/commands-system.md)

- Tap 回调只采集有限的事件元数据并快速返回。原生观察器为证据分配递增序号与单调时间，记录前后焦点世代、进程实例和窗口身份。队列按序提交，迟到的通知只能确认已有证据。冲突、超时、权限丢失或队列溢出都会切断合并并记缺口，禁止把后一个窗口的快照回填给前一个事件。
- 录制路径不以「每条事件读一次窗口树」为前提。原生在每条 `text` / `key`（以及 `click`）事件上用 `kAXFocusedUIElementAttribute` 附加聚焦元素的 `role` / `name` / `bounds` / `editable` / `secure`，都是常数时间的单属性读取，不遍历树、不读控件值；secure 控件不带 label。TS 侧正常路径直接用这份证据构造 element target，`read` 调用为 0，字符到步骤的延迟只有内存操作。
- 读树只是兜底，且按窗口 + 焦点世代缓存：只有事件没带证据、也还没有 burst / 点击锚点时才读一次（快照预算 3 秒），读到或读不到的结果都缓存给后续字符，失败不级联。兜底读取不阻塞事件消费：文本先缓冲，读取在后台完成后再落成 `type` 步骤；读不到聚焦可编辑控件时按 `UNTARGETED_TEXT` 丢弃这几个字符并给警告，不产生 `STALE_CAPTURE` 缺口。队列落后 helper 超过 8 秒的文本统一按 `CAPTURE_BACKLOG` 丢弃，不生成一串缺口；录制开始 500 ms 内没有窗口证据的事件按 `CAPTURE_STARTUP` 丢弃。指针手势（滚动 / 悬停 / 拖拽）仍按 `--window-id` 读快照并核对 owner，读取失败时按缺口处理。
- **同一个窗口的树只读一次**：缓存键是 `app + pid + processInstance + windowNumber`，并记下读取时的窗口标题与窗口根 `bounds`。后续点击、悬停、拖拽、滚动与文本兜底都用这棵树补全 `path/index`，不再读树。失效条件是标题变化、事件点落在缓存 `bounds` 之外（窗口缩小或移动）、缓存 `hitTest` 为空、以及缓存超过 30 s TTL；命中任一条就重读一次并替换缓存。缓存按窗口分别保存，最多 8 个窗口（LRU 淘汰），secure 区间开始与结束时清空；切换焦点本身不让其他窗口的缓存失效。滚动用缓存里的「滚动前」树给自己的步骤命名，用完立刻丢弃，不留给后续事件。点击若把焦点移到缓存树没显示为聚焦的可编辑控件上，这棵树也立即丢弃，避免后续文本兜底沿用旧焦点。
- 坐标不是主路径：点击目标优先用 helper 的即时命中证据（`role` / `name`），已经读到的树只用来补全 `path/index`，绝不为了补全再读一次树；文本目标优先用 helper 的聚焦元素证据。只有当任何元素证据都没有时点击才落到 `point`——包括只命中窗口根的空白点击——并且必须带明确警告（`UNTARGETED_ELEMENT_CLICK` / `UNTARGETED_FILE_CLICK` / `NATIVE_POINT_FALLBACK`）。坐标步在工作台时间线上标成「坐标回放 · 需确认」，dry-run 以 `UNSAFE_POINT` 拒绝，必须先改成元素目标才能通过。
- Electron 编辑器（VS Code 一类）把文本面暴露在聚焦的可编辑控件之下，同时用一层更深的 group 承接指针命中。点击落点在聚焦可编辑控件的 bounds 内、而命中的是容器时，target 直接取聚焦控件（`FOCUSED_EDITABLE_TARGET`），点击与文本都不读树；点击当时没有焦点证据、后来由文本事件证明控件的，已记录的容器点击就地改成该控件（`CLICK_RETARGETED_TO_TEXT`）。没有焦点证据时复用点击证明的控件（`TEXT_TARGET_FROM_CLICK`）；既无证据也无点击锚点才走一次兜底读树。
- 对标题动态变化的窗口，录制会话内以原生窗口身份跟踪并复用同一 `windowKey`。窗口销毁后再开，即使标题相同，也分配新键。PID、原生窗口号、AX ref、事件坐标和未经筛选的 AX 树均不写入 v2 flow。

### 窗口以外的界面

| 界面 | AX 归属判定 | 支持边界 |
| --- | --- | --- |
| Dock | Dock 的系统级 surface，owner 用 AX 命中 PID 与受信系统组件交叉验证 | P3 按应用 bundle ID 选择图标。Dock 位置、自动隐藏和显示器变化由适配器验证，坐标不进入 flow |
| App 菜单栏和上下文菜单 | 菜单栏使用 owner App 的 `AXMenuBar`，owner 可以和键盘焦点不同。上下文菜单核对打开它的窗口与元素 | P3 记录 App 菜单路径，优先验证稳定标识，名称路径必须唯一且可识别本地化 |
| 系统状态项 | 通过系统级 `menu-bar-extras` 或状态项实际 owner 验证，可为系统进程，也可为第三方 App | P3 逐项开放经过实机验证的适配器，未知项记 `SURFACE_UNSUPPORTED` |
| Spotlight | 独立系统 overlay，以实际 AX owner、角色和可见性验证。适配器按支持的 macOS 版本识别，进程显示名仅用于诊断 | P3 验证打开与按 bundle ID 确认应用结果。任意搜索结果、排名、个性化建议及搜索原文均不进入契约 |
| Sheet、App 弹窗 | 验证宿主 PID、附着窗口与是否为普通 App UI | 同窗口可验证的普通 sheet 仍用窗口作用域，使用 sheet 下的控件 locator。独立窗口分配新键。不同 PID 的安装器或卸载器须有自己的可验证 bundle ID 和窗口 scope |
| 系统授权与密码界面 | 可能由独立的 Security Agent 呈现。来源以已验证的触发步骤和 secure 边界为证据 | 记录有作用域的人工检查点。无法关联触发窗口时保留 `SECURE_INPUT` 缺口。[Apple Security Agent](https://developer.apple.com/library/archive/documentation/Security/Conceptual/Security_Overview/Architecture/Architecture.html) |

上游区分 App 拥有的 `menu` / `menubar` 与系统 surface。其文档将 macOS Dock 的 `open-system-surface` 结果描述为无窗口 ID 的 surface，不能当作已经显示且可操作的证明。Spotlight 的 Command-Space 是系统常见入口，适配器需验证实际结果，不能假定快捷键仍是默认值。这些是能力探测的依据，CueKeeper 固定的驱动版本和目标 macOS 版本以 fixture 与批准后的实机验证为准。[agent-desktop surface 文档](https://github.com/vercel-labs/agent-desktop/blob/main/skills/agent-desktop/references/commands-observation.md) · [Apple AX 属性](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/attributes) · [Apple Spotlight 快捷键](https://support.apple.com/en-euro/guide/mac-help/mh26783/mac)

## 2. Flow、schema 与工作台

v1 的 `flowSchema` 和 `reportSchema` 都是 `version: 1` 的封闭对象。全局流采用独立的 v2 封闭对象和解析分支。v2 没有主窗口，也没有默认作用域。目标只从当前步骤产生。已有 v1 文件继续由原解析和执行路线处理，保存时保留原版本及哈希。旧版工具读取 v2 会拒绝。新工具在桌面调用之前完成版本与功能检查。

| 契约位置 | v2 schema diff |
| --- | --- |
| `Flow` | `version: 2`，保留 `id`、`name`、`steps`。移除 `target`。允许 `appPaths?: Record<BundleID, MacAppPath>`、`inputs?: InputName[]`、`intents?: Intent[]`。P2 支持 1–500 步，ID 唯一。顶层 `setup`、`behaviors`、`behavior` 调用和 `shell` 暂限 v1 |
| `step.scope` | `window` 为 `{ kind, app, windowKey, windowTitle }`。`app` 为 `{ kind, app }`。P3 `surface` 以 `surface` 枚举区分 `dock`、`app_menu_bar`、`app_context_menu`、`menu_bar_extras`、`spotlight`。App 菜单栏要求 `app`。上下文菜单还要求 `windowKey` 和 `windowTitle`。其他 surface 只含 `kind`、`surface`。`gap` 是唯一无作用域的步型 |
| 窗口与 App 步骤 | 窗口动作和元素断言使用 `window`。新增 `launch_app`、`activate_app` 使用 `app`，`focus_window` 使用 `window`。可能改变焦点的动作可带 `focusAfter`，使用与目标相符的 `window` 或 `app`。`type` 可用 `text` 或 `input`，二者必须恰有其一。`paste` 以 `source: { kind: "copy", stepId }` 或 `{ kind: "input", input }` 取代内联剪贴板值。窗口动作的 locator 使用元素契约，P2 拒绝 v2 原始坐标兜底 |
| 条件等待 | `wait` 允许 `window`、`app` 或 `file` scope。`check` 可为 `{ kind: "window_exists", equals }`、`{ kind: "element_enabled", target, equals }`、既有的安全元素条件，App scope 下的 `{ kind: "app_running" \| "app_installed", equals }`，或 file scope 下的 `{ kind: "file_exists", equals }` / `{ kind: "file_stable", quietMs }`。file scope 为 `{ kind: "file", directory, name }` 或 `{ kind: "file", directory, suffix }`，只读本地下载目录。进程退出用 `app_running: false` 的等值比较。`timeoutMs` 默认 15 秒，上限 30 分钟 |
| 人工检查点 | `manual_checkpoint` 包含 `id`、触发块的 `scope`（窗口）、`triggerStepId`、`reason: "secure_input"`、`resume: { scope, check }` 和 `timeoutMs`。触发步紧邻检查点，且作用域一致。`resume` 用同一套只读条件，由录制结果提出或由工作台确认。占位未确认或未填恢复条件时，作为缺口阻塞实时回放 |
| P3 与缺口 | `open_system_surface`、`surface_press` 使用 `surface`。`surface_press` 的 selector 按 surface 分支校验，例如 Dock 的 `bundleId`、App 菜单的标识路径。`gap` 只保存 `id`、`kind`、`code`，不包含原始事件。存在尚未处理的缺口时整条 flow 在产生副作用前被拒绝 |
| `Intent` | 沿用 HAOC-99 顶层注释模型。每个可执行注释保存 `id`、`action`、封闭的 `params`、连续的 `sourceStepIds`、`equivalence`、`skippedUiStepIds` 和 `observableEffects`。跳过的界面步骤必须是来源区间的有序子集。`observableEffects` 由适配器定义，包含作用域及可验证条件，例如 Installer 打开指定 pkg。可执行的 `equivalence` 限于 `same_ui` 和 `same_end_state`。编译后的计划项继承原始区间的起止作用域。替换区间不得重叠，区间、参数、类别或效果变更后重新确认 |
| 引用规则 | `app` 为已解析的 bundle ID。`windowKey` 在 flow 内唯一绑定 App，同键后续可携带新标题作为显示名。首次绑定使用首次实际需要时的精确标题。`appPaths` 每个 bundle ID 最多一条 macOS 绝对 `.app` 路径，且必须被该 flow 引用。`inputs` 保存参数名，不保存值。引用必须存在，`copy.stepId` 必须指向已出现的合规复制步。解析器另校验作用域、动作和 P2/P3 能力组合 |
| `Report` | `version: 2` 并保留 `flowId`、`flowSha256`、`startedAt`、`mode`、`status` 和顺序 `entries`。每个 action entry 带 `scope`，可带 `phase`、经验证的语义来源、`delivery` 与错误码。语义结果含 `intentId`、`sourceStepIds`、实际采用的 `equivalence`、实际跳过的 `skippedUiStepIds` 与效果核验结果。回退时按原始步骤记结果，并保留未采用的候选及原因。身份验证按 App 记录，移除单数 `appIdentity`。缺口、全局验证失败可以没有作用域。报告不含运行时 PID、绝对 App 路径或输入原文 |

最小跨 App 样例，前两个窗口标题均来自待回放的测试夹具。

```json
{
  "version": 2,
  "id": "cross-app-smoke",
  "name": "跨 App 输入并检查窗口",
  "inputs": ["sampleText"],
  "steps": [
    {
      "id": "s1", "kind": "type",
      "scope": { "kind": "window", "app": "com.apple.TextEdit", "windowKey": "editor", "windowTitle": "QA Notes" },
      "target": { "kind": "element", "role": "textfield" }, "input": "sampleText"
    },
    {
      "id": "s2", "kind": "activate_app",
      "scope": { "kind": "app", "app": "com.apple.finder" },
      "focusAfter": { "kind": "window", "app": "com.apple.finder", "windowKey": "files", "windowTitle": "QA Files" }
    },
    {
      "id": "s3", "kind": "assert",
      "scope": { "kind": "window", "app": "com.apple.finder", "windowKey": "files", "windowTitle": "QA Files" },
      "check": { "target": { "kind": "window" }, "expect": { "property": "title", "equals": "QA Files" } }
    }
  ]
}
```

**哈希与分发。** 沿用 `hashFlow` 对完整文档的 canonical JSON 算 SHA-256，递归排序对象键，保留数组顺序。v2 的版本、scope、步骤顺序、应用路径、参数名和已保存 intent 都参与哈希。报告关联用 `flowId + flowSha256`，执行时提供的输入值和机器快照不进入哈希。`scripts/schemas.mjs` 发布版本化 schema，保留现有 v1 schema 路径。P2 接入 CLI validate/record/run、工作台与本地报告查看。现有 batch、独立 behavior 和上传打包依赖 v1 契约，P2/P3 使用时提前给出 `UNSUPPORTED_FLOW_VERSION`，后续按入口独立支持。

**时间线。** 用 `stepId` 关联录制、计划、报告和证据。每行显示 App、窗口或 surface，同一作用域连续段可折叠并保留原始序号。支持按 bundle ID + `windowKey` 筛选，另给每个作用域显示步骤、失败与耗时汇总。跨 App 切换显示独立行，步骤自己的 `focusAfter` 展示为结果。快照与拾取状态按 `windowKey` 隔离。切换选择、重新捕获或编辑过 flow 后，只有作用域和哈希匹配的快照及报告可关联。

**Setup 推断。** 按输入、导航及 `focusAfter` 首次引用派生 `app_running` 与 `window_ready` 提示，分别去重到 bundle ID 和 `windowKey`，显示首次需要的 `stepId`。纯观察步骤不生成启动或开窗口的修复提示。明确的启动、激活和聚焦动作出现在录制的位置，且满足其后的相应提示。观察就绪与自动启动在首次实际需要处记为 `prepare`，可在报告展开。若窗口要由前序动作打开，只等待实际出现，避免提前执行、伪造文档窗口或改变依赖时序。

## 3. 回放编排

**会话准备。** 校验 flow、缺口、能力、运行时输入和 App 路径格式，创建只覆盖本次运行的桌面独占租约与取消监听。实时 v2 需操作者显式开启前台回放。有人工检查点时还需可用的人机交接通道。只读 dry-run 使用按作用域索引的离线 fixture，输出 `resolved` 或不可验证，且无启动、聚焦、剪贴板与输入操作。后台/批量模式拒绝 v2 的实时执行。

```text
Validate → ResolveScope → Prepare → ConfirmForeground → Dispatch → Verify → Next
                         └─ read-only → ObserveScoped → Verify → Next
                         └─ manual_checkpoint → HandOff → ObserveScoped → Next
any failure/cancel → Stop → Release
```

1. **ResolveScope**。按 bundle ID 建进程会话，复用 `AppIdentitySession` 的路径、窗口 owner 与原生身份验证。需要绑定或启动时，校验 `.app` 的真实路径与 bundle ID，允许前置步骤安装该 App。有 pin 时从精确 URL 启动并反查实际进程，禁止替换成同 ID 的其他副本。无 pin 时要求唯一已运行实例，或在获准启动时唯一已安装副本。v2 多 App 用 `appPaths`，拒绝含糊的单值 `--app-path`。同一 flow 暂以一个 bundle ID 对应一个已绑定进程实例。只读检查可观测该进程退出，后续输入需要它时不得静默重新绑定。
2. **Prepare**。对输入步，在该 App 首次需要时按授权启动缺失 App，默认准备预算 15 秒，可取消。运行中已绑定进程消失时停止，防止用新实例接着旧状态。`launch_app` 允许已运行的同一实例作为幂等成功，明确校验启动结果。`activate_app` 要求进程已运行，`focus_window` 只聚焦已解析的窗口。窗口首次精确标题匹配必须唯一。绑定后跟随已证明存续的同一窗口，改名继续可用，原窗口消失或身份不再可证时阻塞。同标题的新窗口不能接管旧键。下一步需要另一个窗口时使用新键。
3. **ConfirmForeground**。当作用域确需输入时，确认前台 PID、窗口号、focused window/element 或 surface owner 一致，并检查模态层、secure input、用户输入与焦点世代。菜单动作先验证所属 App 的菜单栏，从根重新解析并等待层级可用。窗口切换前收束本运行打开的菜单，核对已关闭后才继续。普通断言在 `ObserveScoped` 路径读目标对象，无须抢焦点。
4. **Dispatch / Verify**。同一时刻最多一个副作用命令。驱动须能在投递边界重新验证绑定对象，优先精确窗口与原生 AX 元素的定向操作。需要物理输入时，适配器必须提供投递前检查、窗口命中与有界输入；独立 CLI 调用间的一次前台查询不足以证明后续投递安全。无法建立投递保护返回 `UNSAFE_TARGET`。操作后再验证身份、交付和声明的 `focusAfter`。可能已投递时记 `delivery_uncertain` 并停止，禁止重试或自动切到下一 App。
5. **Stop / Release**。自动执行期间可观测的人工鼠标/键盘介入，或预计之外的 App、窗口、菜单 owner 变化，令当前或下一待执行步骤 `FOCUS_INTERRUPTED`。声明的 `focusAfter`、可验证的导航和紧邻的人工检查点可消费相应焦点变化。取消后释放本次持有的键/鼠标、观察器与租约，并终止本次派生的命令。阻塞后需要用户重新发起运行。已发生的 App 操作无通用回滚。

**条件等待。** 下载、安装与卸载使用可取消、有截止时间的只读观测。录制以可验证的窗口/进程事件生成候选条件，工作台可补充完成指示或可用按钮。单调时钟计算预算，优先订阅状态通知并有限轮询补漏，检查当前状态而非仅消费通知。等待可绑定尚未出现的窗口或探测已退出的进程。安装状态通过受信安装清单与精确 bundle/path 身份确认。安装包落地以下载界面完成且目标文件可唯一定位为准，进程退出单独不足以证明安装或卸载成功。只读等待禁止补点、重开窗口或反复激活。不能从空闲段推断条件时，在工作台标注为待确认。

**人工授权交接。** Secure 输入拒绝持续有效，允许录制在安全边界之后继续。确认触发关系后，连续 secure 区间折叠成一个 `manual_checkpoint`。当预期的授权界面出现在绑定触发步之后，`Verify` 只允许进入紧邻的 `HandOff`，同时撤下输入记录与截图路径。操作者在真实系统或 App 界面完成授权，通过独立于目标 App 的会话控件确认继续。即使系统复用已有授权而没有再次弹出窗口，也需完成继续确认和恢复条件验证。随后核实 secure 状态已清除，并满足 `resume` 的只读条件才重新获取输入权限。默认等待 120 秒，可由用例延长。取消、拒绝、超时或不能证实恢复状态时停在检查点。若在自动步骤中碰到未知 secure 界面，当步阻塞。管理员密码与登录密码一律由操作者在目标界面输入，CueKeeper 无需读 Keychain 或接收密码。报告只记录检查点、触发步、恢复条件类型和结果。

```json
{
  "id": "auth-install",
  "kind": "manual_checkpoint",
  "scope": { "kind": "window", "app": "com.apple.installer", "windowKey": "installer", "windowTitle": "Install Test App" },
  "triggerStepId": "confirm-install",
  "reason": "secure_input",
  "resume": {
    "scope": { "kind": "window", "app": "com.apple.installer", "windowKey": "installer", "windowTitle": "Install Test App" },
    "check": { "kind": "element_enabled", "target": { "kind": "element", "role": "button", "name": "Close" }, "equals": true }
  },
  "timeoutMs": 600000
}
```

**剪贴板。** 同桌面会话串行使用真实剪贴板和变更计数。合规的 `Cmd+C` 必须在已批准的测试作用域执行，核对目标及复制后的变化，建立只在本 run 中有效的 `(stepId, changeCount)`。引用复制的粘贴要求该标记仍对应当前剪贴板。`source: input` 在确认目标后写入本次提供的测试文本，并记录该次写入对应的变更计数。两条路径均聚焦唯一非 secure 控件，在发送 `Cmd+V` 前复查来源与焦点。来源不明、复制未更新、出现外部写入或粘贴结果不可确认时阻塞或按不确定交付停止。启动前告知测试会改变剪贴板。结束时保留用户可见的实际状态，避免自动回写覆盖用户后来复制的数据。计数用于发现变化，所有检查仍受系统事件时序约束。[Apple NSPasteboard changeCount](https://developer.apple.com/documentation/appkit/nspasteboard/changecount)

**IME。** `type` 将已绑定的文本走 Unicode 注入。全局默认回放不查询或切换 TIS，不保存或还原录制时输入法。物理键仍有输入法差异，优先使用可验证的按键语义或 committed text。无法确认 IME 的提交结果时仅产生待填写输入或 `IME_COMMIT_UNVERIFIED` 缺口，禁止把拼音候选串当作最终文字。参见 `docs/ime.md`。

### 语义 intent 准入

用 HAOC-99 的确定性规则按 App、窗口、AX role/label、按键序列和可观察结果识别连续步骤。以用例观察到的窗口、对话框、提示、选项、授权、进度和可验证副作用判定等价。可观察结果与观察顺序都是准入条件。安装或卸载成功等最终结果本身不足以证明等价。

| 类别 | 可观察行为 | 准入 |
| --- | --- | --- |
| `same_ui` | 保留同一目标与用例可观察的窗口、对话框、提示、状态转移和结果。可用稳定动作代替双击、快捷键等手势 | 默认准入，已确认且运行前复验通过的候选可进入默认 `prefer` 计划。工作台可选择原始计划。若用例检查被替代的手势反馈，保留原始步骤 |
| `same_end_state` | 有可验证的同一终态，跳过了菜单、编辑框等可见步骤 | 仅用于准备步骤，或测试员明确接受跳过的非验证步骤。工作台必须逐项展示「将跳过 N 个界面步骤」，由用户对该候选显式确认。覆盖界面断言、授权检查点或流程必需的观察点时拒绝替换 |
| `different_behavior` | 改变被测流程，或绕开授权、许可、安装选项、确认或进度。即使最后文件与进程状态一致，行为仍有差别 | 录制回放拒绝此类别，确认为何种 intent 均不能改变准入。未来如需无界面任务，应由用户单独声明为 headless 动作，使用独立于录制回放的入口 |

类别取自已验证的动作及其适配器路径，由编译器复核。工作台展示参数、类别、可观察副作用和完整原始步骤。未确认、缺少必要证据、包含不相关输入或标为 `different_behavior` 的建议保留原始计划。导入文件若要求执行 `different_behavior`，在任何桌面调用前报告 `INTENT_EQUIVALENCE_REJECTED`。禁止通过改类别绕过校验。

回放以原始 `steps` 为真相源。只有在已证明替代动作尚未送达输入或改变状态、原区间仍能安全执行且与已确认参数一致时，允许按已声明的回退策略重放原始区间。已发生或无法排除副作用时停在当前 intent。

## 4. 系统动作与 HAOC-99

| 动作 | 稳定参数与可验证结果 |
| --- | --- |
| `launch_app` / `activate_app` | bundle ID 与可选 `appPaths`。从系统应用清单解析安装位置，确认进程已启动或指定进程成为前台。Dock 未固定该 App 仍可直接启动或激活 |
| `focus_window` | 窗口 scope，确认原生窗口 owner 和焦点切换结果 |
| `open_system_surface` | 声明 Dock、App 菜单栏、系统状态项或 Spotlight。适配器验证实际可访问且 owner 一致。可见或可按其语义打开时执行，失败即停 |
| `surface_press` | Dock 图标按 bundle ID，App 菜单按唯一菜单路径，系统状态项按经过验证的标识，Spotlight 应用结果按 bundle ID。名称只可作为待确认的唯一匹配。索引与屏幕位置留在临时命中阶段 |

系统导航基础动作属于 `steps`。P3 的 Dock `surface_press` 可提出 `launch_app` intent，前提是通过 `same_ui` 核验。HAOC-99 的 `open_app` 和 `switch_app` 分别映射到 `launch_app` 和 `activate_app`。首批另验证 `open_file` 打开 pkg 与 `rename_file`。`download_file`、`open_url`、`type_text`、`delete_file` 仍是待评估候选，须先定义作用域、输入来源、类别和可观察结果。

本节与 §3 的准入规则是 HAOC-99 共享编译器的前置约束。HAOC-99 现有 `covers` 对应 v2 的 `sourceStepIds`，两种 flow 的执行都保留连续区间与原始计划。实现前须同步 HAOC-99 的语义动作设计、目录和 `rename_file` 纵切，使两种 flow 使用同一准入和报告口径。

### 打开 pkg、安装与卸载

- 用例从双击 pkg 后出现的 Installer 窗口继续时，`open_file` 可用 `open <pkg>` 或 `open -a Installer <pkg>` 替换双击，类别为 `same_ui`。执行前验证同一个 pkg 和实际解析的 Installer 身份，执行后验证前台 Installer 打开了该 pkg，并接上相同的交互步骤。命令退出码不足以通过核验。若用例检查 Finder 双击反馈、文件关联本身或其他入口特有行为，保留该原始步骤。[Apple Launch Services](https://developer.apple.com/documentation/coreservices/launch_services) · [Apple 命令行指南](https://developer.apple.com/library/archive/documentation/OpenSource/Conceptual/ShellScripting/CommandLInePrimer/CommandLine.html)
- 安装路径禁止以 `installer -pkg` 替换 Installer GUI。它属于 `different_behavior`，会绕开用例要观察的许可、安装位置、选项、管理员授权和进度等界面。首轮保留实际出现的安装器步骤、人工授权及条件等待。`install_pkg` 默认不进入 intent 目录。
- 卸载路径禁止以 `rm -rf` 替换 Finder 移到废纸篓或卸载器操作。它属于 `different_behavior`，会跳过确认、授权和应用自身的清理流程。首轮保留 Finder 动作、卸载器 GUI、授权检查点和结果断言。`uninstall_app` 默认不进入 intent 目录。

### `rename_file(path, oldName, newName)` 纵切

1. **识别。** 从下载完成记录与 Finder 实际选中项确认被下载的文件。识别同一 Finder 窗口内「右键文件 → 重命名菜单项 → 同行编辑 → 提交」的连续区间。菜单 role、已支持的本地化 label、编辑框归属和回车提交都要一致。完整保存原区间和 locator，下载是独立的前置步骤。
2. **绑定与确认。** `path` 来自实际下载目录中的受信测试路径。`oldName` 取本次下载项与 Finder 选择共同证明的名称，包括系统分配的 `pkg (1).pkg`。重名靠下载项与文件身份关联，无法关联时保留原始计划。`newName` 来自经确认的重命名输入或运行时参数。将该动作标为 `same_end_state`，列出实际旧、新路径。对上面的四步示例，显示「将跳过 4 个界面步骤」及对应的右键、菜单选择、编辑和提交。用户确认后才采用。若用例验证原重命名界面，保留原始步骤。
3. **执行。** 校验源项仍是该目录中的已验证下载文件，目标名合法且目标未被占用。使用能够绑定该文件且保证不覆盖的直接文件重命名，或经验证满足相同约束的 Finder AX 重命名。拒绝越出指定目录、跟随不可信链接、使用管理员凭据或在源身份不明时继续。
4. **验证与回退。** 验证新路径存在且身份延续、旧路径消失。未执行且原始 steps 仍能唯一作用于同一个下载文件时，允许回退并记录原因。目标冲突、可能已经改名或事后校验失败时停止在该 intent，报告原始区间以及已知状态。自动测试分别用同名副本和占用目标验证有效重命名与零误改。

## 5. 断言、报告与错误码

- 元素/文本断言和 `wait` 从该步窗口的 AX 树读取，secure 或无法安全读取时禁止比较。窗口级 v2 `check.target` 使用 `{ kind: "window" }`，窗口选择完全来自 scope。仅 `exists` 可用 App scope 查询该 App 的普通窗口是否存在。窗口 scope 下 `exists: false` 需要完整、可信清单和不含歧义的身份，已验证消失的绑定窗口可以判为不存在。核对失败或清单不完整时阻塞。标题断言在已绑定窗口上比较实际标题，录制标题只是后续显示标签。
- 截图断言先核对窗口身份与 region，再在内存中裁剪和比较。基线必须是显式提供的测试区域，默认报告只保留比较结论和差异统计。证据需单独开启，只允许可验证为安全的裁剪区域。当前使用临时全帧 PNG 的驱动路径不能用于 v2，缺少内存捕获能力时返回 `ASSERTION_CAPTURE_FAILED`。截图断言只支持普通窗口。
- 按时间顺序写 report。第一个失败的断言为 `failed`，缺少准备条件、隐私拒绝和焦点冲突为 `blocked`，其后步骤标为 `skipped`。入口预检的失败在桌面操作前报告，同时给出涉及的步骤 ID。报告只保留安全的作用域标签、阶段、错误码与比较结果。文本断言的原文、实际内容及未过滤的驱动错误均不随报告输出。
- 采用 intent 时报告实际执行的类别、跳过的界面步骤和副作用核验。走原始计划时记录原始步骤的结果。候选拒绝或回退可附原因，但不能把候选类别计为已采用，也不能把已执行的原始界面步骤记为跳过。

| 码 | 终止点与含义 |
| --- | --- |
| `APP_NOT_FOUND` / `APP_PATH_INVALID` / `APP_AMBIGUOUS` | App 未安装或仅激活时未运行、指定路径无效或 bundle 不符、安装副本或运行实例无法唯一验证。未固定 Dock 单独不产生 App 错误 |
| `LAUNCH_TIMEOUT` / `WINDOW_NOT_FOUND` / `AMBIGUOUS_TARGET` / `WINDOW_CHANGED` | 启动超时、到期仍无目标窗口、同名窗口无法唯一绑定、原窗口身份失效或发生替换 |
| `FOCUS_INTERRUPTED` / `FOCUS_TIMEOUT` / `UNSAFE_TARGET` | 意外切换或操作者介入、预期 owner/窗口未在预算内成为前台、无法保证投递目标 |
| `SURFACE_UNSUPPORTED` / `SYSTEM_ITEM_NOT_FOUND` | surface 无已验证适配器，或已验证的 surface 上找不到指定项。已安装但不在 Dock 的 App 在原始 Dock 路径用后者 |
| `CAPTURE_SCOPE_UNVERIFIED` / `STALE_CAPTURE` / `CROSS_SCOPE_GESTURE` | 捕获归属证据冲突或丢失、快照过期或不可用、手势跨过窗口边界。生成缺口 |
| `SECURE_INPUT` / `PRIVACY_REDACTED` / `INPUT_REQUIRED` | 未计划的 secure 事件或对 secure 控件的自动操作、敏感或未经确认的元数据被遮蔽、缺少运行时测试输入 |
| `MANUAL_CHECKPOINT_REQUIRED` / `MANUAL_CHECKPOINT_CANCELLED` / `MANUAL_CHECKPOINT_TIMEOUT` | 缺少交接能力、操作者取消或拒绝、或到期仍未获得确认且验证恢复条件 |
| `CLIPBOARD_CHANGED` / `CLIPBOARD_SOURCE_UNVERIFIED` | 粘贴所依赖的剪贴板版本已改变，或无法确认有效复制来源 |
| `INTENT_EQUIVALENCE_REJECTED` | 待执行 intent 的类别与适配器、原始区间或可观察效果不符。预检在桌面调用前终止 |
| `SEMANTIC_PRECONDITION_FAILED` / `SEMANTIC_RESULT_UNVERIFIED` | intent 参数或副作用前提不满足，或执行结果无法验证。报告附回退资格与原始区间 |
| `CAPTURE_GAP` / `UNSUPPORTED_FLOW_VERSION` | Flow 有待处理的缺口，或当前入口不支持该版本。均在桌面调用前停止 |
| `ELECTRON_ACCESSIBILITY_REQUIRED` / `ELECTRON_ACCESSIBILITY_UNVERIFIED` | Electron/VS Code 目标的编辑器未开启无障碍：全局录制在进入该 App 前停止并保留 partial（退出码 1），单窗口录制在 helper 启动前拒绝（退出码 2）；只有占位提示才判未开启，Welcome/Settings 等无证据窗口只警告并继续 |
| `WAIT_TIMEOUT` / `ASSERTION_FALSE` / `ASSERTION_CAPTURE_FAILED` | 等待条件超时、可信的观测结果不匹配、截图目标或安全捕获路径不可用 |

## 6. 隐私与运行边界

- `--global` 每次显式开启。首次显示采集范围、数据保存位置、暂停/停止热键、排除应用和敏感输入规则，并在用户确认前保持 tap 停用。持续显示录制状态，暂停立即切断事件管线并清空待合并内容。全局录制默认上限 10 分钟，可显式延长到 60 分钟。下载等无输入时段计入总上限，空闲时不提前关闭会话。会话结束即卸载观察器，文件仅当前用户可访问，默认留在本地。
- 在解析字符、读取 AX value、创建快照或处理剪贴板之前检查系统 secure input、敏感控件、权限面板及排除规则。敏感或身份不明时拒绝录制内容，丢弃有疑问的待处理 burst，写人工检查点或无内容缺口。回放也拒绝对 secure 控件自动输入或截图，且交接过程无内容日志或临时文件。
- 全局录制默认把文本输入建模为定位器和参数名，记录时不导出按键原文、剪贴板 payload 或 AX value。测试员可在工作台填入可分享的测试文字，或在执行时传入本机测试参数。复制场景由回放时的可信测试数据提供真实内容。全局录制的自动文字采集假定不足以判断普通字段里的 Token 或私聊，因此即使控件可编辑也使用同一默认规则。
- 只有明确批准的测试范围可保存原始窗口标题或 AX label，默认优先用结构/稳定标识。隐私数据包含动态标题、通知和菜单项。无法安全产生可重定位信息时记 `PRIVACY_REDACTED`。过滤在调试日志、缓存文件、错误报告、归档与截图写盘之前生效。未经批准的 App 留下缺口，用户可在录制前指定测试范围。
- 支持边界为同一交互 macOS 登录会话里的普通可访问 App。系统授权只承诺在可验证的检查点让操作者接手。锁屏、跨用户/Fast User Switching、远程桌面内层、IME 候选框逐帧、Mission Control/Space 动画、跨 App 拖放、不可访问控件及未知第三方 surface 均超出承诺。

## 7. 实施里程碑与验收

| 阶段 | 可交付行为 | 验收与主要风险 |
| --- | --- | --- |
| P1 · HAOC-107 | 无参数录制倒计时后自动选择窗口，输出 v1 flow | 假清单验证唯一焦点、显式参数和默认输出，缺 App/窗口时给明确错误。切换时 v1 继续遵守原作用域。主要风险是倒计时结束时的焦点竞态 |
| P2 · 全局与 v2 | 录制并重放两个 App、至少三个窗口的顺序输入及断言，支持经验证的键盘切 App 与普通窗口切换。工作台、dry-run、报告可面对同一 v2 flow | 离线测试验证焦点证据、隐私边界和不误投递。批准后用同一会话验证实际切换、文本和剪贴板。主要风险是激活/点击时序、驱动投递边界和含敏感标题的 AX 元数据。任何一项无法验证时，该路径保留缺口或阻塞 |
| P2 · 长等待与授权交接 | 同一 v2 调度器支持只读条件和人工检查点，用安装、登录、卸载回归贯通 | 自动段在操作者完成授权并验证恢复条件后继续。超时、未知授权弹框与错误进程均无后续输入。主要风险是系统授权进程不可见与安装结果误判 |
| P3 · 系统 surface 与 intent | Dock、App 菜单和 Spotlight 通过已验证适配器启动或选定目标，按 OS/驱动版本声明支持。以 `rename_file` 验证 HAOC-99 共享编译与回退 | Dock 换边或重排后仍操作同一 bundle ID。菜单归属和唯一路径可验证。Spotlight 以实际应用结果验证。重命名同名下载时只改目标副本。主要风险是系统组件、菜单本地化与文件身份变化 |

### 离线测试计划

1. **归属顺序。** 输入带时间戳的 A1 → B1 → B2 → A1 事件、晚到通知和同 PID 清单更新。断言 scope、步骤顺序、文本分段和快照 owner。重复 focused 项、遮挡、跨窗口拖拽与队列溢出各落指定缺口。模拟 first-mouse 不可证实，断言没有多出的控件点击。
2. **契约与兼容。** 用 v1 fixture 比较载入、回放目标、报告结果和既有 SHA-256。v2 重排对象键 hash 相同，修改 scope、顺序或 intent 后不同。检查缺 scope、错误 scope、未知 input、跨 App 复用 windowKey、重复 ID 和旧入口行为。包含缺口的 flow 调用过的桌面副作用命令应为零。
3. **窗口与焦点。** 假驱动记录 launch、focus、snapshot、dispatch 调用序列，并检验最终 App/窗口的可见状态。覆盖同名窗口、路径错误、应用缺失、进程重启、标题变更后仍绑定原窗口、同名替换被拒绝。注入启动超时、人工切走和可能已投递的错误，断言停在原步骤、后续未发输入，且不重复投递。
4. **输入与安全。** 验证多作用域使用同一运行时文本参数时仍命中各自控件，Unicode 文本完整，默认 TIS 调用数为零。验证跨 App 复制后只粘贴当前可信数据，模拟外部剪贴板更新后无 `Cmd+V`。检查 secure、Token、私聊标题样本从 flow、报告、快照、标准输出和临时产物中均不可检索。
5. **断言与工作台。** 在两个 App 放入同名控件和同名窗口，验证正负存在断言、文本与窗口 region 始终绑定正确 scope。断言失败后没有下一个 App 的动作。工作台筛选/折叠保留全局序号，过期哈希不能关联报告。截图能力不足时确认没有临时全帧 PNG。
6. **系统语义与准入。** 假 Dock 改变位置与顺序，断言仍选中相同 bundle ID。`same_ui` 打开 pkg 后核对同一包的 Installer 窗口，随后仍经过相同的 GUI 观测和授权。`same_end_state` 重命名前必须展示将跳过的步骤，拒绝后执行原步骤，确认后仅修改目标副本。断言 intent 前后 `steps` 深比较相等，来源区间连续，报告所记类别与实际执行一致。伪标为 `same_ui` 的无界面安装或卸载必须在投递前被拒绝。可能已有副作用时不得再次投递原区间。
7. **安装周期与交接。** 假清单依次出现浏览器下载完成、Installer sheet、secure 边界、安装完成、App 首次出现、卸载器和 App 消失。分别验证等待推进、超时、未知条件和地址正确绑定。向测试夹具混入假密码，断言 raw event、flow、report、日志和截图产物均无该值，确认后只执行原检查点之后的步骤。拒绝或超时后比较每个 App 的投递轨迹，后续为空。

### 实机验收计划

仅在后续实现任务取得本 issue 明确同意和时间窗后执行。验证前列明 Accessibility、Input Monitoring 和可选截图路径的 Screen Recording 权限提示，按待授予类别报告预计弹框数及占用时间。同一轮只编译并签名一次。操作者手动授权，验证结束即停止所有本轮进程。

- P2 用两个测试 App 和三个预置窗口，录制切换、Unicode 输入、一次复制粘贴及负断言。回放后核对各窗口内容与顺序，再人工切走一次，确认未把输入送往新的前台。
- P3 在完成录制后移动 Dock 或重排图标，核对 bundle ID；切换菜单 owner/系统语言时验证匹配或精确阻塞。验证 Spotlight 应用结果和系统授权弹窗拒绝，记录 OS、驱动版本和第一个失败步骤。

### 用户回归用例：下载、安装、登录、验证、卸载

在独立测试会话使用已批准的可卸载测试包。录制或工作台定义每个作用域与等待条件，URL、文件名、安装路径、地址和业务断言均来自该用例数据。再更换 URL 与窗口标题重跑同一套通用动作，验证调度器可以执行不同步骤序列。

| 顺序 | 录制与回放 | 可观察的通过条件 |
| --- | --- | --- |
| 1. 浏览器下载 pkg | 浏览器窗口里的地址栏 `type(input)`、导航、下载和下载完成 `wait` | 下载项完成，预期 pkg 在指定下载目录可唯一定位 |
| 2. 打开 pkg | Finder 或浏览器下载列表双击文件。P3 对照验证 `same_ui` 的 `open_file`，另加测经确认的 `same_end_state` 重命名 | 原始与替换计划打开同一个 pkg 的 Installer UI。重命名仅改所选副本，工作台和报告可展开核对跳过的步骤 |
| 3. 继续并安装 | Installer 主窗口或已验证 sheet 中的点击。遇管理员授权插入人工检查点 | 用户亲自在授权界面完成，敏感区间从捕获和回放输入中隔离。后续安装状态可安全读取 |
| 4. 等待完成 | 等安装完成界面或可点击的完成按钮，再核对预期 App 已安装。若用例关闭 Installer，另等进程退出 | 等待期间只有观察。安装完成与进程退出通过各自条件确认，超时保留已经到达的作用域与步骤 |
| 5. 启动并登录 | 启动已确认的 bundle，等待进程和主页，向指定字段输入测试地址。登录密码沿用人工检查点 | App 窗口和地址字段正确，登录后的主页可见 |
| 6. 验证功能 | 被测 App 窗口内通用输入、等待与断言 | 断言能证明用例中声明的界面或数据变化，首个失败可定位到窗口与步骤 |
| 7. 删除并卸载 | 保留 Finder 对确切测试 App 的移到废纸篓操作和卸载器 GUI。为独立进程或 sheet 按实际归属建 scope。再次请求密码时复用人工检查点 | 确认卸载器 UI 完成、预期 App 移除且活跃进程退出。报告按发生位置列出授权检查点，卸载路径仍覆盖确认和清理流程 |
