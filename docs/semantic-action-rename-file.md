# rename_file 纵向设计（Finder）

HAOC-99 · 设计稿 · 未实现

本文件把 [语义动作层设计](semantic-actions.md) 的模型落到第一个可评审的纵向切片：识别 Finder 的重命名录制、在工作台确认、按语义动作回放、验证结果。首版只承诺 macOS Finder 的 **Return 路径**；右键菜单与菜单栏路径依赖菜单证据，排在 S4。

## 1 范围与前提

- 目标 app：`com.apple.finder`，bundle ID 精确匹配。
- 目标窗口：`flow.target.window` 指定的 Finder 浏览窗口；搜索窗口、智能文件夹、另存为面板不算。
- 视图：列表、图标、分栏三种视图都要在真机覆盖；识别规则不写死视图，只依赖 role / path / name。
- 首版动作：`rename_file(oldName, newName)`。
- 前提：辅助功能权限已授予；录制器与回放共用同一权限。真机运行必须按项目纪律先获批时间窗。

## 2 原始录制事实

v1 录制器只采集目标窗口内的输入，这决定了哪些路径可识别：

| 用户操作 | 是否进入 `flow.steps` | 说明 |
| --- | --- | --- |
| 单击文件行 | 是，`click` + 元素定位器 | 行角色与名称来自 AX 树 |
| 按 Return | 是，`key: "return"` | 无修饰键 |
| 内联输入新名 | 是，`type` + 文本框定位器 | 文本在 `type.text` |
| 再次按 Return 提交 | 是，`key: "return"` | 提交重命名 |
| 右键菜单里的「重命名」 | **否** | 菜单是独立窗口，点击落在目标窗口外被跳过 |
| 菜单栏「文件 > 重命名」 | **否** | 菜单栏同样不在目标窗口内 |
| 慢速双击文件名 | 是，两次 `click` | 没有直接证据区分「选中后再点」与「重命名」，首版不识别 |

因此：

- Return 路径 **只靠 `flow.steps` 就能识别**，不需要额外证据。
- 右键 / 菜单栏路径必须依赖 `*.observations.json` 旁车（§4）；旁车缺失就不产出，不猜。
- 菜单点击不是原始步骤，所以语义动作只覆盖「选中行 / 输入 / 提交」这些真实步骤，不会凭空多出一步。

## 3 Return 路径（S1）

### 3.1 步骤形态

连续四步，中间不允许插入任何步骤：

| 序号 | 步骤 | 匹配条件 |
| --- | --- | --- |
| S1 | `click` | `count` 缺省或 1、`button` 缺省或 `left`；目标是元素；`role` ∈ `row`、`cell`、`outline row`、`list item`、`image`、`static text`；`name` 非空。`path` 可选：存在时必须包含 `outline`、`list` 或 `browser` 之一；缺失时置信度降为 `medium`。 |
| S2 | `key` | `key: "return"`，无 `modifiers`。 |
| S3 | `type` | 目标是元素；`role` ∈ `textfield`、`textbox`、`combobox`；`text` 非空。S1 有 `path` 时，S3 的 `path` 以 S1 的 `path` + S1 的 `role` 为前缀（内联输入框在行内）；S1 无 `path` 时，只要求 S3 的 `name` 等于 `oldName` 或其基名。 |
| S4 | `key` | `key: "return"`，无 `modifiers`。 |

- S1 的 `count` 必须是 1：双击是打开，不是重命名。
- S2 与 S3、S3 与 S4 必须相邻；S1 与 S2 之间也不允许有滚动、悬停、额外点击。
- S1 是 `point` 定位器时不产出：无法证明点中的是文件行。
- S2 或 S4 带 `escape`、`meta`、`shift` 等一律不产出；Escape 表示用户取消了重命名。
- F2 是 Windows 的快捷键；macOS Finder 不把 F2 当重命名，首版不识别。`key` 契约本身允许 `f1`–`f12`，留给未来的 Windows 适配器。
- 目标窗口标题包含「搜索 / Search」时不产出（搜索结果也可以重命名，但名称可能来自其他目录，首版不承诺）。

### 3.2 参数重建

- `oldName` = S1 的目标 `name`。
- `typed` = S3 的 `text`。
- 判断 Finder 选中的是基名还是全名：看 S3 目标元素的 `name`。
  - 等于 `oldName` → 全名被选中，`newName = typed`。
  - 等于 `oldName` 去掉最后一个扩展名后的基名 → 只选中基名，按 §3.3 补扩展名。
  - 为空、不可用或等于其它值 → 无法判断，按默认（扩展名隐藏）补扩展名，置信度降为 `medium`。
- `newName` 必须与 `oldName` 不同；相同则不产出（用户没有改名）。
- 文件名比较保持大小写与 Unicode 原样；大小写改名（`a.txt` → `A.txt`）是有效意图，验证时按显示字符串严格比较。

### 3.3 扩展名重建

Finder 的「显示所有文件扩展名」设置决定内联框预选基名还是全名。识别用下面的确定性规则，并在界面上明示推断：

| `oldName` | S3 目标 `name` | `typed` | `newName` | 置信度 | 理由 |
| --- | --- | --- | --- | --- | --- |
| `a.txt` | `a` | `b` | `b.txt` | `medium` | 只选中基名，扩展名由原名保留 |
| `a.txt` | `a.txt` | `b` | `b` | `high` | 全名被选中，输入即全名 |
| `a.txt` | 空 | `b` | `b.txt` | `medium` | 无法判断，按 macOS 默认（扩展名隐藏） |
| `a.txt` | `a` | `b.txt` | `b.txt` | `high` | 用户显式输入了扩展名 |
| `draft` | `draft` | `final` | `final` | `high` | 原名没有扩展名 |
| `notes.tar.gz` | `notes.tar` | `backup` | `backup.tar.gz` | `medium` | 只替换最后一段扩展名前的基名 |
| `.env` | `.env` | `prod` | `prod` | `high` | 点开头不算扩展名 |

- 「扩展名」定义为最后一个 `.` 之后、长度 1–16 的后缀，且 `.` 不在第 0 位。
- 重建后的 `newName` 必须通过 `fileName` 校验（不含 `/`、控制字符，≤255 字符）；否则不产出。
- 执行时**总是输入完整的 `newName`**（含扩展名），因此无论 Finder 当前设置如何，输入框最终值都是意图参数；若 Finder 因扩展名变化弹出确认框，按失败处理（§6.3）。

### 3.4 置信度

| 置信度 | 条件 |
| --- | --- |
| `high` | 四步齐全；S1 有 `path` 且命中内容区；扩展名语义由 S3 名称明确判定，或原名无扩展名；`newName ≠ oldName`。 |
| `medium` | 四步齐全，但满足任一：S1 缺 `path`；S3 目标名不可用；扩展名按默认推断；路径前缀只能部分匹配。 |
| 不产出 | 任一步缺失 / 不连续 / 类型不符；app 不是 Finder；纯坐标；Escape；新旧名相同；名称空；多条规则并列。 |

`low` 不展示、不落盘。识别没有命中是正常结果。

### 3.5 反例（必须不产出）

- 对话框里按 Return（默认按钮）：S1 是按钮而非内容区行。
- 在搜索框里输入：S3 目标在工具栏，不在行内。
- 选中文件后按 ⌘↓ 打开：没有 Return + 内联输入。
- 双击打开：S1 的 `count` 是 2。
- 按住 Option 拖拽复制后改名：拖拽不是 `click`，且步骤不连续。
- 重命名到一半按 Escape：S4 是 Escape。
- 连续重命名两个文件：两组四步互不重叠，分别产出；若中间插入额外点击、滚动或边界不清，则整段不产出。
- 文本编辑 app 里选中一行按 Return 再输入：app 不是 Finder。

## 4 右键与菜单栏路径（S4）

### 4.1 菜单证据

```json
{
  "version": 1,
  "observations": [
    {
      "kind": "menu",
      "app": "com.apple.finder",
      "source": "context-menu",
      "afterStep": "step-1",
      "beforeStep": "step-3",
      "items": ["重命名"]
    }
  ]
}
```

- `items` 是实际被激活的菜单路径，从 AX 菜单项读取；只记录路径，不记录整棵菜单、坐标或截图。
- `afterStep` / `beforeStep` 把证据钉在相邻的原始步骤之间；两端必须存在且顺序正确，否则证据无效。
- 旁车缺失、版本不认识或菜单路径不在已知集合内 → `INTENT_EVIDENCE_MISSING`，不产出。

### 4.2 右键路径

| 序号 | 证据 / 步骤 | 条件 |
| --- | --- | --- |
| S1 | `click` | `button: "right"`，元素目标是内容区行，`name` 非空。 |
| O1 | 菜单观察 | `source: "context-menu"`，`items` 恰好一项，属于 §4.4 的「重命名」集合，`afterStep = S1`、`beforeStep = S3`。 |
| S3 | `type` | 同 §3.1 S3。 |
| S4 | `key` | 同 §3.1 S4。 |

覆盖步骤为 S1、S3、S4（右键菜单点击本身不是步骤）。`oldName` 取自 S1。置信度 `high`；扩展名按 §3.3 降级时 `medium`。

### 4.3 菜单栏路径

| 序号 | 证据 / 步骤 | 条件 |
| --- | --- | --- |
| S1 | `click` | 左键选中内容区行；可缺省（若录制前已选中），缺省时置信度 `medium`。 |
| O1 | 菜单观察 | `source: "menu-bar"`，`items` 为二级路径，例如 `["文件", "重命名"]`；`afterStep` = S1（或 S3 前一步）、`beforeStep` = S3。 |
| S3 | `type` | 同 §3.1 S3。 |
| S4 | `key` | 同 §3.1 S4。 |

菜单栏路径必须完整命中已知标签；只认识一级菜单、或菜单项被系统置灰，都不产出。

### 4.4 标签集合

只接受下表中的精确字符串，不做大小写折叠之外的处理，不做翻译、拼音或模糊匹配：

| 语言 | 重命名 | 文件菜单 |
| --- | --- | --- |
| zh-Hans | `重命名` | `文件` |
| zh-Hant | `重新命名` | `檔案` |
| en | `Rename` | `File` |
| ja | `名称変更` | `ファイル` |
| ko | `이름 변경` | `파일` |
| fr | `Renommer` | `Fichier` |
| de | `Umbenennen` | `Ablage` |
| es | `Renombrar` | `Archivo` |
| it | `Rinomina` | `File` |
| pt | `Renomear` | `Arquivo` |
| ru | `Переименовать` | `Файл` |

表外的语言直接不产出；用户在参数里手动填写的菜单路径不经过这张表（`select_menu` 的输入由用户负责）。

## 5 工作台

- 卡片：「建议 · 重命名文件「a.txt」→「b.txt」」；`medium` 时追加「需确认：扩展名由原名推断」。
- 展开：列出 4 个原始步骤（点击行、Return、输入、Return），与普通步骤同样可编辑。
- 编辑参数：旧名只读（来自步骤），新名可编辑；保存前校验文件名与「新旧名不同」，保存即确认。编辑过的新名与原始 `type` 文本不同时，该意图的「失败时改用原始步骤」被禁用，并提示「原始步骤会得到不同的名称」。
- 拒绝：写 `rejected`，原始步骤保持可回放；「已拒绝的简化」里可以恢复为建议。
- 失效：覆盖步骤被删除 / 改类型 / 插入新步骤 / 调整顺序 → 卡片显示「底层步骤已修改，需重新识别」，不参与运行。
- 重新识别：只扫描未被覆盖的连续步骤；已确认 / 已拒绝的意图不重复建议。
- 运行确认：「将执行 1 个语义动作（重命名 a.txt → b.txt），替代 4 个原始步骤」；勾选「按原始步骤执行」可临时关闭。若用户给意图勾了「失败时改用原始步骤」，确认页必须再次显示。

## 6 执行

### 6.1 适配器路线

1. **预检**：确认 Finder 在运行、目标窗口标题唯一命中、内容区能定位到恰好一个名为 `oldName` 的行（role / path 同 §3.1）。零命中或多命中直接 `INTENT_TARGET_NOT_FOUND`，此时尚未送达任何输入，允许按 `fallback: "raw"` 回退。
2. **进入重命名**：点击该行选中 → 发送 `press return --window-id`。
3. **等待内联框**：每 100 ms 抓一次树，最多 1500 ms，找 S1 行内的可编辑控件。找不到：发送 Escape，返回 `INTENT_UNSUPPORTED_PATH`。**此时不 fallback**，因为 Return 已经送达，可能已经打开文件或进入其他模式。
4. **写入新名**：聚焦内联框，取当次 ref → ⌘A → `type <ref> --stdin newName`。
5. **提交**：发送 `press return --window-id`。
6. **验证**：重新抓树，断言同一内容区存在 `newName` 且不存在 `oldName`。读不到名称即 `INTENT_VERIFY_FAILED`。
7. **对话框**：任一步后出现新的 sheet / 对话框窗口（AX role 为 `sheet` / `dialog`），或标题含「已存在 / 替换 / 扩展名 / Replace / Extension」，立即停止，`INTENT_BLOCKED_BY_DIALOG`；不自动点「使用 .txt」或「替换」，把对话框留给操作者。检测以窗口结构为主，标题关键词只作补充，避免依赖某一种语言。

右键 / 菜单栏路径在步骤 2 改用右键或 AX 菜单 `AXPress`；其余相同。`rename_file` **禁止坐标兜底**：点错行的代价是改错文件，宁可直接失败。

### 6.2 回退边界

| 阶段 | 可回退原始步骤？ |
| --- | --- |
| 预检失败（窗口 / 行找不到） | 仅当 `fallback: "raw"`，且从未点击或按键 |
| 点击选中后、Return 前失败 | 否（已送达点击；点击本身只改变选择，但为保持规则简单，统一不回退） |
| Return 之后 | 否，永不回退 |
| 验证失败 | 否，永不重试 |

### 6.3 结果验证

- 成功条件：同一 Finder 窗口内容区中 `newName` 存在且 `oldName` 不存在。
- 名称比较区分大小写；大小写改名通过。
- 图标 / 分栏视图若 AX 树不暴露文件行名称，验证读不到 → 失败，不退化成截图或文件名以外的判断。
- 不读取磁盘路径作为验证：流程绑定的是窗口，不是某个绝对路径；同名文件在不同目录都能满足「窗口里出现新名」。需要落盘证明时由流程内 `assert` 负责。

## 7 失败码

| 码 | 阶段 | 处理 |
| --- | --- | --- |
| `INTENT_TARGET_NOT_FOUND` | 预检 | 未送达；可按 `fallback: "raw"` |
| `INTENT_UNSUPPORTED_PATH` | 进入重命名后 | 已按 Escape 取消；停止，不回退 |
| `INTENT_BLOCKED_BY_DIALOG` | 执行中 | 停止，不代点；后续步骤 `skipped` |
| `INTENT_STEP_FAILED` | 执行中 | 底层驱动失败；停止 |
| `INTENT_DELIVERY_UNCERTAIN` | 执行中 | 结果不明；停止，不重试 |
| `INTENT_VERIFY_FAILED` | 执行后 | 停止，不回退 |
| `INTENT_REPLACED` | 报告 | 被覆盖的原始步骤状态 |
| `INTENT_FALLBACK_RAW` | 报告 | 预检失败后按原始步骤重跑 |

## 8 离线 fixture

fixture 放在 `design/semantic-actions/fixtures/`，每个文件自带 flow、可选旁车与预期结果；格式见该目录的 `README.md`。

| 文件 | 场景 | 预期 |
| --- | --- | --- |
| `rename-return-no-extension.json` | 无扩展名，Return 路径 | 1 条 `high` 建议，`draft → final` |
| `rename-return-extension-typed.json` | 原名有扩展名，用户输入全名 | 1 条 `high`，`a.txt → b.txt` |
| `rename-return-extension-inferred.json` | 原名有扩展名，只输入基名 | 1 条 `medium`，`a.txt → b.txt` |
| `rename-return-cancelled.json` | 输入后按 Escape | 0 条 |
| `rename-wrong-app.json` | 同一手势发生在 TextEdit | 0 条，`INTENT_UNSUPPORTED_APP` |
| `rename-point-click.json` | 点击是坐标定位器 | 0 条 |
| `rename-context-menu-observed.json` | 右键 + 菜单证据 | 1 条 `high`，覆盖右键、输入、Return |
| `rename-context-menu-unobserved.json` | 右键但无旁车 | 0 条，`INTENT_EVIDENCE_MISSING` |
| `rename-menu-bar-observed.json` | 菜单栏证据 + 输入 + Return | 1 条 `high` 或 `medium`（已选中行时 high） |
| `intent-stale.json` | 已确认意图指向不存在的步骤 | 规划错误 `INTENT_STALE`；原始步骤仍完整 |

S1 实施时，这些 fixture 转成 `test/intents.test.mjs` 的真实断言：输入 flow + 旁车，断言产出的意图、参数、置信度、`covers` 与错误码；不新增只打印结果的脚手架。

## 9 真机验证清单

必须在获批时间窗内执行，结束后停止所有进程；不新增常驻服务、LaunchAgent 或定时任务。

### 9.1 准备

- 新建可丢弃目录 `~/Desktop/cuekeeper-rename-fixture`，放入：`alpha.txt`、`noext`、`中文名.txt`、`.hidden`、`one.two.txt`、`duplicate.txt`、`same-case.txt`，以及一个只读子目录。每个用例开始前还原目录，避免前一个用例改名后影响下一个。
- 用 Finder 打开该目录，窗口标题固定；记录 macOS 版本、Finder 版本、系统语言、Finder「显示所有文件扩展名」设置。
- 权限沿用已授予的辅助功能 / 输入监控；本轮不重新编译 ad-hoc 程序，避免触发新的授权弹框。

### 9.2 用例

| # | 操作 | 预期识别 | 预期回放 / 验证 |
| --- | --- | --- | --- |
| 1 | 列表视图，单击 `alpha.txt` → Return → 输入 `beta` → Return | `medium`，`alpha.txt → beta.txt`（默认扩展名隐藏） | 文件显示名变 `beta.txt` |
| 2 | 同上，输入 `beta.txt` | `high`，`alpha.txt → beta.txt` | 文件显示名变 `beta.txt` |
| 3 | 打开「显示所有扩展名」后重复 #1 | `high`，`alpha.txt → beta`（全名被选中） | 文件显示名变 `beta` |
| 4 | `noext` → Return → `final` → Return | `high`，`noext → final` | 成功 |
| 5 | `中文名.txt` → Return → `新名字` → Return | `medium`，`中文名.txt → 新名字.txt` | 成功，Unicode 原样 |
| 6 | `one.two.txt` → Return → `backup` → Return | `medium`，`one.two.txt → backup.txt` | 成功 |
| 7 | 输入到一半按 Escape | 0 条 | 原始步骤仍可回放；不产生意图 |
| 8 | 改成已存在的 `duplicate.txt` | 建议存在 | 回放触发「已存在」对话框 → `INTENT_BLOCKED_BY_DIALOG`，不代点 |
| 9 | 图标视图重复 #1 | 与列表一致 | 验证可读；不可读则 `INTENT_VERIFY_FAILED` |
| 10 | 分栏视图重复 #1 | 与列表一致 | 同上 |
| 11 | 右键 `alpha.txt` → 菜单「重命名」→ 输入 → Return（S4） | 有旁车时 `high`；无旁车 0 条 | 成功 |
| 12 | 菜单栏「文件 > 重命名」→ 输入 → Return（S4） | 有旁车时 `high` 或 `medium` | 成功 |
| 13 | 大小写改名 `same-case.txt → Same-case.txt` | `high` | 通过，验证区分大小写 |
| 14 | 在搜索结果窗口重命名 | 0 条 | 不产出 |
| 15 | 重命名后 ⌘Z 撤销，再跑语义回放 | 预检找不到 `oldName` | `INTENT_TARGET_NOT_FOUND`；勾选 fallback 时按原始步骤执行 |

### 9.3 每次记录

- 录制的 flow 步骤数、意图条数与置信度、确认 / 拒绝结果。
- 回放报告：`intents[].status`、`code`、被覆盖条目的 `INTENT_REPLACED`、验证结果。
- AX 树中内联输入框的 role / name / value 实际值（决定 §3.2 的判断是否成立）。
- 失败时的对话框标题与截图（只作人工证据，不进 flow）。

## 10 待确认

1. Finder 列表 / 图标 / 分栏视图里，文件行的实际 role 与内联输入框的 `name` / `value` 是否稳定；若 `name` 为空，扩展名判断只能走 `medium`。
2. Return 是否在所有 Finder 键盘偏好下都进入重命名；若存在「Return 打开」的设置，预检需要在进入前读取该设置或在真机上直接验证。
3. 中文 / 日文标签在目标 macOS 版本上的实际 AX 标题是否与 §4.4 一致。
4. 扩展名变化时的系统对话框标题与按钮集合，用于稳定地识别 `INTENT_BLOCKED_BY_DIALOG`。
5. `report pack` 是否需要为 `intents` 增加查看器区块（实现阶段确认，不改打包顺序校验）。
