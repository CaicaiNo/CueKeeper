# 输入操作支持矩阵

本表覆盖 macOS 首版 v1 flow 的指针、键盘与流程动作，一行一个操作。状态口径：

- **支持**：录制器或工作台能产出、`run` 能执行，并有离线用例断言真实行为。
- **部分**：只在限定条件下可用，条件写在单元格里。
- **不支持**：显式报错，或在「不支持的操作」一节标注明确的警告 / 拒绝方式，不会静默变成别的动作。

离线测试来自 `pnpm test` 与 `sh scripts/test-recording-pointer.sh`（后者只编译纯逻辑测试二进制，不碰 AX、TCC 或真实输入）。**HAOC-95（双击/三击/右键/滚轮）、HAOC-93（拖拽）与 HAOC-94（悬停/剪贴板/中文 IME）只做离线实现与测试，真机一列全部是「未验证」，统一指向 HAOC-76 / HAOC-87。** 真机验证须按项目纪律先获批时间窗，不随离线任务执行。

`--headed` 指回放命令必须显式传入 `run --headed`。物理输入缺失该参数时以 `HEADED_REQUIRED` 失败，不会降级成单击或无头近似。

## 指针与滚轮

| 操作 | 录制 | 回放 | 离线测试 | 真机状态 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| 左键单击（元素定位器） | 支持。松开时入录；同点 120 ms / 3 px 内的重复按下合并，不产生新步骤 | 支持。驱动 `click <ref>`，元素路径无需 `--headed` | `test/pointer-input.test.mjs`、`test/cuekeeper.test.mjs`、`test/recording-pointer-tests.swift` | 未验证 → HAOC-76/87 | `NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET` |
| 左键单击（坐标 `point`） | 支持。落点没有可绑定元素时记 `point`；固定应用路径的流程无法证明副本，跳过并报 `UNTARGETED_POINT` | 支持，必须 `--headed`。驱动 `mouse-click --xy`，先 `focus-window` 再核对窗口与落点 | `test/pointer-input.test.mjs`、`test/app-identity-replay.test.mjs` | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`OUTSIDE_WINDOW`（录制）、`UNTARGETED_POINT`（录制警告） |
| 双击（元素） | 支持。原生按下事件带 `clickState = 2`，把上一步升级为 `count: 2`，不追加重复步骤；单击去重不作用于连击 | 支持，必须 `--headed`。驱动 `double-click <ref>` | `test/pointer-input.test.mjs`（录制升级、回放调用、驱动命令映射）、`test/recording-pointer-tests.swift`（double click） | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`、`UNSUPPORTED_CLICK_COUNT` |
| 双击（坐标） | 支持。连击落点没有可绑定元素时保留 `target.point` 与 `count: 2` | 支持，必须 `--headed`。驱动 `mouse-click --xy --count 2` | `test/pointer-input.test.mjs`（schema 接受、适配器参数） | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`UNSUPPORTED_CLICK_COUNT` |
| 三击（元素） | 支持。`clickState = 3` 把上一步升级为 `count: 3`；第 4 击起按三击记录并报 `MULTI_CLICK_TRUNCATED` | 支持，必须 `--headed`。驱动 `triple-click <ref>` | `test/pointer-input.test.mjs`、`test/recording-pointer-tests.swift`（triple click / clamp） | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`、`MULTI_CLICK_TRUNCATED`（录制警告） |
| 三击（坐标） | 支持。保留 `target.point` 与 `count: 3` | 支持，必须 `--headed`。驱动 `mouse-click --xy --count 3` | `test/pointer-input.test.mjs` | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`MULTI_CLICK_TRUNCATED`（录制警告） |
| 右键（元素） | 支持。右键按下记 `button: "right"`，只允许单击；右键拖拽记为 `button: "right"` 的 `drag`（规划期拒绝回放） | 支持。驱动 `right-click <ref>`；元素路径无需 `--headed` | `test/pointer-input.test.mjs`、`test/cuekeeper.test.mjs`、`test/recording-pointer-tests.swift` | 未验证 → HAOC-76/87（含右键菜单实际弹出） | `UNSUPPORTED_CLICK_COUNT`（`button: "right"` 带 `count > 1` 在规划期拒绝）、`NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET` |
| 右键（坐标） | 支持。落点无元素时记 `target.point` + `button: "right"` | 支持，必须 `--headed`。驱动 `mouse-click --xy --button right` | `test/pointer-input.test.mjs`（schema 接受、适配器参数） | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`UNSUPPORTED_CLICK_COUNT` |
| 滚轮 / 触控板滚动（元素） | 支持。`scrollWheel` 取行增量 `deltaX`/`deltaY`（各轴 ±1000），缺行增量时回退到 point / fixed-point 增量；同一目标 350 ms 内合并为一步，`durationMs` 记整段时长 | 支持。驱动 `scroll <ref> --direction --amount`；delta 换算方向与行数，右/左滚动同理 | `test/pointer-input.test.mjs`、`test/cuekeeper.test.mjs`（录制合并与 CLI）、`test/viewer.test.mjs`、`test/workbench.test.mjs` | 未验证 → HAOC-76/87（方向、惯性、顺滑度） | `NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`；录制侧 `UNTARGETED_POINT`、`EVENT_LIMIT` |
| 滚轮（坐标） | 支持。落点无元素时记 `target.point` 加原始 delta | 支持，必须 `--headed`。驱动 `mouse-wheel --x --y --dx= --dy=`（负值用 `=` 形式，避免被当成 flag） | `test/pointer-input.test.mjs`（适配器参数）、`test/viewer.test.mjs` | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`UNSUPPORTED_SCROLL`（适配器兜底；双轴为 0 已在规划期拒绝）、`OUTSIDE_WINDOW`（录制） |
| 左键拖拽（元素端点） | 支持。按下移动超过 3 个逻辑点即记 `kind: "drag"`；起点或终点距命中元素中心 ≤ 4 pt 时记元素定位器；`path` 按 8 px / 16 ms 抽稀（≤ 64 点），`durationMs` 记按下到松开的时长 | 支持，必须 `--headed`。驱动 `drag --from <ref> --to <ref> --duration`；回放前重新聚焦并核对窗口，起止元素在快照中重新解析 | `test/drag-input.test.mjs`、`test/cuekeeper.test.mjs`（录制 CLI）、`test/recording-pointer-tests.swift`（采样/端点/时长）、`test/app-identity-replay.test.mjs` | 未验证 → HAOC-76/87（Finder 文件拖放、spring-loaded 文件夹、自动滚动） | `HEADED_REQUIRED`、`NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`、`WINDOW_CHANGED`、`UNSAFE_POINT`（按副本路径的流程带坐标端点） |
| 左键拖拽（坐标端点） | 支持。落点不在元素中心时记 `from`/`to` 的 `target.point`；文本选择与窗口移动必须走这一形态 | 支持，必须 `--headed`。驱动 `drag --from-xy=x,y --to-xy=x,y --duration`；回放前重新聚焦窗口并核对起点在窗口内；终点允许在窗口外（窗口移动） | `test/drag-input.test.mjs`（录制绑定、schema、回放调用、适配器参数、干跑） | 未验证 → HAOC-76/87（文本选择范围、窗口移动落点） | `HEADED_REQUIRED`、`UNSAFE_POINT`（起点在窗口外或按副本路径的流程）、`WINDOW_CHANGED`、`NOT_FOUND`（元素端点） |
| 悬停（元素） | 支持。`mouseMoved` 在同一点 3 pt 内停留 ≥300 ms 时记 `kind: "hover"`，`durationMs` 记实际停留；事件只在目标窗口、目标应用前台且不在录制 HUD 上时采集 | 支持，必须 `--headed`。元素取快照 bounds 中心，驱动 `mouse-move --xy`，再等待 `durationMs` | `test/input-ii.test.mjs`（录制、schema、回放调用、适配器参数）、`test/recording-pointer-tests.swift`（停留/过路/移动重置） | 未验证 → HAOC-76/87（tooltip 延时、菜单展开、停留时长） | `HEADED_REQUIRED`、`NOT_FOUND`、`UNSAFE_TARGET`（安全控件）、`HOVER_UNRESOLVED`（元素无 bounds）、`UNSAFE_POINT` |
| 悬停（坐标） | 支持。落点没有可绑定元素时记 `target.point`；固定应用路径的录制跳过并报 `UNTARGETED_HOVER` | 支持，必须 `--headed`。驱动 `mouse-move --xy`，再等待 `durationMs`；固定应用路径的流程拒绝坐标（`UNSAFE_POINT`） | `test/input-ii.test.mjs` | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`（回放前窗口核对）、`UNTARGETED_HOVER`（录制警告） |

### 滚轮的已知限制

- 只记录实际 delta，不承诺复刻惯性 / 动量；合并窗口会改变单步力度，长时间连续滚动可能先命中 `EVENT_LIMIT`（1000 条原生事件）。
- 非目标窗口、目标应用非前台、或落在录制指示器上的滚轮事件被丢弃（原生侧发 `boundary`，不产生步骤，也不产生警告）。这是有意的目标域限制，但**属于静默丢弃**；如果误滚，请在录制结果里核对步骤数。
- 滚轮 delta 的符号约定与驱动 `mouse-wheel --dy` 同号（正 `deltaY` = 向上 / 内容向下移动），仅离线对齐，真机方向与惯性列入 HAOC-87。

### 拖拽的已知限制

- **回放是直线**：`path` 只作录制证据，回放按驱动 `drag` 的起点→终点直线拖拽并保留 `durationMs`；不保证复刻曲率、速度曲线、drop-delay 的停留位置。`--drop-delay` 使用驱动默认 500 ms。
- **元素端点从中心起手**：录制时只有落点距元素中心 ≤ 4 pt 才记元素定位器。文本选择、标题栏移动、列表内精确位置必须用坐标端点，否则回放会从元素中心起手、选到别的内容。
- **拖动中窗口/焦点变化**：起点在目标窗口内才入录。回放前会重新聚焦并核对窗口；拖拽开始后若窗口切换，驱动会报错，不会继续拖到错误位置。
- **右侧/修饰键拖拽**：驱动只有左键、无修饰键参数；右键拖拽会记录但规划期拒绝，修饰键拖拽在录制时显式跳过。
- **跨应用 / spring-loaded / 自动滚动**：不承诺，真机验证归 HAOC-76/87。

### 悬停的已知限制

- **停留阈值固定 300 ms、半径 3 pt**：更短的掠过不产生步骤；到达后不再移动也会由会话定时器补发一次，不会每个 mouseMoved 都记。
- **元素回放取中心**：元素目标在回放时移动到 bounds 中心，不是录制时的精确落点。只在元素边缘才出现的 tooltip 可能不触发；需要精确点位时用坐标悬停。
- **只移动、不等待 UI 断言**：`durationMs` 是停留等待，不保证 tooltip / 菜单在其它机器上同样出现；回放失败只覆盖移动本身（`HEADED_REQUIRED`、`UNSAFE_POINT`、`HOVER_UNRESOLVED`），瞬时消失需用后续 `assert` 判断。
- **真机 tooltip 延时、菜单展开与停留时长**归 HAOC-87。

### 剪贴板与 IME 的已知限制

- **默认关闭**：不加 `record --clipboard` 时 Cmd+V 仍是 `key`，回放读取当时系统剪贴板，不复刻录制内容。
- **开启后内容只进 flow**：`flow.json` 会保存固化的粘贴文本（用户显式选择），但内容不写 stderr / 日志 / 报告条目 / viewer；`report pack` 会拒绝含 `paste` 的流程，避免把文本再打进报告 ZIP。需要分享报告时请改用不含粘贴文本的流程。
- **只支持纯文本**：图片、文件 URL、富文本与超过 4000 字符的文本不固化，保留 Cmd+V 并给警告；回放会读取当时剪贴板。
- **IME 只保留提交结果**：组合过程与候选框不逐帧记录；中文文本走 `type` 的 Unicode 插入，不模拟逐键输入。原生事件若在组合中间态带出 ASCII 片段，本轮不做语义过滤，最终文本顺序需真机核对（HAOC-87）。自绘 / 终端类控件需要物理按键时不在支持范围。
- **真实剪贴板所有权与 Cmd+C 复制结果**归 HAOC-76/87。

## 键盘与文本

| 操作 | 录制 | 回放 | 离线测试 | 真机状态 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| ASCII 文本输入 | 支持。按焦点可编辑控件与 1.5 s 时间间隔合并为 `type` | 支持。驱动 `type <ref> --stdin`，文本不进 argv | `test/cuekeeper.test.mjs`（录制 click/type/key） | 未验证 → HAOC-76/87 | `UNSAFE_TEXT_TARGET`（录制：无焦点或保护控件）、`SECURE_INPUT`（录制）、`UNSAFE_TARGET`（回放：安全控件或无 ref） |
| 快捷键 / 特殊键 | 支持。ANSI 可打印键与方向键、F1–F12、修饰键组合；按住重复只记一次并报 `KEY_REPEAT` | 支持。驱动 `press <combo> --window-id` | `test/cuekeeper.test.mjs`、`test/recording-hotkeys` | 未验证 → HAOC-76/87 | `UNSUPPORTED_KEY`（录制警告）、`UNSUPPORTED_EVENT`（录制警告）、`KEY_REPEAT`（录制警告） |
| 复制 Cmd+C | 支持。录为 `key: meta+c`；即使开启 `--clipboard` 也不在按键瞬间读取复制结果，内容由后续 Cmd+V 固化 | 支持。驱动 `press meta+c` | `test/cuekeeper.test.mjs`（快捷键路径）、`test/input-ii.test.mjs`（Cmd+V 固化） | 未验证 → HAOC-76/87（真实复制选区） | `UNSUPPORTED_KEY`（录制警告，非 ANSI 键）、`UNSAFE_TEXT_TARGET`（仅文本输入路径） |
| 粘贴（文本剪贴板） | 默认关闭，只记 `key: meta+v`。`record --clipboard` 显式开启后，在 Cmd+V 时读取 pasteboard：只有 ≤4000 字符的纯文本会固化为 `kind: "paste"`，目标取当时唯一聚焦的可编辑、非安全控件；图片 / 文件 URL / 超长 / 含 NUL / 读失败 / 无安全目标都保留快捷键并给警告 | 支持。先 `focus <ref>`，再 `clipboard-set --stdin` 写入记录文本，最后 `press meta+v --window-id`；不把文本放进 argv | `test/input-ii.test.mjs`（录制固化、默认关闭、各类回退、回放调用、适配器参数、内容不进报告 / viewer） | 未验证 → HAOC-76/87（真实 Cmd+V、富文本、图片/文件粘贴、剪贴板所有权） | `CLIPBOARD_UNSUPPORTED_TYPE`、`CLIPBOARD_TOO_LARGE`、`CLIPBOARD_INVALID_TEXT`、`CLIPBOARD_READ_FAILED`、`UNSAFE_CLIPBOARD_TARGET`（录制警告）、`UNSAFE_TARGET`（回放：非可编辑或安全控件） |
| 中文 / 非 ASCII（IME 提交文本） | 部分。只记录提交后的 Unicode 文本，记为 `type` 并带 `ime: true`，同时报 `IME_COMPOSITION_UNSUPPORTED`；组合中间态、候选框与逐键物理输入不记录 | 支持文本插入：驱动 `type <ref> --stdin` 写入 Unicode；不重放拼音/候选框，需要物理按键的自绘输入框不支持 | `test/input-ii.test.mjs`（录制合并、IME 标记、回放 Unicode） | 未验证 → HAOC-76/87（中文输入法、候选选择、终端 / 自绘控件） | `IME_COMPOSITION_UNSUPPORTED`（录制警告）、`UNSUPPORTED_TEXT`（仍有不可打印字符时）、`UNSAFE_TEXT_TARGET`、`SECURE_INPUT` |

## 流程动作

| 操作 | 录制 | 回放 | 离线测试 | 真机状态 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| `wait` 等待条件 | 工作台添加（录制器不产生） | 支持。单次检查，超时失败 | `test/assertions.test.mjs`、`test/preconditions.test.mjs` | 未验证 → HAOC-76/87 | `WAIT_TIMEOUT`、`NOT_FOUND`、`PRECONDITION_FALSE` |
| `assert` 断言 | 工作台添加 | 支持。元素 / 窗口属性、窗口截图比对 | `test/assertions.test.mjs`、`test/viewer.test.mjs` | 未验证 → HAOC-76/87 | `NOT_FOUND`、`PROPERTY_UNAVAILABLE`、`ASSERTION_CAPTURE_FAILED`、`ASSERTION_MATCH_TIMEOUT`、`PRECONDITION_FALSE` |
| `shell` 步骤 | 手写 flow | 支持（用户态 argv / `sh -c`）；提权形态在 HAOC-76 前保持禁用 | `test/shell.test.mjs` | 未验证 → HAOC-76/87 | `SHELL_NOT_ALLOWED`、`SHELL_EXIT`、`SHELL_TIMEOUT`、`SHELL_CANCELLED`、`SHELL_START_FAILED`、`SHELL_PRIVILEGE_REQUIRED`、`SHELL_PRIVILEGE_CANCELLED`、`SHELL_PRIVILEGE_UNAVAILABLE`、`SHELL_OUTPUT_TRUNCATED` |

Shell 的完整约束见 [Shell 步骤设计](shell-steps.md) 与 [Root 步骤与管理员授权](shell-security.md)。

## 不支持的操作

下列操作没有 v1 表示法。录制侧尽量给出显式警告，回放侧在 schema / 规划阶段拒绝，不会静默转成其它动作。

| 操作 | 录制行为 | 回放行为 | 归属 |
| --- | --- | --- | --- |
| 按住修饰键的拖拽（如 Option 拖拽复制） | 跳过，报 `DRAG_MODIFIERS_SKIPPED` 警告；驱动没有修饰键拖拽参数，不能降级成普通拖拽 | schema 无修饰键字段 | HAOC-93 边界 |
| 右键拖拽 | 记为 `button: "right"` 的 `drag`，flow 里可见 | 规划期拒绝（`right-button drags are not supported`），驱动只支持左键拖拽 | HAOC-93 边界 |
| 拖拽路径曲率 / spring-loaded 文件夹 / 自动滚动 | 记录抽稀后的 `path` 作为证据 | 按起止点直线拖拽并保留总时长，不复刻路径与自动滚动 | HAOC-87 |
| 跨应用拖拽 | 起点在目标窗口内才入录；终点可在窗口外 | 不承诺跨应用投放；`native cross-app drag` 可能无法由合成事件启动 | HAOC-76/87 |
| 中键 / 其它鼠标键 | 跳过，报 `UNSUPPORTED_CLICK` / `UNSUPPORTED_EVENT` 警告 | `button` 只接受 `left` / `right`，其它值 schema 拒绝 | 后续单 |
| 四击及以上 | 按三击记录，报 `MULTI_CLICK_TRUNCATED` 警告 | `count` 上限为 3，更大的值 schema 拒绝 | 本单边界 |
| 非文本剪贴板（图片 / 文件 URL / 富文本） | 开启 `--clipboard` 也只读取纯文本；其它类型保留 Cmd+V 快捷键并报 `CLIPBOARD_UNSUPPORTED_TYPE` | `paste` 只承载文本；回放读当时系统剪贴板 | HAOC-94 边界 / 后续单 |
| IME 候选框、marked text 逐帧过程与逐键物理输入 | 只记提交后的 Unicode 文本，标 `ime: true` 并报 `IME_COMPOSITION_UNSUPPORTED` | `type` 只做文本插入，不重放组合过程 | HAOC-87 |
| 滚轮惯性 / 动量复刻 | 只合并并记录实际 delta | 按记录值重放，不复刻惯性 | HAOC-87 |
| 多显示器 / 缩放 / 负坐标落点 | 记录当前屏幕逻辑点 | 只保证同一显示布局；布局变化可能失败 | HAOC-76/87 |
| 游戏 / 远程桌面场景 | — | 不承诺 | 不在范围 |

## 拒绝码说明

| 错误码 | 何时出现 | 是否静默降级 |
| --- | --- | --- |
| `HEADED_REQUIRED` | 双击、三击或坐标类输入（单击 / 右键 / 滚轮）没有 `--headed` | 否，直接失败 |
| `NOT_FOUND` | 目标元素在绑定的窗口里不存在 | 否，不会落到别的控件 |
| `UNSAFE_POINT` | 坐标落在目标窗口之外，或固定应用路径的流程使用坐标输入 | 否，不会点/滚到前台窗口 |
| `UNSAFE_TARGET` | 目标控件是安全控件或没有可执行 ref | 否 |
| `UNSUPPORTED_CLICK_COUNT` | 右键带 `count > 1`，或内部传入 2/3 以外的连击数 | 否；规划期或适配器直接拒绝 |
| `UNSUPPORTED_SCROLL` | 适配器收到双轴为 0 的滚动（规划期已先拒绝） | 否 |
| `MULTI_CLICK_TRUNCATED` | 录制到第 4 次及以上的连击，按三击记录 | 是（录制警告），流程里能看到 |
| `EVENT_LIMIT` | 单次录制超过 1000 条原生事件，后续输入不再入录 | 是（录制警告） |
| `DRAG_MODIFIERS_SKIPPED` | 录制到按住修饰键的拖拽，跳过该手势 | 是（录制警告） |
| `DRAG_OUTSIDE_WINDOW` | 拖拽起点不在目标窗口内，跳过该手势 | 是（录制警告） |
| `DRAG_UNVERIFIED` | 拾取瞬间读取可访问性树失败，无法可靠绑定起止点，跳过该手势 | 是（录制警告） |
| `UNTARGETED_DRAG` | 固定应用路径的录制里，拖拽端点无法绑定到元素 | 是（录制警告） |
| `UNSUPPORTED_DRAG_BUTTON` | 适配器直接收到右键拖拽（正常流程在规划期已先拒绝） | 否，直接失败 |
| `UNTARGETED_POINT` | 固定应用路径的录制里，坐标点击 / 滚动 / 悬停无法绑定到元素 | 是（录制警告） |
| `UNTARGETED_HOVER` | 固定应用路径的录制里，悬停落点无法绑定到元素 | 是（录制警告） |
| `HOVER_UNRESOLVED` | 悬停的元素目标没有 bounds，无法算出回放坐标 | 否，直接失败 |
| `CLIPBOARD_UNSUPPORTED_TYPE` | 开启剪贴板录制，但 clipboard 不是纯文本 | 是（录制警告，保留快捷键） |
| `CLIPBOARD_TOO_LARGE` | 剪贴板文本超过 4000 字符 | 是（录制警告，保留快捷键） |
| `CLIPBOARD_INVALID_TEXT` | 剪贴板文本含 NUL | 是（录制警告，保留快捷键） |
| `CLIPBOARD_READ_FAILED` | 录制 Cmd+V 时读取剪贴板失败 | 是（录制警告，保留快捷键） |
| `UNSAFE_CLIPBOARD_TARGET` | Cmd+V 时没有唯一聚焦的可编辑非安全控件 | 是（录制警告，保留快捷键） |
| `IME_COMPOSITION_UNSUPPORTED` | 录到 IME 提交的 Unicode 文本；组合过程不重放 | 是（录制警告），文本本身会入 flow |
| `OUTSIDE_WINDOW` | 点击或滚动落在录制开始时的目标窗口之外 | 否，录制失败 |
| `WINDOW_CHANGED` / `WINDOW_MISMATCH` / `WINDOW_NOT_FOUND` | 回放时窗口 ID、标题或前台状态与绑定的窗口不一致 | 否，不会点错窗口 |

未在表里的通用错误码（`AMBIGUOUS_TARGET`、`PROPERTY_UNAVAILABLE`、`CAPTURE_PROTOCOL` 等）沿用 [README](../README.md) 与各设计文档的定义。
