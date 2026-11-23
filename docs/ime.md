# 输入法守卫：默认关闭，按需开启

中文输入法激活时，物理按键会被改写：Sogou 可能把 `cue` 提交成 `cu’e`（把 `'` 当音节分隔符），或者根本不提交文本。回放的 `type` 走 Unicode 注入，不受输入法影响；只有物理按键与录制侧才需要处理输入法。全局录制自己切换并在结束后恢复（见[录制](#录制自动切到-abc结束恢复)），回放要自动切换则需显式开启。

因此**回放默认完全不管理输入法**：不读输入源、不切换、不写 `ime.json`、不拿锁、不恢复，也不产生 `ime` 报告字段或任何 IME 警告。需要自动切换时用 `--input-source-switch` 显式开启。

## 默认行为（`cuekeeper run`、批量 run、工作台实时回放）

| 路径 | 默认行为 |
| --- | --- |
| 读取 TIS 输入源 | 不做任何读取（连 `version` 都不调用） |
| `type`（ASCII 或非 ASCII） | 直接用 Unicode 注入把 flow 里的 `text` 原样写入目标控件 |
| `key`（字母/数字字符） | 按记录执行 `press`，不读、不切、不阻塞 |
| `ime.json` / 输入法锁 | 不创建、不获取 |
| 运行结束 | 不恢复输入法（因为没有切换过） |
| 报告 | 没有 `ime` 字段，没有 IME 警告，退出码只由测试结果决定 |

一句话：默认回放不依赖 `cuekeeper-ime`，没有它也能完整运行。

**取舍**：默认模式不再承诺「物理按键不被输入法改写」。如果 flow 里的字符 `key` 需要在中文输入法下原样生效，请开启守卫，或自己先切到 ABC/U.S.。

### 兼容与冲突

- `--no-input-source-switch` 继续接受，作为默认行为的兼容写法：不读 TIS、不切换、不阻塞，也不产生 `IME_SWITCH_DISABLED`。
- 同时给 `--input-source-switch` 和 `--no-input-source-switch` 会被拒绝（退出码 2）。
- `--input-source` / `CUEKEEPER_IME_TARGET` / `--strict-ime` 只在 `--input-source-switch` 开启时生效；只给 `--input-source` 时标准错误会提示该参数未生效。
- 批量执行（`--data`）尚未接入守卫，`--input-source-switch` 会被明确拒绝（退出码 2），避免承诺一个不会执行的保护。
- 工作台实时回放默认不创建 IME manager，也不提供开关。

## 开启守卫：`--input-source-switch`

```sh
cuekeeper run flow.json --headed --input-source-switch
cuekeeper run flow.json --input-source-switch --report report.json
cuekeeper run flow.json --input-source-switch --strict-ime          # 恢复失败也算退出码 1
cuekeeper run flow.json --input-source-switch --input-source com.apple.keylayout.US
```

开启后：

| 路径 | 行为 |
| --- | --- |
| 回放 `type`（纯 ASCII 文本） | 执行前切到 ABC（其次 U.S.），结束后恢复原输入源；文本仍走 Unicode 注入 |
| 回放 `type`（含非 ASCII） | 不切换输入源，直接 Unicode 注入 |
| 回放 `key`（字母/数字字符） | 与 ASCII `type` 同样切换；命名键（`return`、`tab`、方向键）与 `meta`/`ctrl` 组合键不切换 |

- 目标 ASCII 源：`--input-source`，其次环境变量 `CUEKEEPER_IME_TARGET`，缺省 ABC，再退到 U.S.。
- 第一次需要切换时才取快照并加锁；同一 run 内只切一次、只恢复一次。
- 每个受守卫的步骤重新读取当前输入源：
  - 是 ASCII（含用户手动切到的另一个 ASCII）：接受，不强行切回目标。
  - 是 original 或其它非 ASCII：视为用户手动切换，步骤返回 `IME_CHANGED_BY_USER`，run 变成 `blocked`，不覆盖用户选择。
- 找不到 `cuekeeper-ime` 时只在标准错误提示一次，本次运行不守卫（不写假的报告字段）。

### 恢复

- `original`（ID + 显示名）在第一次切换前快照，并先写入运行目录的 `ime.json`，再调用 TIS。
- 成功、失败、取消、`SIGINT`/`SIGTERM` 都在 `finally` 里恢复并回读验证。
- 原输入源已卸载：不猜替代，保持当前源，返回 `IME_RESTORE_UNAVAILABLE`。
- 恢复后回读不一致、选择失败（重试一次）或读不到当前源：`IME_RESTORE_FAILED`，不会谎报成功。
- 恢复失败不改变测试结果；默认退出码仍为 0，`--strict-ime` 时改为 1。
- `SIGKILL` / 崩溃无法自动恢复：`ime.json` 保留，用 `cuekeeper ime restore --run <run目录>` 手动恢复。

### 并发

同一时间只允许一个 run 管理输入法：锁文件 `~/.cuekeeper/ime/ime.lock`（`CUEKEEPER_IME_DIR` 可覆盖根目录）带 run ID、PID 与 TTL。拿不到锁返回 `IME_BUSY`（带 `holderRunId` / `lockExpiresAt`），不并发抢输入法；持锁进程崩溃后锁过期即可接管。

录制与开启守卫的回放共用这把锁：全局录制期间另一个守卫回放会拿到 `IME_BUSY`，反过来录制发现锁被占就不切换（`IME_SWITCH_FAILED`）并照常录制。全局录制的锁 TTL 覆盖整场录制（`--max-seconds` + 60 秒），持锁进程退出后锁立即失效。

## 录制：自动切到 ABC，结束恢复

```sh
cuekeeper record --global --max-seconds 600 --out flow.json
```

全局录制（网页工作台与 CLI 都是这一条路径）在录制开始前自己处理输入法，用户不需要手动切：

- 开始前读取当前输入源；已经是 ASCII 就什么都不做（不拿锁、不碰 TIS）。
- 非 ASCII（搜狗拼音、简体拼音等）时先快照原输入源并写入 `ime.json`，再用同一把锁切到 ABC（没有 ABC 时退到 U.S.）。
- 正常停止、本地停止（工作台停止按钮）、录制失败、`SIGINT`/`SIGTERM` 都在 `finally` 里恢复原输入源并回读验证。
- 切换失败（没有 ABC/U.S.、TIS 报错、回读不一致、另一个 run 正持有输入法锁、缺少 `cuekeeper-ime`）**不阻塞录制**：写一条 `IME_SWITCH_FAILED`（缺辅助程序时是 `IME_UNAVAILABLE`）警告，录制照常进行，结束仍会尝试恢复。
- 恢复失败只写 `IME_RESTORE_FAILED` 警告，录制结果和退出码不变；`ime.json` 保留，可用 `cuekeeper ime restore --run <run目录>` 手动恢复。
- 因此新录制的 flow 不再带 `IME_ACTIVE` 警告：录制期间输入源已经被保证为 ASCII。
- 录制时人工把输入法切回中文属于用户自己的选择：不覆盖，`restore` 只报告 `IME_CHANGED_BY_USER`（`warning` 级别）。

单窗口录制（`cuekeeper record --app <bundle-id> ...`）仍然只读取并提示，不自动切换，保持原有行为；`IME_ACTIVE` / `IME_UNCOMMITTED` 仍可能出现。

录制侧的读取与警告是**独立于回放默认值**的：即使回放默认不管理输入法，录制仍会管理输入法。

## 报告与退出码

报告保留两个可选字段（flow v1 必填字段不变，旧 flow 与旧报告继续可用）；**默认运行不写这两个字段**：

| 字段 | 内容 | 何时出现 |
| --- | --- | --- |
| `ime` | `switched`、`original`、`target`、`final`、`runDir` | 开启 `--input-source-switch` 的实时回放 |
| `warnings[]` | `code`、`level`、`title`、`message`、`action`、`original`、`current`、`runId`；`IME_BUSY` 带 `holderRunId` / `lockExpiresAt`，恢复失败带 `attempted` / `verified` | 开启守卫后的阻塞/恢复问题，或录制侧警告 |

错误码：

| Code | 级别 | 含义 |
| --- | --- | --- |
| `IME_SOURCE_UNAVAILABLE` | 阻塞 | 没有可用的 ABC/U.S.，或读不到当前输入源、切换后回读不一致 |
| `IME_CHANGED_BY_USER` | 阻塞 / 警告 | 运行中检测到输入源被用户切走，不覆盖；回放为阻塞，录制为警告 |
| `IME_BUSY` | 阻塞 | 另一个 run 持有输入法锁 |
| `IME_PHYSICAL_KEY_BLOCKED` | 阻塞 | `InputSourceManager` 以关闭切换的方式构造时，物理字符按键会被输入法改写（CLI 默认不构造 manager，因此不会出现） |
| `IME_RESTORE_FAILED` | 警告 | 尝试恢复后回读不一致或选择失败 |
| `IME_RESTORE_UNAVAILABLE` | 警告 | 原输入源已被卸载/禁用，保持当前源 |
| `IME_SWITCH_DISABLED` | 警告 | `InputSourceManager` 以关闭切换的方式构造且执行 ASCII 文本（CLI 默认不构造 manager，因此不会出现） |
| `IME_ACTIVE` | 警告 | 单窗口录制开始时输入源不是 ASCII（全局录制会自动切换，不再出现） |
| `IME_UNCOMMITTED` | 警告 | 录制文本疑似被输入法改写 |
| `IME_UNAVAILABLE` | 警告 | 开启守卫或全局录制时找不到 `cuekeeper-ime` 辅助程序 |
| `IME_SWITCH_FAILED` | 警告 | 全局录制没有切到 ABC/U.S.（缺 ASCII 源、TIS 失败或锁被占用），录制继续 |

CLI 在标准错误输出「标题 + 下一步」；`--json` 的报告里包含同一份 `warnings`；查看器顶部显示同样的横幅。

退出码：默认运行只由测试结果决定；开启守卫后，IME 阻塞步骤 → run `blocked`、退出码 1，仅恢复失败 → 默认 0、`--strict-ime` 为 1。

## 辅助命令

`cuekeeper ime ...` 不受回放默认值影响，始终可用（它们本身就是显式操作）：

| 命令 | 作用 |
| --- | --- |
| `cuekeeper ime status [--json]` | 当前输入源、目标 ASCII 源、锁状态、状态目录 |
| `cuekeeper ime list [--json]` | 列出已启用的输入源 |
| `cuekeeper ime set <id> [--json]` | 切到指定输入源并回读验证（卸载原输入法后的手动恢复） |
| `cuekeeper ime restore --run <run目录> [--strict-ime]` | 按 `ime.json` 恢复，成功后删除该文件 |
| `cuekeeper ime unlock --run <run-id>` | 只释放属于该 run 的锁 |

## 实现

- `native/input-source.swift`：Carbon TIS 辅助程序（`list` / `current` / `select --id`）。只读与选择，不注入按键、不弹权限框；由 `pnpm build:recorder` 与发布包一起构建到 `dist/cuekeeper-ime`。
- `src/ime.ts`：`ImeBackend` 接口 + `InputSourceManager`（回放守卫与录制时的 `startRecording` / `restore(true)` 共用同一把锁、同一份 `ime.json`），测试注入 fake，不碰真实 TIS。
- `src/cli.ts`：只有 `--input-source-switch` 才构造回放的 `InputSourceManager`；`record --global` 在建流前 `startRecording()`、在 `finally` 里恢复，工作台通过 CLI 子进程走同一条路径；`src/record.ts` 做单窗口录制侧检测。

## 已知限制

- 批量执行 `--data` 尚未接入守卫（逐行切换会互相干扰），需要单独设计，目前拒绝 `--input-source-switch`。
- 工作台实时回放没有开启守卫的入口（默认关闭，无设置面板）。
- Windows 输入法未实现，只保留 `ImeBackend` 接口。
- 不尝试把 `cu’e` 猜回 `cue`：只做检测、提示、切换与阻塞。
- 不修改系统输入法配置；切换与恢复都通过 TIS，用户随时可接管。
