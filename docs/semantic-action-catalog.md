# 语义动作清单（首批 8 个）

HAOC-99 · 设计稿 · 未实现

本表是 [语义动作层设计](semantic-actions.md) 的配套动作契约。所有动作都遵守同一组前提：

- 只由确定性规则识别，不经过 LLM；只产出建议，必须人工确认。
- 参数是封闭对象；只允许表中列出的字段。
- 执行前重新抓取 AX 树并重新定位，不复用录制时的 ref，不自动重试。
- 只使用现有驱动能力（agent-desktop 1.3.1）与 AX / 快捷键；语义动作不使用坐标兜底。
- 「可回放」指首版设计目标；当前未实现，真机状态一律未验证。

## 总表

| 动作 | 参数 | 适用 app（bundle ID） | 识别依据 | 首版可回放 | 结果验证 | 主要失败码 |
| --- | --- | --- | --- | --- | --- | --- |
| `rename_file` | `oldName`、`newName` | Finder `com.apple.finder` | 行点击 + Return + 内联输入 + Return；或右键 / 菜单栏重命名 + 菜单证据 | 是（Return 路径）；右键 / 菜单栏需 S4 | 新名出现、旧名消失 | `INTENT_TARGET_NOT_FOUND`、`INTENT_VERIFY_FAILED`、`INTENT_UNSUPPORTED_PATH`、`INTENT_BLOCKED_BY_DIALOG` |
| `open_file` | `name` | Finder | 行双击（`count: 2`）或 ⌘O；**首版不产出建议**，动作保留给 S5 | **否**（切换目标窗口，超出 v1 单窗口绑定） | 新窗口标题（仅记录预期） | `INTENT_UNSUPPORTED_ACTION` |
| `save_file` | 无 | 文本编辑类：TextEdit、Pages、Numbers、Keynote 等有 ⌘S 的 app | 单步 ⌘S | 是 | 只确认送达、无「另存为」对话框；落盘由后续 `assert` 证明 | `INTENT_STEP_FAILED`、`INTENT_TARGET_NOT_FOUND` |
| `close_window` | `window` | 任意有标准窗口的 app | 单步 ⌘W 或点关闭按钮 | 是（必须是流程最后一个 UI 动作） | `list-windows` 中标题消失 | `INTENT_VERIFY_FAILED`、`INTENT_WINDOW_CLOSED_EARLY` |
| `switch_tab` | `title` | Safari `com.apple.Safari`、Chrome `com.google.Chrome`、Edge `com.microsoft.edgemac` | 点击标签元素（role 为 `tab`、`radio button` 等） | 条件：标签可定位且不换窗口 | 标签选中状态或窗口标题变化；读不到则 `delivered_unverified` | `INTENT_TARGET_NOT_FOUND`、`INTENT_VERIFY_FAILED` |
| `select_menu` | `path` | 任意有 AX 菜单栏的 app | 菜单点击不在 v1 录制范围；**首版不产出识别结果**，作为其他动作的执行原语 | 条件：路径标签完全匹配且不改变目标窗口 | 菜单关闭；效果由后续步骤 / `assert` 证明 | `INTENT_TARGET_NOT_FOUND`、`INTENT_UNSUPPORTED_PATH` |
| `copy_paste` | `source`、`destination` | 文本编辑、浏览器表单等可编辑控件 | 点击来源 + ⌘A + ⌘C + 点击目标 + ⌘V | 是 | 目标 `value` 等于来源 `value` | `INTENT_TARGET_NOT_FOUND`、`INTENT_VERIFY_FAILED` |
| `type_into` | `target`、`text` | 任意可编辑控件 | 点击 / 聚焦目标 + ⌘A + 连续输入 | 是 | 目标 `value` 等于 `text` | `INTENT_TARGET_NOT_FOUND`、`INTENT_VERIFY_FAILED`、`INTENT_UNSAFE_TARGET` |

`open_file` 与 `select_menu` 的「不可回放 / 条件」是有意保留的诚实边界，不是遗漏：前者会改变后续步骤的窗口绑定，后者在 v1 录制里没有对应的可覆盖步骤。把它们列进首批清单，是为了让评审看到完整边界，而不是承诺全部落地。

## 1 rename_file

```json
{ "oldName": "a.txt", "newName": "b.txt" }
```

- `oldName` / `newName`：1–255 字符，不含 `/` 与控制字符（Finder 不允许的名称形态）；两者必须不同。
- 识别与参数重建（扩展名、右键、菜单栏、反例）见 [rename_file 纵向设计](semantic-action-rename-file.md)。
- 执行：聚焦目标窗口 → 按 `oldName` 定位内容区行 → 选中 → Return → 等待内联输入框 → ⌘A → 输入 `newName` → Return → 验证。
- 不使用坐标兜底：点错一行会改错文件，宁可直接失败。
- 失败码补充：扩展名改变触发系统确认框时为 `INTENT_BLOCKED_BY_DIALOG`，不自动点「使用 .txt」。

## 2 open_file

```json
{ "name": "report.pdf" }
```

- `name`：1–255 字符，Finder 中显示的名称。
- 识别：行元素上的双击（`click` + `count: 2`），或目标窗口内的单步 ⌘O。**首版不产出建议**：识别得出来但回放不了，给出建议只会诱导用户确认一个必然失败的意图。
- **首版不回放**。打开文件会把前台切到另一个 app，打开文件夹会换 Finder 窗口标题；v1 流程只绑定一个精确标题的目标窗口，后续步骤没有合法的落点。回放会返回 `INTENT_UNSUPPORTED_ACTION`，用户在运行确认里只能选择原始步骤或删除意图。
- 多窗口目标切换进入 S5 单独设计；在此之前不承诺。

## 3 save_file

```json
{}
```

- 无参数；作用于 `flow.target.window`。
- 识别：目标窗口内单步 `key` = `s` + `meta`。
- 执行：`press meta+s --window-id`。若 1.5 s 内出现标题含「另存为 / Save As」的对话框，按 `INTENT_BLOCKED_BY_DIALOG` 失败，不自动选择路径。
- 验证：只确认发送成功且没有另存为对话框；文件是否落盘由流程内 `assert`（标题、内容、窗口清单）证明。报告 `delivery: "delivered_unverified"`，不标 `delivered_verified`。
- 失败码：`INTENT_STEP_FAILED`、`INTENT_TARGET_NOT_FOUND`、`INTENT_BLOCKED_BY_DIALOG`。

## 4 close_window

```json
{ "window": "Untitled" }
```

- `window`：必须等于 `flow.target.window`；首版不支持关闭其他窗口。
- 识别：目标窗口内单步 `key` = `w` + `meta`，或点击标题栏关闭按钮。
- 执行：先聚焦目标窗口，再 `press meta+w --window-id`；不点红绿灯坐标（窗口可能被遮挡）。
- 验证：`list-windows` 中不再存在该标题；仍存在则 `INTENT_VERIFY_FAILED`。
- 规划期：覆盖步骤之后仍有任何 UI 动作时拒绝（`INTENT_WINDOW_CLOSED_EARLY`）。后续只允许针对其他窗口的 `assert` / `setup`。
- 失败码：`INTENT_VERIFY_FAILED`、`INTENT_WINDOW_CLOSED_EARLY`、`INTENT_TARGET_NOT_FOUND`。

## 5 switch_tab

```json
{ "title": "Inbox" }
```

- `title`：标签显示名，精确匹配；不支持「下一个标签」这类方向参数，避免依赖浏览器内部顺序。
- 识别：点击 `role` 为 `tab` / `radio button` 的元素（具体角色按浏览器实现），且 `name` 非空；目标窗口标题前后可不同。
- 执行：重新抓树，按 `title` 找唯一标签并 `click`；找不到或有多个命中时 `INTENT_TARGET_NOT_FOUND`。
- 验证：标签的选中状态可读时比对；不可读时看窗口标题是否变化，仍不可读则 `delivered_unverified`。不为了「验证通过」去截图比对像素。
- 仅对总表列出的浏览器作为「已覆盖」；其他 app 遇到标签角色时按 `INTENT_UNSUPPORTED_PATH` 处理。

## 6 select_menu

```json
{ "path": ["文件", "存储"] }
```

- `path`：1–4 级菜单标签，逐级精确匹配；不做本地化翻译、不做模糊匹配。
- **首版不产出识别结果**：v1 录制器不记录菜单窗口与菜单栏的点击，无法满足「语义动作必须能展开回原始步骤」。本动作先作为 `rename_file` 右键 / 菜单栏适配器的执行原语存在。
- 执行：通过 AX 菜单栏逐级 `AXPress`；任一级找不到即失败，不按坐标点菜单。
- 验证：菜单关闭；菜单项的实际效果由后续步骤或 `assert` 证明。会打开新窗口的菜单项（如「新建窗口」）按 `INTENT_UNSUPPORTED_PATH` 拒绝，避免破坏目标窗口绑定。
- 失败码：`INTENT_TARGET_NOT_FOUND`、`INTENT_UNSUPPORTED_PATH`。

## 7 copy_paste

```json
{
  "source": { "role": "textfield", "name": "From" },
  "destination": { "role": "textfield", "name": "To" }
}
```

- `source` / `destination`：元素引用，字段同现有元素定位器的 `role`、`name`、`path`、`index`（不含 `kind`）。
- 识别：点击来源 → ⌘A → ⌘C → 点击目标 → ⌘V，五步连续；来源与目标都是可编辑、非安全控件。
- 执行：定位来源 → 点击 → ⌘A → ⌘C → 定位目标 → 点击 → ⌘V。剪贴板内容不进入参数、argv 或报告；只存在于系统剪贴板。来源 `value` 为空时按 `INTENT_STEP_FAILED` 停止，不把一个空复制当成成功。
- 验证：读取目标 `value`，必须等于来源 `value`；读取不到即失败。
- 安全：任一控件带安全标记时 `INTENT_UNSAFE_TARGET`，不读取、不复制。
- 失败码：`INTENT_TARGET_NOT_FOUND`、`INTENT_VERIFY_FAILED`、`INTENT_UNSAFE_TARGET`。

## 8 type_into

```json
{
  "target": { "role": "textfield", "name": "Subject" },
  "text": "Weekly report"
}
```

- `target`：元素引用；`text`：1–4000 字符，可含 Unicode，不含 NUL。
- 识别：点击目标 → 可选 ⌘A → 连续 `type`，步骤连续且目标为可编辑、非安全控件。
- 执行：定位并点击目标 → ⌘A（默认开启，替换原有内容）→ 取当次 ref 后 `type <ref> --stdin`。文本走 stdin，不进入 argv 或日志。
- 验证：目标 `value` 等于 `text`。若控件只暴露 `text` 不暴露 `value`，读取 `text` 比对；两者都不可读则失败。
- 失败码：`INTENT_TARGET_NOT_FOUND`、`INTENT_VERIFY_FAILED`、`INTENT_UNSAFE_TARGET`。

## 通用失败码

| 阶段 | 失败码 | 含义 |
| --- | --- | --- |
| 规划 | `INTENT_COVERS_INVALID` | 覆盖步骤为空、重复、不连续、被多个意图共享或类型不允许 |
| 规划 | `INTENT_OVERLAP` | 两个意图共享步骤 |
| 规划 | `INTENT_PARAMS_INVALID` | 参数不符合动作定义，或退化参数（如新旧名相同） |
| 规划 | `INTENT_STALE` | 步骤被编辑后覆盖关系失效 |
| 规划 | `INTENT_UNCONFIRMED` | `require` 模式下存在未决（`proposed`）或失效意图 |
| 规划 | `INTENT_UNSUPPORTED_ACTION` | 动作在首版没有可执行适配器（如 `open_file`） |
| 规划 | `INTENT_WINDOW_CLOSED_EARLY` | 关闭窗口后仍有 UI 动作 |
| 执行前 | `INTENT_TARGET_NOT_FOUND` | 窗口、行、标签、控件或菜单项找不到，未送达输入 |
| 执行前 | `INTENT_UNSUPPORTED_PATH` | 适配器路径不可用（版本、语言、窗口形态不支持），未送达输入 |
| 执行中 | `INTENT_STEP_FAILED` | 底层驱动命令失败 |
| 执行中 | `INTENT_DELIVERY_UNCERTAIN` | 已尝试送达但无法确认结果 |
| 执行中 | `INTENT_BLOCKED_BY_DIALOG` | 出现系统 / 应用确认框，不能自动代点 |
| 执行后 | `INTENT_VERIFY_FAILED` | 结果验证不成立或读不到 |
| 报告 | `INTENT_REPLACED` | 原始步骤被语义动作替代，未逐步执行 |
| 报告 | `INTENT_FALLBACK_RAW` | 执行前失败后按原始步骤重跑（警告，不覆盖真实结果） |

## 识别期原因（不是错误）

这些只用于界面解释「为什么没有建议」，不写入报告：

| 原因 | 含义 |
| --- | --- |
| `INTENT_NO_PATTERN` | 没有规则命中 |
| `INTENT_AMBIGUOUS` | 多条规则并列，整组不产出 |
| `INTENT_EVIDENCE_MISSING` | 需要菜单证据但旁车缺失或版本不认识 |
| `INTENT_UNSUPPORTED_APP` | app 不在该动作支持列表 |
