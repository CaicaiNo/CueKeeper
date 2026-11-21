# 输入操作支持矩阵

本表覆盖 macOS 首版 v1 flow 的指针、键盘与流程动作，一行一个操作。状态口径：

- **支持**：录制器或工作台能产出、`run` 能执行，并有离线用例断言真实行为。
- **部分**：只在限定条件下可用，条件写在单元格里。
- **不支持**：显式报错，或在「不支持的操作」一节标注明确的警告 / 拒绝方式，不会静默变成别的动作。

离线测试来自 `pnpm test` 与 `sh scripts/test-recording-pointer.sh`（后者只编译纯逻辑测试二进制，不碰 AX、TCC 或真实输入）。**本单（HAOC-95）只做离线实现与测试，真机一列全部是「未验证」，统一指向 HAOC-76 / HAOC-87。** 真机验证须按项目纪律先获批时间窗，不随离线任务执行。

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
| 右键（元素） | 支持。右键按下记 `button: "right"`，只允许单击；右键拖拽跳过并报 `DRAG_SKIPPED` | 支持。驱动 `right-click <ref>`；元素路径无需 `--headed` | `test/pointer-input.test.mjs`、`test/cuekeeper.test.mjs`、`test/recording-pointer-tests.swift` | 未验证 → HAOC-76/87（含右键菜单实际弹出） | `UNSUPPORTED_CLICK_COUNT`（`button: "right"` 带 `count > 1` 在规划期拒绝）、`NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`、`DRAG_SKIPPED`（录制警告） |
| 右键（坐标） | 支持。落点无元素时记 `target.point` + `button: "right"` | 支持，必须 `--headed`。驱动 `mouse-click --xy --button right` | `test/pointer-input.test.mjs`（schema 接受、适配器参数） | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`UNSUPPORTED_CLICK_COUNT` |
| 滚轮 / 触控板滚动（元素） | 支持。`scrollWheel` 取行增量 `deltaX`/`deltaY`（各轴 ±1000），缺行增量时回退到 point / fixed-point 增量；同一目标 350 ms 内合并为一步，`durationMs` 记整段时长 | 支持。驱动 `scroll <ref> --direction --amount`；delta 换算方向与行数，右/左滚动同理 | `test/pointer-input.test.mjs`、`test/cuekeeper.test.mjs`（录制合并与 CLI）、`test/viewer.test.mjs`、`test/workbench.test.mjs` | 未验证 → HAOC-76/87（方向、惯性、顺滑度） | `NOT_FOUND`、`AMBIGUOUS_TARGET`、`UNSAFE_TARGET`；录制侧 `UNTARGETED_POINT`、`EVENT_LIMIT` |
| 滚轮（坐标） | 支持。落点无元素时记 `target.point` 加原始 delta | 支持，必须 `--headed`。驱动 `mouse-wheel --x --y --dx= --dy=`（负值用 `=` 形式，避免被当成 flag） | `test/pointer-input.test.mjs`（适配器参数）、`test/viewer.test.mjs` | 未验证 → HAOC-76/87 | `HEADED_REQUIRED`、`UNSAFE_POINT`、`WINDOW_CHANGED`、`UNSUPPORTED_SCROLL`（适配器兜底；双轴为 0 已在规划期拒绝）、`OUTSIDE_WINDOW`（录制） |

### 滚轮的已知限制

- 只记录实际 delta，不承诺复刻惯性 / 动量；合并窗口会改变单步力度，长时间连续滚动可能先命中 `EVENT_LIMIT`（1000 条原生事件）。
- 非目标窗口、目标应用非前台、或落在录制指示器上的滚轮事件被丢弃（原生侧发 `boundary`，不产生步骤，也不产生警告）。这是有意的目标域限制，但**属于静默丢弃**；如果误滚，请在录制结果里核对步骤数。
- 滚轮 delta 的符号约定与驱动 `mouse-wheel --dy` 同号（正 `deltaY` = 向上 / 内容向下移动），仅离线对齐，真机方向与惯性列入 HAOC-87。

## 键盘与文本

| 操作 | 录制 | 回放 | 离线测试 | 真机状态 | 错误码 |
| --- | --- | --- | --- | --- | --- |
| ASCII 文本输入 | 支持。按焦点可编辑控件与 1.5 s 时间间隔合并为 `type` | 支持。驱动 `type <ref> --stdin`，文本不进 argv | `test/cuekeeper.test.mjs`（录制 click/type/key） | 未验证 → HAOC-76/87 | `UNSAFE_TEXT_TARGET`（录制：无焦点或保护控件）、`SECURE_INPUT`（录制）、`UNSAFE_TARGET`（回放：安全控件或无 ref） |
| 快捷键 / 特殊键 | 支持。ANSI 可打印键与方向键、F1–F12、修饰键组合；按住重复只记一次并报 `KEY_REPEAT` | 支持。驱动 `press <combo> --window-id` | `test/cuekeeper.test.mjs`、`test/recording-hotkeys` | 未验证 → HAOC-76/87 | `UNSUPPORTED_KEY`（录制警告）、`UNSUPPORTED_EVENT`（录制警告）、`KEY_REPEAT`（录制警告） |
| Cmd+V 等剪贴板快捷键 | 部分。只记快捷键本身 | 部分。回放时读取**当时**系统剪贴板，不复刻录制时的内容 | 同上（快捷键路径） | 未验证 → HAOC-76/87 | 无专用错误码；内容不一致不会报错 |
| IME / 非 ASCII 输入 | 不支持。非 ASCII 字符报 `UNSUPPORTED_TEXT` 警告 | 不支持（schema 不限制字符集，但驱动行为未验证） | 无（列为后续单） | 未验证 → HAOC-76/87 | `UNSUPPORTED_TEXT`（录制警告） |

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
| 拖拽（按住移动后松开） | 跳过，报 `DRAG_SKIPPED` 警告；右键拖拽同样跳过 | schema 无 `drag`，规划期拒绝 | HAOC-93 |
| 中键 / 其它鼠标键 | 跳过，报 `UNSUPPORTED_CLICK` / `UNSUPPORTED_EVENT` 警告 | `button` 只接受 `left` / `right`，其它值 schema 拒绝 | 后续单 |
| 四击及以上 | 按三击记录，报 `MULTI_CLICK_TRUNCATED` 警告 | `count` 上限为 3，更大的值 schema 拒绝 | 本单边界 |
| 悬停 / 无按键移动 | 不监听 `mouseMoved`，不产生步骤（无警告） | schema 无 `hover` | 后续单 |
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
| `DRAG_SKIPPED` | 录制到拖拽，跳过该手势 | 是（录制警告） |
| `UNTARGETED_POINT` | 固定应用路径的录制里，坐标点击 / 滚动无法绑定到元素 | 是（录制警告） |
| `OUTSIDE_WINDOW` | 点击或滚动落在录制开始时的目标窗口之外 | 否，录制失败 |
| `WINDOW_CHANGED` / `WINDOW_MISMATCH` / `WINDOW_NOT_FOUND` | 回放时窗口 ID、标题或前台状态与绑定的窗口不一致 | 否，不会点错窗口 |

未在表里的通用错误码（`AMBIGUOUS_TARGET`、`PROPERTY_UNAVAILABLE`、`CAPTURE_PROTOCOL` 等）沿用 [README](../README.md) 与各设计文档的定义。
