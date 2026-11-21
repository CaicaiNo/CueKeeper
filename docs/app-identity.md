# macOS 应用副本身份（HAOC-77）

**已实现** · 工作台目录能显示同 bundle ID 的多个安装路径，并把用户选中的路径写进可选的 `flow.target.appPath`。v1 schema 当前接受任意非空路径字符串。现有回放仍用 `target.app` 查询驱动，主流程只在读取快照后核对窗口 ID，录制的前台判断也只比较 bundle ID。见 `workbench/model.js`、`src/desktop.ts`、`src/run.ts` 和 `native/recorder.swift`。

**待实现** · 本文和 [v1 schema 提案](../design/app-identity/schema-diff.json) 定义从选中副本到输入送达的契约。JSON 文件按当前仓库惯例以 schema 路径为键，值为 RFC 6902 操作数组。两份补丁都针对当前 `schemas/` 下的生成产物，后续实施时先改 `src/contracts.ts`，再用 `pnpm schemas:write` 生成正式 schema。

## 1. 身份与回退

| 层次 | 状态 | 规则 |
| --- | --- | --- |
| 安装副本 | 待实现 | `target.appPath` 存在时，以解析符号链接后的 bundle 路径指定副本。`target.app` 是必填的 bundle ID，用于核对安装包的 `CFBundleIdentifier` 并筛选运行实例。前台、默认安装位置、应用显示名和窗口标题都无权替换已指定的路径。 |
| 运行实例 | 待实现 | 每次实时执行绑定 `(bundle ID, canonical bundle path, PID, 进程启动标识)`。PID 与启动标识只在本次运行内有效。绑定后遇到退出、重启、PID 复用或副本变化即停止，下一轮从头解析。 |
| 窗口 | 待实现 | 先确认实例，再在该实例的窗口中匹配标题。主窗口用现有精确标题语义，窗口断言保留既有的匹配运算。绑定后用窗口 ID 并复核 owner，拒绝同标题的新窗口。 |
| 旧流程 | 待实现 | 缺省 `appPath` 时，身份完整且只有一个同 ID 运行实例即可继续。即使磁盘上另有副本，当前唯一运行者仍可作为本轮的旧版绑定。两个同 ID 实例、身份信息缺失或来源相互矛盾时阻塞。运行与导入均保持旧文件原样，用户主动选择路径并保存时才补写。 |

| 实时解析结果 | 状态 | 决策 |
| --- | --- | --- |
| 指定路径有效，且恰有一个运行者与该路径相符 | 待实现 | 绑定该实例。已证实在其他路径的同 ID 实例可同时运行。 |
| 同 ID 运行者只在其他路径，或指定路径有多个运行者 | 待实现 | `APP_AMBIGUOUS`。同 ID 实例中有无法排除是目标副本的未知路径，也以该错误阻塞。 |
| 同 ID 实例确认为零 | 待实现 | 进入未运行状态。需要目标时保留 `APP_NOT_FOUND`，现有已确认的 `ensure` 可以按 §3 启动。完整的只读窗口清单此时可为空，供 `exists: false` 判断。 |
| 路径不存在、读取失败、目标已移动、解析后不是有效 bundle，或其 Info.plist 的 bundle ID 不符 | 待实现 | `APP_PATH_INVALID`，即使原位置曾有同 ID 副本也需重新选择。 |
| 实例已证实，所需标题不存在或匹配多扇窗口 | 待实现 | 保留 `WINDOW_NOT_FOUND` 或 `AMBIGUOUS_TARGET`。已绑定窗口消失时用 `WINDOW_CHANGED`。若同一窗口 ID 已归属其他进程，按 `APP_AMBIGUOUS` 处理。 |

## 2. 契约与采集

- **待实现** · v1 保留必填 `target.app`、`target.window`，`appPath` 可省略，保留 `additionalProperties: false`。schema 只验证 `appPath` 的字符串长度（1–4096）和路径外形，接受以单个 `/` 开头的 POSIX 路径、Windows 盘符绝对路径与标准 UNC 文件路径。拒绝控制字符、相对路径、`~` 简写、盘符相对路径、文件 URL 和 Windows 设备命名空间。旧版无路径文档无需迁移。过去手填的相对路径需改成绝对路径。
- **待实现** · macOS 实时运行时，`realpath` 按本机文件系统解析，确认规范路径是可读 `.app` 包并从该位置读取 `CFBundleIdentifier`。`bundleURL` 须为文件 URL，解码后经同样的解析和校验。比较文件系统返回的规范路径，并保留大小写与 Unicode 字符。回放允许应用在相同路径更新后重新开始一轮。Windows 路径可跨平台存储和离线读取，当前 macOS 实时入口遇到 Windows 路径返回 `UNSUPPORTED_PLATFORM`，将来由 Windows 适配器核对实例。`flow validate`、导入和带快照的离线检查都可在路径指向另一台机器时运行。
- **待实现** · 录制和实时 `pick` 共用只读原生身份查询。按窗口 owner PID 取 `NSRunningApplication(processIdentifier:)` 的 `bundleIdentifier` 和 `bundleURL`。枚举同 ID 运行者时可从 `NSRunningApplication.runningApplications(withBundleIdentifier:)` 取得候选。进程代际由 PID 加系统进程启动标识确定，可用 `proc_pidinfo` 读取启动时间，涵盖 `launchDate` 缺失的实例。`lsappinfo` 仅用于人工排查 PID 与 bundle 路径，Spotlight/目录仅用于安装候选或重选提示。系统无法证明运行身份时阻塞。 [Apple NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication) · [窗口 owner PID](https://developer.apple.com/documentation/coregraphics/kcgwindowownerpid)
- **待实现** · `record` 与实时 `pick` 支持 `--app-path`。仅在确认所绑窗口的 PID、进程启动标识和实际路径后写入。录制 helper 在 `ready` 握手确认与调用端同一个实例，键盘校验前台和事件目标，指针校验窗口命中及 owner，快照始终携带同一窗口 ID。切到其他副本时忽略其事件，绑定丢失时结束录制并标明已录部分。路径写入 `flow.target.appPath`，实时 `pick` 写到结果的 `target.appPath`，元素定位器保持通用。录制遇到无法转成元素定位器的点击时跳过该点击并提示部分录制，避免生成路径固定流程无法回放的裸坐标。
- **待实现** · 支持时在 Cuekeeper 保存的 `snapshot.json` 信封 `target.appPath` 写入同一规范路径，作为离线来源元数据。路径身份以 flow 为准。运行 PID、窗口 ID 和源路径日志均不作为流程身份持久化。两边都带路径时离线按已保存的字符串核对，差异按 `APP_AMBIGUOUS` / `fixture_path_mismatch` 阻塞。只有一边或两边都无路径时仍可按 app 和标题使用旧快照，报告标 `offline_unverified`。任何离线成功仅说明 fixture 内定位通过。旧录制导入不从默认应用或已安装清单推测当时捕获的路径。

## 3. 回放绑定和送达

1. **待实现** · CLI 和工作台共用实时入口。开始运行时先做主目标的文件和实例预检，再调用会聚焦、启动或送输入的命令。已有 `setup.ensure` 和窗口断言指向主 bundle ID 时继承路径与进程绑定，允许在该实例内另选窗口。其他 bundle ID 各自按旧版唯一实例规则核对。观察到的歧义向上透传，不能作为空窗口清单、可重试的缺窗或修复触发条件。
2. **待实现** · 只有原有已确认的 `ensure` 可以启动应用。目标无运行实例时，指定路径直接作为 `NSWorkspace.openApplication(at:configuration:)` 的文件 URL。禁用运行副本替换，按修复动作决定是否激活，避免系统代为请求交互。旧流程无运行者时，先从可用安装候选中确认唯一可用路径，再走同一启动路线。多个候选或探测结果不完整时阻塞。启动后重新读取 PID、启动标识与 `bundleURL`。一旦完成绑定，同一轮的 `ensure` 不接管重启后的新进程。 [Apple 按 URL 启动接口](https://developer.apple.com/documentation/appkit/nsworkspace/openapplication(at:configuration:completionhandler:)) · [运行副本替换选项](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/allowsrunningapplicationsubstitution)
3. **待实现** · 使用按 PID 过滤的窗口清单。以原生 `kCGWindowNumber` / `kCGWindowOwnerPID` 与驱动无 `--app` 的 `list-windows` 对照，核对 `w-<number>`、PID 和驱动的 `process_instance`。窗口选择、清单缺失与身份冲突分别处理。无法获得覆盖目标实例的清单时，返回 `APP_AMBIGUOUS`，不能凭窗口标题或显示名猜测。 [Apple 窗口清单接口](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:)) · [驱动窗口字段](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/system/window_info.rs)
4. **已实现（上游）** · agent-desktop 1.3.1 的 `snapshot` 与 `press` 有按窗口 ID 查询的代码路径，`focus-window` 也能只传窗口 ID。`snapshot` 的 `data.window` 只给 ID 和标题。`screenshot` 同时传 `--app` 时会先解析应用，再按窗口 ID 查询。`mouse-click` 使用全局屏幕坐标，命令参数没有窗口 ID。 [窗口选择](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/snapshot/surface_target.rs#L154-L176) · [快照响应](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/commands/snapshot.rs#L125-L144) · [键盘目标](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/commands/press.rs#L76-L95) · [聚焦](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/commands/focus_window.rs#L11-L48) · [截图](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/commands/screenshot.rs#L84-L123) · [坐标点击](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/crates/core/src/commands/mouse_click.rs#L12-L46)
5. **待实现** · `snapshot`、`press`、`focus-window` 和 `screenshot` 走仅 `--window-id` 的调用，使用前后独立的 owner 核对。`click`、`type` 和属性观察只用刚从同一窗口、同一驱动会话得到的限定 ref。任何操作前复核实例及窗口，读取后的身份冲突使快照、ref 或截图失效。驱动若无法证明窗口或 ref 绑定，回报 `APP_AMBIGUOUS` 并停止。无法按窗口绑定的调用不得退回 bundle ID 或全局前台。输入若已尝试送达才发现身份变化，保留驱动 disposition；无可信 disposition 时报告 `delivery_uncertain`，停止并禁止自动重试。
6. **待实现** · 已固定路径的流程在发现裸坐标点击时以 `UNSAFE_POINT` 阻塞，提示用元素拾取替换。旧版无路径流程仍保留唯一实例下的 `--headed` 坐标路线，要求聚焦后再次确认进程、窗口和实际顶层命中。全局坐标调用与前台验证之间仍有竞争窗口，检测到送达状态不明时按上一条处理。无需给 agent-desktop 增加参数，也无需进程级注入。
7. **需实机** · 测试仅传 ID 时，驱动对非前台、同标题副本的快照、ref、键盘、聚焦和截图行为。每个会送输入的路径须通过 HAOC-76 才可对路径固定流程启用，尤其要覆盖 `--headed` ref 和快捷键的物理回退。当前设计中的复查用于发现失配，应用与窗口可能在两次系统调用间变化，驱动实际送达的绑定也必须成立。

## 4. 错误与报告

| 状态 | 错误码 | `appIdentity.reason` | 用户提示 |
| --- | --- | --- | --- |
| 待实现 | `APP_PATH_INVALID`（新增） | `invalid_bundle_path`、`bundle_id_mismatch` | 「选中的应用路径已失效或应用标识已变更，请重新选择副本并保存。」 |
| 待实现 | `APP_AMBIGUOUS`（新增） | `path_mismatch`、`multiple_instances`、`multiple_installed_copies` | 「无法唯一确认目标副本。请打开选中的副本，或关闭冲突实例后重新运行。」 |
| 待实现 | `APP_AMBIGUOUS` | `identity_unproven`、`instance_changed`、`driver_target_unconfirmed` | 「无法确认操作仍指向选中的副本，本轮已停止。」送达不明时加「请检查上一步是否已经生效。」 |
| 待实现 | `APP_AMBIGUOUS` | `fixture_path_mismatch` | 「快照来自另一个应用路径，请重新采集快照或恢复与快照匹配的目标。」 |
| 待实现 | `UNSUPPORTED_PLATFORM`（复用） | `unsupported_path_platform` | 「该应用路径属于另一平台。本机可验证流程或使用离线快照。」 |
| 待实现 | `UNSAFE_POINT`（复用） | `untargeted_input` | 「该坐标操作无法绑定到选中的副本，请改用元素定位器。」 |

- **待实现** · v1 报告可选 `appIdentity`，其中 `app` 是所报告目标的 bundle ID，`mode` 为 `bundle_path` 或 `legacy_bundle_id`。`status: verified` 表示主目标至少完成一次窗口或实例核对，`offline_unverified` 表示离线来源，`blocked` 记录首个终止运行的身份问题。阻塞时填 `code`、`reason`，有触发步骤时填 `entryId`；可指向次要应用对应的 setup 或断言。尚未检查到实例且无身份错误时可省略该字段。绑定前只确认磁盘路径不足以标 `verified`。
- **待实现** · 报告使用已有 `blocked` 状态与退出码 1。启动前阻塞时按原顺序输出所有计划动作的 `blocked` 条目，无虚构步骤，顶层填 `appIdentity`。运行中阻塞则在真实触发条目加错误码与提示，后续动作记 `skipped`，保留 `flowSha256` 和现有打包/时间线契约。若发生在已启动的修复里，保留 `repair.attempted` 与具体 `repair.code`，顶层身份错误保持可见。schema 解析失败沿用无效输入退出码 2。旧报告可省略 `appIdentity`，新版读者照常读取。
- **待实现** · 工作台和查看器从 report 展示阻塞原因，工作台本地选择器可展示候选路径。报告字段与通用提示只保存标识、模式及原因，避免披露其他副本的绝对路径和临时 PID。报告包原样附带 flow，分享前可在本地看到其中 `target.appPath` 所含的绝对路径。

## 5. 实施拆分与离线验收

| 里程碑 | 状态与依赖 | 文件边界 | 可验证交付 |
| --- | --- | --- | --- |
| 1. 可读写的 v1 契约 | 待实现 · 先交付 | `src/contracts.ts`、`schemas/flow.schema.json`、`schemas/report.schema.json`，契约测试 `test/app-identity-contract.test.mjs` | 补丁两份均可应用。用旧 flow/报告、现有 picker 绝对路径、POSIX/盘符/UNC、相对/设备路径、附加字段和缺阻塞原因的 fixture 验证接受与拒绝。路径不存在于本机的合法文档仍能离线校验；旧文件的摘要一致。 |
| 2. 运行实例绑定与错误展示 | 待实现 · 依赖 1 | `native/app-identity.swift`（新）、`scripts/build-recorder.sh`、`src/app-identity.ts`（新）、`src/desktop.ts`、`src/run.ts`、`src/assertion.ts`、`src/viewer.ts`，运行测试 `test/app-identity-replay.test.mjs` | 注入进程、窗口与文件系统 fixture，复用现有测试的驱动 stub 断言实际命令和报告。用下表覆盖确定性选择、启动授权和停止路径。 |
| 3. 录制、拾取与路径传递 | 待实现 · 依赖 2 | `native/recorder.swift`、`src/record.ts`、`src/cli.ts`、`src/workbench.ts`、`src/workbench-session.ts`、`workbench/{app,model,picker}.js`，采集测试 `test/app-identity-capture.test.mjs` | 模拟 helper 握手和焦点事件，验证非默认副本写入 flow、其他副本事件无录入、绑定失效的部分录制、pick 与快照来源一致、旧会话加载和显式路径重选。实时入口使用同一绑定，保存与再次运行不会偷偷复用旧路径。 |

| Replay fixture | 状态 | 关键断言 |
| --- | --- | --- |
| 唯一副本、无路径旧 flow；同路径的符号链接；包路径带空格和非 ASCII | 待实现 | 保留旧 flow 字节；绑定正确 PID/窗口；解析后路径相等；驱动参数数组正确传递。 |
| 同 ID 的 A/B 均运行，安装位置不同、标题相同，选 B，A 前台 | 待实现 | 只产生 B 的 `--window-id` 与 ref；截图命令不带 `--app`；B 目标的同 bundle 断言只看 B，A 只作为其他副本存在。 |
| A/B 均运行且 flow 无路径；只运行 A 而 flow 指定 B；B 路径下两个 PID；某同 ID 实例无法确认路径 | 待实现 | `APP_AMBIGUOUS`、正确的原因、从歧义出现起无后续点击、键盘、焦点修复或启动。 |
| B 移走、符号链接断裂、包被其他 bundle ID 替换；Windows 路径导入 macOS | 待实现 | 前三项 `APP_PATH_INVALID`，最后一项 `UNSUPPORTED_PLATFORM`；读取离线 fixture 时不查本机安装。 |
| 同 ID 实例确认为零；按路径 `ensure` 启动；无路径但多个安装候选；启动后系统返回另一个 URL | 待实现 | 无已确认 `ensure` 时不启动；授权时仅提交精确路径；多候选及 URL 失配均阻塞；真正缺失时只读 `exists: false` 可成立。 |
| PID 复用、窗口换主、启动标识变化、驱动拒绝 ID、调用中途失配、旧快照和不同路径快照 | 待实现 | 绑定不可恢复；已尝试送达保留 disposition；两份路径冲突报 `fixture_path_mismatch`；无路径旧快照标 `offline_unverified`。 |
| 两个窗口同标题均属 B；主窗口与同 app 次要窗口；路径固定流程包含裸坐标步骤 | 待实现 | 首项 `AMBIGUOUS_TARGET`，次项指向同一 B 的不同窗口，第三项不调用全局 `mouse-click`。 |

## 6. HAOC-76 真机验收

**需实机** · 在 HAOC-76 完成以下验证。使用可见标记不同、同 bundle ID 且同窗口标题的两个专用测试副本。每项留存命令、预期和实测、flow、报告及 A/B 输入前后证据。先说明预计授权提示与占用时长，征得用户当轮明确同意和时间窗，再分开编译与运行。出现错投、授权弹窗超预期或用户叫停时停止。

1. **需实机** · 录制及实时 pick 非默认副本 B，核对 `bundleURL`、CG 窗口 owner 与写入路径。录制中切到 A 输入，再切回 B，检查 A 的输入未被写入。旧录制和旧快照仍可离线定位。
2. **需实机** · A 前台、B 在后台时，逐条验证仅传窗口 ID 的快照、属性、聚焦、截图和键盘，以及从 B 快照获取 ref 后的 `click` / `type`。覆盖有头 ref 与键盘的物理回退及路径固定的坐标拒绝。A 的内容、选择和焦点变化须与预期相符，A 无输入副作用。无法证明的输入路径保持阻塞。
3. **需实机** · 只运行 A 而指定 B、同路径双实例（若测试 App 支持）、运行中重启 B、关闭并重开同标题窗口，以及移走 B 或使其符号链接失效，验证早停、错误码及无错投。另测 B 缺席时经已确认 `ensure` 按 URL 启动，核对 LaunchServices 最终返回的路径与 PID。用单副本旧 flow 验证旧入口与 `--headed` 坐标路线。
