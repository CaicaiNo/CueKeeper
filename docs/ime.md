# 输入法守卫：录制检测、回放切换与恢复

中文输入法激活时，物理按键会被改写：Sogou 可能把 `cue` 提交成 `cu’e`（把 `'` 当音节分隔符），或者根本不提交文本。回放的 `type` 走 Unicode 注入，不受输入法影响；录制与物理按键路径需要一个显式的守卫。

## 范围

| 路径 | 行为 |
| --- | --- |
| 回放 `type`（纯 ASCII 文本） | 执行前切到 ABC（其次 U.S.），结束后恢复原输入源；文本仍走 Unicode 注入 |
| 回放 `type`（含非 ASCII） | 不切换输入源，直接 Unicode 注入 |
| 回放 `key`（字母/数字字符） | 与 ASCII `type` 同样切换；命名键（`return`、`tab`、方向键）与 `meta`/`ctrl` 组合键不切换 |
| 录制 | 开始前读取输入源；非 ASCII 时警告并写入运行数据，不自动切换 |
| 录制文本校验 | 落盘的 type 文本含输入法分隔符（`cu’e`）时给出 `IME_UNCOMMITTED` 警告，不静默保存 |
| 批量执行（`--data`） | 暂不启用守卫，见「已知限制」 |

## 回放

```sh
cuekeeper run flow.json --headed --report report.json
cuekeeper run flow.json --no-input-source-switch   # 自己管理输入法
cuekeeper run flow.json --strict-ime               # 恢复失败也算退出码 1
cuekeeper run flow.json --input-source com.apple.keylayout.US
```

- 目标 ASCII 源：`--input-source`，其次环境变量 `CUEKEEPER_IME_TARGET`，缺省 ABC，再退到 U.S.。
- 第一次需要切换时才取快照并加锁；同一 run 内只切一次、只恢复一次。
- 每个受守卫的步骤重新读取当前输入源：
  - 是 ASCII（含用户手动切到的另一个 ASCII）：接受，不强行切回目标。
  - 是 original 或其它非 ASCII：视为用户手动切换，步骤返回 `IME_CHANGED_BY_USER`，run 变成 `blocked`，不覆盖用户选择。
- `--no-input-source-switch` 关闭自动切换：ASCII `type` 只警告（Unicode 注入仍然正确），字符 `key` 直接阻塞（`IME_PHYSICAL_KEY_BLOCKED`），因为物理按键会被输入法改写。

### 恢复

- `original`（ID + 显示名）在第一次切换前快照，并先写入运行目录的 `ime.json`，再调用 TIS。
- 成功、失败、取消、`SIGINT`/`SIGTERM` 都在 `finally` 里恢复并回读验证。
- 原输入源已卸载：不猜替代，保持当前源，返回 `IME_RESTORE_UNAVAILABLE`。
- 恢复后回读不一致、选择失败（重试一次）或读不到当前源：`IME_RESTORE_FAILED`，不会谎报成功。
- 恢复失败不改变测试结果；默认退出码仍为 0，`--strict-ime` 时改为 1。
- `SIGKILL` / 崩溃无法自动恢复：`ime.json` 保留，用 `cuekeeper ime restore --run <run目录>` 手动恢复。

### 并发

同一时间只允许一个 run 管理输入法：锁文件 `~/.cuekeeper/ime/ime.lock`（`CUEKEEPER_IME_DIR` 可覆盖根目录）带 run ID、PID 与 TTL。拿不到锁返回 `IME_BUSY`（带 `holderRunId` / `lockExpiresAt`），不并发抢输入法；持锁进程崩溃后锁过期即可接管。

## 录制

```sh
cuekeeper record --app com.apple.TextEdit --window notes.txt --out flow.json
```

- 开始前读取当前输入源；非 ASCII 时在标准错误提示，并在 `data.inputSource` 记录来源。
- 完成时扫描已落盘的 type 文本：出现 `’`/`` ` ``/`＇` 分隔符，或在非 ASCII 源下出现 `'` 分隔符，就写 `IME_UNCOMMITTED` 警告并标出步骤 ID。
- 录制不会自动切换输入法：切换会让用户误以为按键被记录，实际候选状态不可见。

## 报告与退出码

报告新增两个可选字段（flow v1 必填字段不变，旧 flow 与旧报告继续可用）：

| 字段 | 内容 |
| --- | --- |
| `ime` | `switched`、`original`、`target`、`final`、`runDir` |
| `warnings[]` | `code`、`level`、`title`、`message`、`action`、`original`、`current`、`runId`；`IME_BUSY` 带 `holderRunId` / `lockExpiresAt`，恢复失败带 `attempted` / `verified` |

错误码：

| Code | 级别 | 含义 |
| --- | --- | --- |
| `IME_SOURCE_UNAVAILABLE` | 阻塞 | 没有可用的 ABC/U.S.，或读不到当前输入源、切换后回读不一致 |
| `IME_CHANGED_BY_USER` | 阻塞 | 运行中检测到输入源被用户切走，不覆盖 |
| `IME_BUSY` | 阻塞 | 另一个 run 持有输入法锁 |
| `IME_PHYSICAL_KEY_BLOCKED` | 阻塞 | 关闭自动切换时，物理字符按键会被输入法改写 |
| `IME_RESTORE_FAILED` | 警告 | 尝试恢复后回读不一致或选择失败 |
| `IME_RESTORE_UNAVAILABLE` | 警告 | 原输入源已被卸载/禁用，保持当前源 |
| `IME_SWITCH_DISABLED` | 警告 | `--no-input-source-switch` 下执行 ASCII 文本 |
| `IME_ACTIVE` | 警告 | 录制开始时输入源不是 ASCII |
| `IME_UNCOMMITTED` | 警告 | 录制文本疑似被输入法改写 |
| `IME_UNAVAILABLE` | 警告 | 找不到 `cuekeeper-ime` 辅助程序，本次未守卫 |

CLI 在标准错误输出「标题 + 下一步」；`--json` 的报告里包含同一份 `warnings`；查看器顶部显示同样的横幅。

退出码：IME 阻塞步骤 → run `blocked`、退出码 1；仅恢复失败 → 默认 0，`--strict-ime` 为 1。

## 辅助命令

| 命令 | 作用 |
| --- | --- |
| `cuekeeper ime status [--json]` | 当前输入源、目标 ASCII 源、锁状态、状态目录 |
| `cuekeeper ime list [--json]` | 列出已启用的输入源 |
| `cuekeeper ime set <id> [--json]` | 切到指定输入源并回读验证（卸载原输入法后的手动恢复） |
| `cuekeeper ime restore --run <run目录> [--strict-ime]` | 按 `ime.json` 恢复，成功后删除该文件 |
| `cuekeeper ime unlock --run <run-id>` | 只释放属于该 run 的锁 |

## 实现

- `native/input-source.swift`：Carbon TIS 辅助程序（`list` / `current` / `select --id`）。只读与选择，不注入按键、不弹权限框；由 `pnpm build:recorder` 与发布包一起构建到 `dist/cuekeeper-ime`。
- `src/ime.ts`：`ImeBackend` 接口 + `InputSourceManager`，测试注入 fake，不碰真实 TIS。
- `src/run.ts` 在 `type` / 字符 `key` 前调用守卫，`finally` 恢复；`src/record.ts` 做录制侧检测。

## 已知限制

- 批量执行 `--data` 尚未接入守卫（逐行切换会互相干扰），需要单独设计。
- Windows 输入法未实现，只保留 `ImeBackend` 接口。
- 不尝试把 `cu’e` 猜回 `cue`：只做检测、提示、切换与阻塞。
- 不修改系统输入法配置；切换与恢复都通过 TIS，用户随时可接管。
