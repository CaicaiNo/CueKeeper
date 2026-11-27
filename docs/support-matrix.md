# 输入操作支持矩阵

本表覆盖 macOS 首版 v1 flow 的指针、键盘与流程动作，一行一个操作。状态口径：

- **支持**：录制器或工作台能产出、`run` 能执行，并有离线用例断言真实行为。
- **部分**：只在限定条件下可用，条件写在单元格里。
- **不支持**：显式报错，或在「不支持的操作」一节标注明确的警告 / 拒绝方式，不会静默变成别的动作。

离线测试来自 `npm test` 与 `sh scripts/test-recording-pointer.sh`（后者只编译纯逻辑测试二进制，不碰 AX、TCC 或真实输入）。**HAOC-95（双击/三击/右键/滚轮）、HAOC-93（拖拽）与 HAOC-94（悬停/剪贴板/中文 IME）只做离线实现与测试，真机一列全部是「未验证」，统一指向 HAOC-76 / HAOC-87。** 真机验证须按项目纪律先获批时间窗，不随离线任务执行。HAOC-97 修正 `type` 的 headed 注入方式（Chrome web 内容在无头路径下 `ACTION_FAILED`），真机复测同样归 HAOC-87。

`--headed` 指回放命令必须显式传入 `run --headed`。物理输入缺失该参数时以 `HEADED_REQUIRED` 失败，不会降级成单击或无头近似。

## 指针与滚轮

| 操作 | 录制 | 回放 | 离线测试 | 真机状态 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| 左键单击（元素定位器） | 支持。松开时入录；同点 120 ms / 3 px 内的重复按下合并，不产生新步骤；命中的控件没有 AX action 时给 `CLICK_TARGET_UNPRESSABLE` 警告 | 支持。驱动 `click <ref>`，元素路径无需 `--headed`；控件及其所有容器都没有 action ref 时，按最近可操作祖先 → 该控件中心物理点击（需 `--headed`）→ 都没有则报 `UNSAFE_TARGET`。语义按压返回 `ACTION_FAILED` 时：300 ms 后重读快照、目标仍唯一解析才重试一次 → 仍失败则按同一控件中心物理点击并注明 `CLICK_POINT_FALLBACK` → 无 bounds 或物理点击也失败则报 `ACTION_FAILED`（带控件与控制/物理尝试次数）。不做第二次重试；安全控件不进入该路径。窗口切换后的第一次点击先做就绪证明（连读两次，目标 enabled 且 role/name/bounds 一致），超时报 `TARGET_NOT_READY` 且零输入 | `test/pointer-input.test.mjs`、`test/cuekeeper.test.mjs`、`test/run-v2.test.mjs`（祖先 / 中心坐标 / 两者皆无 / ACTION_FAILED 重试与回退 / 切换后就绪屏障）、`test/record-v2.test.mjs` | 未验证 → HAOC-76/87 | `NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`、`UNSAFE_POINT`、`HEADED_REQUIRED`、`ACTION_FAILED`、`TARGET_NOT_READY` |
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
| 悬停（元素） | 支持。`mouseMoved` 在同一点 3 pt 内停留 ≥300 ms 时记 `kind: "hover"`，`durationMs` 记实际停留；指针下的控件有名字或 `identifier` 时记元素型（`scope` 为窗口、`target` 加实际停留点），事件只在目标窗口、目标应用前台且不在录制 HUD 上时采集 | 支持，必须 `--headed`。解析窗口、前台与元素后，沿目标内的短路径驱动 `mouse-move --xy`（至少 3 次，间隔 40 ms），最后落在录制点或元素中心，再等待 `max(durationMs, 400)` | `test/hover-replay.test.mjs`、`test/input-ii.test.mjs`、`test/recording-pointer-tests.swift` | 未验证 → HAOC-76/87（tooltip 延时、菜单展开、停留时长） | `HEADED_REQUIRED`、`NOT_FOUND`、`WINDOW_NOT_FOUND`、`WINDOW_CHANGED`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`（安全控件）、`HOVER_UNRESOLVED`（元素无 bounds）、`UNSAFE_POINT`、`HOVER_NOT_FOREGROUND`；前四类在有 `point` 时降级为坐标型并在报告标 `HOVER_SCREEN_FALLBACK` |
| 悬停（坐标） | 支持。落点只命中窗口根、匿名容器或空名文本时记 `kind: "hover"` + `scope:{kind:'screen'}` + 必填 `point`；`hint` 只记录 `app` / `windowTitle` / `element`（role、name、identifier），不参与解析；没有窗口归属的悬停仍跳过并报 `UNTARGETED_HOVER` | 支持，必须 `--headed`。只调 `list-displays`，要求落点与驱动预移动点 `(x-1,y)` 在同一块显示器内（副屏负坐标合法），按该显示器构造路径驱动 `mouse-move --xy`，再等待 `max(durationMs, 400)`；不建窗口绑定、不读快照、不聚焦、不点击 | `test/hover-replay.test.mjs`、`test/record-v2.test.mjs`、`test/workbench-target-dialog.test.mjs` | 未验证 → HAOC-76/87（副屏、窗口改名/换目录、tooltip 肉眼确认） | `HEADED_REQUIRED`、`UNSAFE_POINT`（落点或 `list-displays` 不可证明，零移动）、`UNTARGETED_HOVER`（录制跳过）、`HOVER_SCREEN_FALLBACK`（元素型降级，报告里的说明而非失败） |

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
- **元素型回放用录制的实际停留点**：元素型悬停优先落在录制时指针停下的点，只有旧 flow 或录制点不在目标内时才退回 bounds 中心。坐标型悬停按录制的屏幕坐标回放，与录制时的屏幕布局绑定，版面/分辨率变化后可能落到别处，需要重新录制。
- **两种悬停都不看 UI 结果**：`durationMs` 是停留等待，不保证 tooltip / 菜单在其它机器上同样出现；回放失败只覆盖移动本身（`HEADED_REQUIRED`、`UNSAFE_POINT`、`HOVER_UNRESOLVED`、`HOVER_NOT_FOREGROUND`），瞬时消失需用后续 `assert` 判断。坐标型回放一律视为不可自动验证，报告 `delivery: "delivered_unverified"`（不采用驱动自报的 `delivered_verified`），`deliveredVia: "screen_point"` 标明路径。
- **元素型降级只在四种解析失败时发生**：`WINDOW_NOT_FOUND` / `WINDOW_CHANGED` / `AMBIGUOUS_TARGET` / `NOT_FOUND` 且本步有 `point` 时改为坐标回放，报告带 `HOVER_SCREEN_FALLBACK` 和原始错误码；secure、坐标在已证明窗口外、后台窗口、驱动故障/超时/`HEADED_REQUIRED` 都不降级。
- **真机 tooltip 延时、菜单展开、副屏与窗口改名后的坐标回放**归 HAOC-87。

### 剪贴板与 IME 的已知限制

- **默认关闭**：不加 `record --clipboard` 时 Cmd+V 仍是 `key`，回放读取当时系统剪贴板，不复刻录制内容。
- **开启后内容只进 flow**：`flow.json` 会保存固化的粘贴文本（用户显式选择），但内容不写 stderr / 日志 / 报告条目 / viewer；`report pack` 会拒绝含 `paste` 的流程，避免把文本再打进报告 ZIP。需要分享报告时请改用不含粘贴文本的流程。
- **只支持纯文本**：图片、文件 URL、富文本与超过 4000 字符的文本不固化，保留 Cmd+V 并给警告；回放会读取当时剪贴板。
- **IME 只保留提交结果**：组合过程与候选框不逐帧记录；中文文本走 `type` 的 Unicode 插入，不模拟逐键输入。原生事件若在组合中间态带出 ASCII 片段，本轮不做语义过滤，最终文本顺序需真机核对（HAOC-87）。自绘 / 终端类控件需要物理按键时不在支持范围。
- **回放默认不管输入法**：不加 `--input-source-switch` 时回放不读 TIS、不切换、不恢复，报告里没有 `ime` 字段也没有 IME 警告；`type` 仍走 Unicode 注入，但字符 `key` 不承诺在中文输入法下不被改写。需要自动切换与恢复时显式开启，见[输入法守卫](ime.md)。
- **真实剪贴板所有权与 Cmd+C 复制结果**归 HAOC-76/87。

## 键盘与文本

| 操作 | 录制 | 回放 | 离线测试 | 真机状态 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| ASCII 文本输入 | 支持。按焦点可编辑控件与 2 s 时间间隔合并为 `type`；焦点标记迟滞时（Safari 常见）先延迟约 80 ms 重读一次快照，仍无焦点则回退到最近一次左键点击的可编辑控件，并要求该控件自身的 value/text 已包含本次输入的字符 | 支持。驱动 `type <ref> --stdin`，文本不进 argv；headed 回放带 `--headed`，无头回放不带。默认不碰输入法（不读 TIS、不切换、不恢复），需要自动切换时加 `--input-source-switch` | `test/cuekeeper.test.mjs`（录制 click/type/key）、`test/safari-text.test.mjs`（延迟重读、点击回退、值证据、保护/非可编辑拒绝）、`test/type-headed.test.mjs`（headed/无头参数、错误码保留）、`test/ime.test.mjs`（默认零 TIS 调用、开启后的切换/恢复） | 未验证 → HAOC-76/87 | `UNSAFE_TEXT_TARGET`（录制：无焦点且无可用点击回退、或控件值未显示输入）、`SECURE_INPUT`（录制）、`UNSAFE_TARGET`（回放：安全控件或无 ref）、`TARGET_NOT_READY`（窗口切换后首次输入，目标 1.5 s 内不可证明）；开启守卫后另见 `IME_*` |
| Chrome / Chromium 页面文本输入 | 支持。与 ASCII 文本输入同一路径，目标为 web 可编辑控件 | 支持，走 headed 注入：`run --headed` 下驱动 `type <ref> --headed --stdin`，文本仍只走 stdin。无头路径对 web 内容会失败，不静默降级 | `test/type-headed.test.mjs`（headed 参数、stdin 文本、`ACTION_FAILED` 原样保留且不重试） | 修复前真机已复现 `ACTION_FAILED`；修复后的真机回放待 HAOC-87（需先获批时间窗） | `ACTION_FAILED`（web 内容走无头注入时）、`UNSAFE_TARGET` |
| 快捷键 / 特殊键 | 支持。ANSI 可打印键与方向键、F1–F12、修饰键组合；按住重复只记一次并报 `KEY_REPEAT` | 支持。驱动 `press <combo> --window-id`；窗口切换后首次按键先证明窗口 `bounds` 稳定 | `test/cuekeeper.test.mjs`、`test/recording-hotkeys` | 未验证 → HAOC-76/87 | `UNSUPPORTED_KEY`（录制警告）、`UNSUPPORTED_EVENT`（录制警告）、`KEY_REPEAT`（录制警告）、`TARGET_NOT_READY`（切换后窗口 1.5 s 内不稳定） |
| 复制 Cmd+C | 支持。录为 `key: meta+c`；即使开启 `--clipboard` 也不在按键瞬间读取复制结果，内容由后续 Cmd+V 固化 | 支持。驱动 `press meta+c` | `test/cuekeeper.test.mjs`（快捷键路径）、`test/input-ii.test.mjs`（Cmd+V 固化） | 未验证 → HAOC-76/87（真实复制选区） | `UNSUPPORTED_KEY`（录制警告，非 ANSI 键）、`UNSAFE_TEXT_TARGET`（仅文本输入路径） |
| 粘贴（文本剪贴板） | 默认关闭，只记 `key: meta+v`。`record --clipboard` 显式开启后，在 Cmd+V 时读取 pasteboard：只有 ≤4000 字符的纯文本会固化为 `kind: "paste"`，目标取当时唯一聚焦的可编辑、非安全控件；图片 / 文件 URL / 超长 / 含 NUL / 读失败 / 无安全目标都保留快捷键并给警告 | 支持。先 `focus <ref>`，再 `clipboard-set --stdin` 写入记录文本，最后 `press meta+v --window-id`；不把文本放进 argv | `test/input-ii.test.mjs`（录制固化、默认关闭、各类回退、回放调用、适配器参数、内容不进报告 / viewer） | 未验证 → HAOC-76/87（真实 Cmd+V、富文本、图片/文件粘贴、剪贴板所有权） | `CLIPBOARD_UNSUPPORTED_TYPE`、`CLIPBOARD_TOO_LARGE`、`CLIPBOARD_INVALID_TEXT`、`CLIPBOARD_READ_FAILED`、`UNSAFE_CLIPBOARD_TARGET`（录制警告）、`UNSAFE_TARGET`（回放：非可编辑或安全控件） |
| 中文 / 非 ASCII（IME 提交文本） | 部分。只记录提交后的 Unicode 文本，记为 `type` 并带 `ime: true`，同时报 `IME_COMPOSITION_UNSUPPORTED`；组合中间态、候选框与逐键物理输入不记录 | 支持文本插入：驱动 `type <ref> --stdin` 写入 Unicode；不重放拼音/候选框，需要物理按键的自绘输入框不支持 | `test/input-ii.test.mjs`（录制合并、IME 标记、回放 Unicode） | 未验证 → HAOC-76/87（中文输入法、候选选择、终端 / 自绘控件） | `IME_COMPOSITION_UNSUPPORTED`（录制警告）、`UNSUPPORTED_TEXT`（仍有不可打印字符时）、`UNSAFE_TEXT_TARGET`、`SECURE_INPUT` |

### 浏览器文本输入的已知限制

- **headed 注入是 web 内容的唯一可靠路径**：Chromium 的可访问性文本表面在无头路径读取失败时返回 `ACTION_FAILED`。headed 回放把文本经 stdin 交给驱动，不进入命令行。
- **不自动降级**：headed 失败时保留驱动原始错误码（如 `ACTION_FAILED`），不会改走无头路径重试；无头运行 `type` 打到 web 内容仍会失败。
- **原生控件**：TextEdit 等原生控件在无头回放中仍走原路径（不带 `--headed`）；headed 回放对原生控件的表现随同一路径变化，真机回归归 HAOC-87。
- **Safari 焦点标记迟滞（HAOC-103）**：Safari 在输入框已获得光标后仍可能短暂不报 `focused`。录制侧在可打印文本无焦点目标时延迟约 80 ms 重读一次快照；若仍无焦点，则只在最近一次左键点击命中可编辑、非安全控件、且该控件 value/text 已包含本次输入字符时，才把文本记到该控件上。没有值证据、控件被保护或不可编辑时仍报 `UNSAFE_TEXT_TARGET` / `SECURE_INPUT`，不会放宽 Chrome 与 TextEdit 的现有约束。
- **真机复测**：Chrome 页面 click → type → click 的完整回放归 HAOC-87，需按项目纪律先获批时间窗；本轮只做离线实现与断言。

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

## 窗口切换后的就绪屏障

窗口已经出现不等于页面可以接受输入：Electron 页面在重绘期间能被快照解析出控件，但 AXPress 会失败。回放因此在**切换后的第一次输入**前先做就绪证明，而不是事后兜底：

- **触发**：上一步是 `activate_app` / `focus_window`，或上一步声明了 `focusAfter`（`wait` / `hover` 不接管焦点，不算切换）。
- **生效步骤**：只有接下来的第一个 `click` / `type` / `key`。证明通过后，同一窗口的后续步骤不再等待；`paste`、`scroll`、`drag`、`hover` 不在本单范围内。
- **证明**：相隔 200 ms 连读两次快照，两次必须指向**同一窗口、同一进程实例**上同一位置的同一控件，且没有 `disabled`。取证用的就是该步派发时选目标的规则：右键容器取证的是**它选中的那一行**，`type` 取证的是**它最终要输入的那个控件**（含焦点/位置启发式与 name/value 兜底，连聚焦宿主行本身也要证明），所以「容器可用但行禁用」「聚焦框被禁用」「安全宿主」都不会被当成就绪。`type` 的文本目标还必须**唯一**：命名字段仍然匹配多个控件、多于一个可编辑控件自报 focused、或两个候选与锚点的距离分不出先后（同名/同距离），都算「还没就绪」，持续不收敛时以 `TARGET_NOT_READY` 停下而不是挑第一个。控件级安全属性在**每条** `type` 路径上都会先拒绝（安全控件 → `UNSAFE_TARGET`，零输入），不只依赖系统级 secure input 探针。没有元素目标的步骤（坐标点击、`key`）必须读到真实的窗口 `bounds` 且两次一致。派发用的就是证明接受的**同一份快照**，不会出现「证明时 enabled、派发时 disabled」。
- **只读取证**：证明阶段不允许准备窗口（不使用 Finder 侧栏重开等修复路径），提示阶段点击数为 0；窗口准备仍由该步自己的回放路径负责。
- **同标题窗口**：证明阶段把「还没有任何窗口持有目标」「候选树暂时读不到（`INCOMPLETE_TREE` / `WINDOW_CHANGED` 等）」都当作「还没就绪」在同一预算内重读；多个窗口同时持有且没有唯一前台窗口才是真歧义（`AMBIGUOUS_TARGET`）；驱动自身的故障（如 `DESKTOP_DEPENDENCY`）保留原码，不重试也不改写成 `TARGET_NOT_READY`。
- **边界**：最多 1.5 s，同一个单调时钟截止时间同时约束选窗、焦点、身份校验、快照与重试；**挂住不返回的驱动调用也会被截止**——回放不再等它，迟到的结果被丢弃且不会变成输入，超时报 `TARGET_NOT_READY`。同一个截止时间带一个取消信号，一直传到**焦点命令发出前**：截止之后才返回的前台观察不会再发 `focus-window`，前台也不会被切换。两次读数一致后、派发之前还要在预算内**再确认一次前台仍属于本窗口**：取证期间用户切走 → `FOCUS_INTERRUPTED`，不发 `focus-window`、零输入。等待期间可能出现密码提示或系统弹窗，所以证明结束、真正派发前会**重新核对** secure input 与系统弹窗门禁。目标就绪但按压仍返回 `ACTION_FAILED` 时走上面的重试 / 中心点回退，不会被就绪证明掩盖。上下文菜单项按菜单自己的打开-重试路径执行；没有 `name` / `identifier` 的目标只证明窗口，具体拒绝仍由该步自己的 `AMBIGUOUS` / `UNSAFE_TARGET` 给出。
- **录制侧**：不写固定等待。步骤里的 `atMs` 已经保留了「激活到下一步」的观测间隔，回放不把它当 sleep 使用。

## 拒绝码说明

| 错误码 | 何时出现 | 是否静默降级 |
| --- | --- | --- |
| `HEADED_REQUIRED` | 双击、三击或坐标类输入（单击 / 右键 / 滚轮）没有 `--headed` | 否，直接失败 |
| `NOT_FOUND` | 目标元素在绑定的窗口里不存在 | 否，不会落到别的控件 |
| `UNSAFE_POINT` | 坐标落在目标窗口之外，或固定应用路径的流程使用坐标输入，或 v2 dry-run 的流程里仍有 `target.kind: "point"` 的点击 | 否，不会点/滚到前台窗口 |
| `UNSAFE_TARGET` | 目标控件是安全控件；或控件及其所有容器都没有可执行 ref，且没有 bounds 可点（消息会点名控件，并提示编辑该步重新拾取目标） | 否 |
| `ACTION_FAILED` | 元素单击的语义按压持续失败：300 ms 后重读快照重试一次仍失败，且没有 bounds 可做中心点击，或中心点击本身也失败。消息点名控件并写明语义/物理尝试次数；安全控件不走回退 | 否，直接失败，后续步骤 skipped |
| `TARGET_NOT_READY` | 窗口切换后的第一次 `click` / `type` / `key` 在 1.5 s 内没能证明目标可用：目标一直解析不到、一直标记 `disabled`，或两次读到的 role/name/bounds 一直不一致、跨了窗口或进程实例；无元素目标的步骤没有可读的窗口 `bounds`；或一次读取/选窗挂住、在截止时间之后才返回（迟到结果不被采用）。消息点名控件、最后一次读到的状态与读取次数 | 否，超时前零输入；证明通过后才派发，派发用的是证明接受的同一份快照，目标就绪但按压失败仍走 `ACTION_FAILED` 的恢复路径；驱动自身故障保留原码 |
| `CLICK_POINT_FALLBACK` | 不是独立错误码：单击语义按压两次失败后改点同一控件中心的物理点击成功时，报告 message 里的标注 | 否，报告为 passed 并注明走了回退 |
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
| `UNTARGETED_HOVER` | 悬停落点无法归属到任何窗口（桌面空白、无法证明窗口），跳过且不产生缺口 | 是（录制警告） |
| `HOVER_SCREEN_FALLBACK` | 元素型悬停的窗口/元素已不能证明（四类解析失败）且该步保留了录制点，改按屏幕坐标移动指针；报告 `deliveredVia: "screen_point"`，message 带原始错误码 | 否，降级成功；指针只移动与停留 |
| `UNTARGETED_FILE_CLICK` | 全局录制里 Finder 的点击没命中任何有名字的文件项，改记坐标 | 是（录制警告），回放前需改成有名字的元素 |
| `UNTARGETED_ELEMENT_CLICK` | 全局录制里点击没命中任何有名字的元素（含只命中窗口根的空白点击），改记坐标 | 是（录制警告），回放前需改成有名字的元素，dry-run 以 `UNSAFE_POINT` 拒绝 |
| `CLICK_TARGET_UNPRESSABLE` | 录制到的控件及其所有容器都没有 AX action ref（Electron 页面常见）：回放只能按控件中心做物理点击（需 `--headed`），不是语义 press | 是（录制警告），需要时重新拾取目标 |
| `HOVER_UNRESOLVED` | 悬停的元素目标没有 bounds，无法算出回放坐标 | 否，直接失败 |
| `CLIPBOARD_UNSUPPORTED_TYPE` | 开启剪贴板录制，但 clipboard 不是纯文本 | 是（录制警告，保留快捷键） |
| `CLIPBOARD_TOO_LARGE` | 剪贴板文本超过 4000 字符 | 是（录制警告，保留快捷键） |
| `CLIPBOARD_INVALID_TEXT` | 剪贴板文本含 NUL | 是（录制警告，保留快捷键） |
| `CLIPBOARD_READ_FAILED` | 录制 Cmd+V 时读取剪贴板失败 | 是（录制警告，保留快捷键） |
| `UNSAFE_CLIPBOARD_TARGET` | Cmd+V 时没有唯一聚焦的可编辑非安全控件 | 是（录制警告，保留快捷键） |
| `FOCUSED_EDITABLE_TARGET` | 点击落在聚焦可编辑控件的范围内，target 记为该控件而不是指针命中的容器 | 是（录制警告），回放目标更准确 |
| `CLICK_RETARGETED_TO_TEXT` | 点击先记为容器，后续文本事件的焦点证据证明控件后，原地改成该控件 | 是（录制警告） |
| `TEXT_TARGET_FROM_CLICK` | 文本事件没有焦点元素证据，target 取自此前点击证明的可编辑控件 | 是（录制警告） |
| `WINDOW_SCOPE_FROM_LAST_WINDOW` | 事件自己没给出窗口（无窗口号，或标题为空的无标题 surface，如 Finder 内联重命名、右键菜单）时，归到同 app 同进程已证明的窗口，不新建窗口 | 是（录制警告），避免录出回放不存在的窗口 |
| `UNTARGETED_TEXT` | 文本事件没有焦点元素证据，兜底读树也没有证明唯一聚焦可编辑控件，这些字符被丢弃 | 是（录制警告，不产生缺口） |
| `CAPTURE_BACKLOG` | 队列落后 helper 超过 8 秒，积压的文本事件被丢弃 | 是（录制警告，不产生一串缺口） |
| `CAPTURE_STARTUP` | 录制开头（第一个可重放步骤之前）没有窗口证据的事件——500 ms 内无窗口的事件，以及任何时刻开头的 `CAPTURE_SCOPE_UNVERIFIED` 缺口——被当作启动噪音丢弃 | 是（录制警告） |
| `SNAPSHOT_UNAVAILABLE` | 指针手势的兜底读树失败，该手势记缺口。只有「预算用尽」（驱动 `complete:false`）且是只读手势（悬停 / 文本兜底）才会重试一次，两次合计受 4 s 截止时间约束；`truncated` / `identity_unproven` 不重试，第二次读失败时保留第一次失败应有的缺口 | 是（录制警告 + 缺口） |
| `SNAPSHOT_SLOW_READ` | 第一次读用尽驱动观测预算（`complete:false`，窗口在改标题/加载目录/重绘），重试读到完整树且仍覆盖该手势的点位；步骤保留，不产生缺口 | 是（录制警告） |
| `TAP_SLOW_CALLBACK` | 事件 tap 回调耗时接近系统禁用阈值（≥250 ms）。回调的全部 AX 工作受同一条 300 ms 截止时间约束，单次读取上限 0.1 s，输出写入移到后台队列；只是诊断，不产生缺口 | 是（录制警告，前 3 次） |
| `TEXT_UNVERIFIABLE` | 聚焦控件读不出来（AX 超时/预算用尽），无法证明它不是安全输入：字符不输出，整段只报一次 `STALE_CAPTURE`（`detail: text_unverifiable`） | 是（录制警告 + 缺口） |
| `TAP_INTERRUPTED` | 系统禁用了 tap（回调过慢或用户态禁用）：立刻重新启用，间隔内输入无法证明未丢，因此保留 `STALE_CAPTURE` 缺口；detail 带原因、上一次回调耗时与在处理什么 | 是（录制警告 + 缺口） |
| `IME_COMPOSITION_UNSUPPORTED` | 录到 IME 提交的 Unicode 文本；组合过程不重放 | 是（录制警告），文本本身会入 flow |
| `OUTSIDE_WINDOW` | 点击或滚动落在录制开始时的目标窗口之外 | 否，录制失败 |
| `WINDOW_CHANGED` / `WINDOW_MISMATCH` / `WINDOW_NOT_FOUND` | 回放时窗口 ID、标题或前台状态与绑定的窗口不一致 | 否，不会点错窗口 |

未在表里的通用错误码（`AMBIGUOUS_TARGET`、`PROPERTY_UNAVAILABLE`、`CAPTURE_PROTOCOL` 等）沿用 [README](../README.md) 与各设计文档的定义。
