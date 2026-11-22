# 语义动作层设计（HAOC-99）

设计稿 · 本轮只出设计与动作清单，不写实现 · 首版目标 macOS / flow v1

语义动作把一段原始录制识别成一个带稳定参数的内置动作，例如把 Finder 里的「选中文件 → Return → 输入新名 → Return」识别为 `rename_file(oldName, newName)`。它是一层**可展开的高层视图**，不是新的真相源。

## 结论

- 原始步骤 `flow.steps` 保持不变，仍是唯一真相源；语义动作放在新增的顶层 `flow.intents` 数组里，用 `covers` 指向被它概括的原始步骤 ID。
- 不新增 `kind: "intent"` 的步骤。理由见 §1.1。
- 识别只产出 `state: "proposed"` 的内存建议。录制器不写 `intents`；只有用户在时间线上确认或拒绝、并在工作台保存后，才把 `confirmed` / `rejected` 写入 flow。只有 `confirmed` 参与回放。
- 回放模式 `off` / `prefer` / `require`，默认 `prefer`：执行已确认的意图，替代其覆盖的原始步骤。`off` 永远按原始步骤执行。
- 回退到原始步骤只在**尚未送达任何输入**、且该意图显式声明 `fallback: "raw"` 时发生，并写入报告。已送达后不回退，避免重复副作用。
- 首批 8 个动作见 [语义动作清单](semantic-action-catalog.md)。第一个纵向切片固定为 Finder `rename_file`，见 [rename_file 纵向设计](semantic-action-rename-file.md)。
- 不做 LLM 猜意图、不做任意自然语言动作、不静默折叠、不承诺覆盖所有 app。

## 1 两层模型

### 1.1 存放位置与关系

| 层 | 位置 | 写入者 | 回放角色 | 真相源 |
| --- | --- | --- | --- | --- |
| 原始步骤 | `flow.steps` | 录制器、工作台编辑 | 默认执行；语义模式中未被覆盖的步骤照常执行 | **是** |
| 语义动作 | `flow.intents` | 识别器在工作台内存中给建议；用户确认 / 拒绝后，保存时写入 `confirmed` / `rejected` | 仅 `confirmed`，按模式替代 `covers` 覆盖的步骤 | 否，派生视图 |

```json
{
  "version": 1,
  "id": "flow-1",
  "name": "Downloads",
  "target": { "app": "com.apple.finder", "window": "Downloads" },
  "steps": [
    { "id": "step-1", "kind": "click", "target": { "kind": "element", "role": "row", "name": "a.txt", "path": ["window", "outline"] } },
    { "id": "step-2", "kind": "key", "key": "return" },
    { "id": "step-3", "kind": "type", "target": { "kind": "element", "role": "textfield", "name": "a", "path": ["window", "outline", "row"] }, "text": "b" },
    { "id": "step-4", "kind": "key", "key": "return" }
  ],
  "intents": [
    {
      "id": "intent-1",
      "action": "rename_file",
      "covers": ["step-1", "step-2", "step-3", "step-4"],
      "params": { "oldName": "a.txt", "newName": "b.txt" },
      "state": "confirmed",
      "confidence": "medium",
      "rule": "finder.rename.return"
    }
  ]
}
```

为什么不用 `kind: "intent"` 步骤：

- 原始步骤会被移进意图对象或复制一份，`flow.steps` 不再是录制的直线顺序，旧运行器、`plan()`、报告顺序校验都要改语义。
- 独立数组可以整组校验「覆盖的步骤存在、顺序连续、互不重叠、不包含行为调用 / 断言 / Shell」，并且旧 flow 缺省该字段时完全等价于旧行为。
- 展开仍然成立：`covers` 指向的 ID 就是原始步骤，时间线按 ID 展开即可，不需要第二份数据。
- 结论：采用顶层 `intents`；`kind: "intent"` 仅作为被否决的备选记录在评审里。

录制器不写这个字段：`record` 产出的 flow 与旧版逐字节一致，旧版 CueKeeper 仍可读取、回放。语义建议只存在于工作台内存；用户点「确认」或「拒绝」并保存后，才写入 `confirmed` / `rejected`。因此「识别」本身不会改变用户录制的文件，只有显式决定会。

### 1.2 保存哪个

确认后两个都存，打包在同一个 `flow.json` 里。语义动作是可选字段，缺少它不影响任何旧流程。菜单证据放在可选的旁车文件（见 §3.4），不是回放必需物；丢掉旁车只会让依赖菜单的识别退化为「不产出建议」，不会让已确认的意图失效。

### 1.3 回放执行哪个

`run` 新增 `--intent-mode off|prefer|require`，工作台运行确认里给同样的三选一：

| 模式 | 行为 |
| --- | --- |
| `off` | 完全按 `flow.steps` 执行；`intents` 只用于展示。 |
| `prefer`（默认） | 已确认且未失效的意图替代其 `covers`；`proposed` / `rejected` 忽略，原始步骤照常执行。 |
| `require` | 任何未决（`proposed`）、已失效或没有可用适配器的意图都在启动前阻塞（`INTENT_UNCONFIRMED` / `INTENT_STALE` / `INTENT_UNSUPPORTED_ACTION`）。`rejected` 是明确决定，不阻塞。用于 CI 固定语义路径。 |

规划期先把意图展开成一个执行节点，位置取其第一个覆盖步骤的位置；其余未覆盖步骤保持原顺序。报告里的原始条目顺序不变，因此 `report pack` 的顺序校验不需要改写。

### 1.4 失败与回退

| 失败位置 | 是否回退原始步骤 | 结果 |
| --- | --- | --- |
| 规划期：`covers` 不存在、不连续、重叠、包含不可覆盖步骤、参数非法 | 否，不启动 | CLI 退出码 2，报告为空；工作台标出失效意图，用户修正或删除。 |
| 执行前：目标窗口 / 条目 / 控件不存在，适配器路径不支持，未送达任何输入 | 仅当该意图 `fallback: "raw"` 时为是 | 先记 `INTENT_TARGET_NOT_FOUND` / `INTENT_UNSUPPORTED_PATH`，再按原始步骤从该意图的第一个覆盖步骤重跑；报告写 `fallback.to = "raw"`。 |
| 已送达任何输入后失败 | **否** | `INTENT_STEP_FAILED` 或 `INTENT_DELIVERY_UNCERTAIN`，后续步骤 `skipped`。 |
| 执行后结果验证失败 | **否** | `INTENT_VERIFY_FAILED`；不重试，不回退，避免重复改名 / 重复删除。 |
| 按原始步骤执行失败 | 无 | 沿用现有错误码与停止规则。 |

`fallback` 默认 `"none"`，必须在确认意图时由用户勾选「失败时改用原始步骤」才会写入。`require` 模式永不回退。任何参数被用户编辑过（例如把推断的 `newName` 改成另一个名字），该意图的 `fallback` 强制为 `"none"`：原始步骤重放的是录制时的输入，不可能复现编辑后的参数。

## 2 首批动作清单

完整参数、适用 app、执行路线、验证方式与失败码见 [语义动作清单](semantic-action-catalog.md)。

| 动作 | 参数 | 首版可回放 |
| --- | --- | --- |
| `rename_file` | `oldName`、`newName` | 是（Finder 回车路径；右键 / 菜单栏路径需要菜单证据） |
| `open_file` | `name` | 否（会切换目标窗口，超出 v1 单窗口绑定） |
| `save_file` | 无 | 是（发送 ⌘S；落盘结果需流程内断言） |
| `close_window` | `window` | 是（必须是流程最后一个 UI 动作） |
| `switch_tab` | `title` | 条件（浏览器标签可定位时） |
| `select_menu` | `path` | 条件（菜单路径完全匹配且不改变目标窗口；首版不产出识别结果） |
| `copy_paste` | `source`、`destination` | 是（⌘A / ⌘C / ⌘V，验证目标值） |
| `type_into` | `target`、`text` | 是（聚焦、⌘A、输入，验证值） |

`open_file` 与 `select_menu` 首版不产出识别建议：前者回放会切换目标窗口，后者在 v1 录制里没有可覆盖的步骤。它们保留在契约与清单里，是为了让后续阶段（S4 / S5）直接接上，而不是现在承诺可用。

## 3 识别规则

### 3.1 流水线

1. **证据**：原始步骤的 `kind` / 目标 `role`、`name`、`path`、`index`、按键与文本；可选的菜单观察（§3.4）。识别只读这些确定性字段，不读像素、不读坐标。
2. **规则匹配**：每个动作有独立、稳定的规则 ID（写入 `rule`）。规则只产出候选，不改写任何步骤；规则行为变化必须同时更新 fixture 的预期。
3. **冲突消解**：同一组步骤被多个规则命中时取覆盖更长者；仍然并列则整组不产出，界面记「多条规则冲突」。任何两条建议不得共享步骤。
4. **置信度**：只产出 `high` / `medium`。`low` 一律不展示、不写入；「没有建议」是正常结果，不是错误。
5. **落盘**：录制器不写 `intents`；工作台导入时按同一规则重新识别，只补齐未被 `confirmed` / `rejected` 覆盖的连续步骤，不触碰用户已有决定。

### 3.2 通用门槛

- 应用用 `flow.target.app` 的 bundle ID 精确匹配（例如 `com.apple.finder`），不按显示名。
- 只接受元素定位器；纯坐标 `point` 的点击、拖拽不参与识别。
- 覆盖的步骤必须连续、同属目标窗口，且只能是 `click`、`key`、`type`、`paste` 四种输入步骤；`assert` / `wait` / `setup` / `shell` / `behavior` 不能被覆盖。
- 识别不做推测性补全：缺一步就不产出，不用「大概中间点了菜单」补齐。

### 3.3 纵向样例

`rename_file` 的三条路径（Return、右键菜单、菜单栏）、中英文标签、置信度矩阵、反例与扩展名重建规则，见 [rename_file 纵向设计](semantic-action-rename-file.md)。

### 3.4 菜单证据

v1 录制器只采集目标窗口内的输入，菜单窗口与菜单栏的点击不会被记成步骤。依赖菜单的路径（右键「重命名」、菜单栏「文件 > 重命名」、`select_menu`）因此需要额外的只读证据：

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

- 旁车文件名固定为把 flow 文件名去掉 `.json` 后加 `.observations.json`，与 flow 同目录；例如 `foo.flow.json` → `foo.observations.json`。旁车不进入 flow、不影响 `flowSha256`。
- 只记录**实际被激活的菜单路径**（从 AX 菜单项读取），不记录整棵菜单、坐标或截图。
- 旁车缺失或版本不认识时，依赖菜单的规则直接不产出（`INTENT_EVIDENCE_MISSING`），不降级成猜测。
- 旁车由录制器原生侧在菜单关闭时发出；这是后续实现阶段的工作，不属于本轮。

## 4 工作台交互

时间线保持原始步骤可见，意图只是加在步骤组上的一张卡片。

| 元素 | 内容与行为 |
| --- | --- |
| 卡片标题 | 「可简化为：重命名文件「a.txt」→「b.txt」」；`proposed` 前缀「建议」 |
| 置信度 | `high` 显示「高置信」；`medium` 显示「需确认」并可展开理由（如「扩展名由原名推断」）。 |
| `rule` | 悬停显示规则 ID 与命中依据，便于排查误识别。 |
| 操作 | 「确认」「编辑参数」「拒绝」「展开底层步骤」。 |
| 展开 | 在卡片下列出 `covers` 的原始步骤，样式与普通步骤一致，可继续编辑。 |
| 编辑参数 | 按动作给字段（如旧名 / 新名）；保存前做 schema 与动作联检；保存即视为确认。编辑过的意图不再允许 `fallback: "raw"`，因为原始步骤无法复现改后的参数。 |
| 拒绝 | 写 `state: "rejected"`，卡片移入「已拒绝的简化」；可「恢复为建议」。 |
| 失效 | 覆盖的步骤被删除、改类型、插入打断或改变顺序 → 卡片显示「底层步骤已修改，需重新识别」；不回放。 |
| 重新识别 | 只对未覆盖的连续步骤产出新建议，不触碰已确认 / 已拒绝的意图。 |

- 录制产物进入工作台后，建议以折叠卡片出现（底层步骤收起）、不自动确认；用户必须点一次「确认」才会写 `confirmed`。
- 运行确认页显示「将执行 3 个语义动作，替代 9 个原始步骤」，并提供「按原始步骤执行」开关；开关状态只影响本次运行，不写回 flow。
- 卡片不隐藏原始步骤；即使确认，也始终显示「4 个原始步骤」并可展开。
- 编辑原始步骤后，工作台重新计算 `covers` 连续性；失效意图不参与运行，但保留在文件里供用户处理。

## 5 执行

### 5.1 适配器顺序

每个动作有独立适配器，按固定优先级尝试：

1. **AX 元素 / 菜单**：重新抓树、按 role/name/path 定位，调用驱动的元素动作或菜单动作。
2. **快捷键**：目标窗口已聚焦时发送组合键（`press`），不依赖鼠标位置。
3. **坐标**：语义动作一律不使用坐标兜底。原始步骤仍按既有规则运行（无 `appPath` 且显式 `--headed`）；`rename_file` 无论哪种模式都不允许坐标。

每次执行前重新抓树并重新定位，不复用录制时的 ref；执行不自动重试。送达状态沿用现有 `delivery` 字段。

### 5.2 结果验证

| 动作 | 验证 |
| --- | --- |
| `rename_file` | 同一窗口内容区出现 `newName` 且不再出现 `oldName`；读不到名称即失败。 |
| `open_file` | 新窗口标题（首版不回放，仅记录预期）。 |
| `save_file` | 只确认 ⌘S 已送达且没有出现「另存为」对话框；是否落盘由后续 `assert` 证明，报告用 `delivered_unverified`。 |
| `close_window` | `list-windows` 中该窗口标题消失。 |
| `switch_tab` | 目标标签的选中状态或窗口标题变化；读不到时 `delivered_unverified`，不伪造通过。 |
| `select_menu` | 菜单关闭；效果由后续步骤 / `assert` 证明。 |
| `copy_paste` | 目标元素 `value` 等于来源 `value`。 |
| `type_into` | 目标元素 `value` 等于 `text`。 |

验证失败一律 `INTENT_VERIFY_FAILED`，停止后续步骤，不回退、不重试。验证读取不到（AX 树缺属性、控件不可读）也按失败处理，不按「无法验证所以通过」。

## 6 契约

### 6.1 flow v1 加法

- 新增可选顶层 `intents`，最多 200 条；不改变 `version: 1`、`steps`、`behaviors` 的任何语义。完整定义见 [contracts.schema.json](../design/semantic-actions/contracts.schema.json)，JSON Patch 见 [schema-diff.json](../design/semantic-actions/schema-diff.json)。
- 每条意图是封闭对象：`id`、`action`、`covers`、`params`、`state`、`confidence`、`rule`、可选 `fallback`。`params` 按 `action` 精确封闭。
- 旧 flow 没有 `intents` 时按空数组处理，可原样读取、回放、计算摘要；无需迁移，也不改变旧流程的 `flowSha256`。旧版 CueKeeper 会因 `additionalProperties: false` 拒绝含 `intents` 的新文件，这与断言 / Shell 扩展的既有约定一致。由于录制器不写 `intents`，未确认的录制仍可被旧版读取；只有用户显式确认 / 拒绝并保存后，文件才需要新版解析。
- 意图只覆盖**顶层** `flow.steps`，不覆盖 behavior 内部步骤或 `kind: "behavior"` 调用。行为复用的语义不在本轮范围。

### 6.2 联检规则

| 规则 | 失败码 |
| --- | --- |
| `id` 在 flow 内唯一；`covers` 非空、无重复 | `INTENT_COVERS_INVALID` |
| `covers` 引用的步骤已不存在，或顺序已被编辑破坏 | `INTENT_STALE` |
| `covers` 在 `flow.steps` 中不连续，或与其他意图重叠（不论 `state`） | `INTENT_OVERLAP` / `INTENT_COVERS_INVALID` |
| 覆盖步骤类型只能是 `click` / `key` / `type` / `paste` | `INTENT_COVERS_INVALID` |
| `params` 符合动作定义；`rename_file` 的 `oldName ≠ newName` 且 `oldName` 等于覆盖步骤中点击 / 右键行的名称；`close_window.window` 等于 `target.window` | `INTENT_PARAMS_INVALID` / `INTENT_STALE` |
| 动作有可用适配器，且运行平台支持 | `INTENT_UNSUPPORTED_ACTION` |
| `require` 模式下存在未决（`proposed`）或失效意图 | `INTENT_UNCONFIRMED` / `INTENT_STALE` |
| `close_window` 覆盖的步骤之后仍有 UI 动作 | `INTENT_WINDOW_CLOSED_EARLY` |
| `covers` 因步骤编辑而不再连续或指向不存在步骤（运行期计算） | `INTENT_STALE` |

### 6.3 报告

报告新增可选顶层 `intents`，`entries` 的形状与顺序不变：

```json
{
  "version": 1,
  "flowId": "flow-1",
  "flowSha256": "…",
  "mode": "replay",
  "status": "failed",
  "entries": [
    { "id": "step-1", "kind": "click", "status": "skipped", "code": "INTENT_REPLACED", "atMs": 0, "durationMs": 0 },
    { "id": "step-2", "kind": "key", "status": "skipped", "code": "INTENT_REPLACED", "atMs": 0, "durationMs": 0 },
    { "id": "step-3", "kind": "type", "status": "skipped", "code": "INTENT_REPLACED", "atMs": 0, "durationMs": 0 },
    { "id": "step-4", "kind": "key", "status": "skipped", "code": "INTENT_REPLACED", "atMs": 0, "durationMs": 0 }
  ],
  "intents": [
    {
      "id": "intent-1",
      "action": "rename_file",
      "covers": ["step-1", "step-2", "step-3", "step-4"],
      "execution": "intent",
      "status": "failed",
      "code": "INTENT_VERIFY_FAILED",
      "atMs": 0,
      "durationMs": 812
    }
  ]
}
```

- 意图执行时，被覆盖的原始条目标 `skipped` + `INTENT_REPLACED`，不伪造逐步结果；意图条目记录真实结果、耗时、`delivery` 与可选 `fallback`。
- 失败回退到原始步骤时，意图条目的 `execution` 为 `"raw"`、`fallback.reason` 记录原因；原始条目按真实执行结果填写。
- 报告不额外复制 `params`：`flow.json` 已经包含意图参数；查看器从 flow 读取，避免报告里出现第二份文件名 / 文本。
- `report pack` 既有「报告条目与流程顺序一致」的校验不变：意图覆盖的步骤仍逐条存在，只是状态为 `skipped`。
- dry-run 只做意图联检，不执行适配器，也不写 `intents`：原始步骤照常记为 `resolved`；`require` 模式仍在启动前检查未决 / 失效意图。

## 7 风险与 fail closed

| 风险 | 处理 |
| --- | --- |
| 同一手势不同含义（Finder 的 Return 是重命名，对话框的 Return 是默认按钮） | 规则要求 Finder 内容区行（或右键菜单路径）+ 内联输入 + 提交齐全，且执行前重新定位；任一条件不满足不产出。 |
| 菜单本地化 | 只接受确定性标签集合（§ rename 文档）；未知语言 / 标签不产出，不用模糊匹配或翻译猜测。 |
| app 版本差异 | 适配器记录实测过的 Finder / 浏览器版本范围；超出范围返回 `INTENT_UNSUPPORTED_PATH`，不尝试「应该也能用」。 |
| 误识别 | 只产出建议，必须人工确认；`medium` 明示需确认；冲突时整组不产出；拒绝会持久化。 |
| 回放环境不同（文件名、排序、窗口标题） | 执行前按参数重新定位；找不到就失败；`fallback: "raw"` 才走原始步骤；已送达后不回退。 |
| 扩展名显示设置导致重命名结果不同 | 用内联输入框的名称判断选中的是基名还是全名；无法判断时降为 `medium`，并在执行后按 `newName` 严格校验。 |
| AX 树不可读 / 属性缺失 | 验证失败，不按通过处理；不使用像素或坐标兜底。 |
| 重复副作用 | 语义模式跳过被覆盖步骤；规划期保证意图互不重叠；已送达后禁止回退。 |
| 敏感信息 | 文件名与输入文本已存在于 flow；报告不新增副本；`report pack` 对 `paste` 的既有拒绝规则不变。 |
| 目标窗口变化（`open_file`、部分菜单项） | 首版 `open_file` 不回放；`close_window` 必须是最后一步；其余动作按 `INTENT_WINDOW_CLOSED_EARLY` 拒绝。 |

## 8 不做

- 不用 LLM 或自然语言模型猜意图。
- 不做任意自然语言动作，不把一句话编译成步骤。
- 不静默折叠、不静默改写用户录制；所有语义动作都必须显式确认。
- 不承诺覆盖所有 app、所有视图、所有语言；只承诺列出的动作在列出的应用与版本范围内可用。
- 不把坐标识别成语义动作，不用像素比对替代 AX 验证。
- 不在本轮修改 `src/`、`schemas/` 或 `workbench/`。

## 9 实施拆分

| 阶段 | 内容 | 可独立验收 |
| --- | --- | --- |
| S1 契约与纯识别 | `src/contracts.ts` 加 intent / report intent；`src/intents.ts` 实现 `rename_file` 的 Return 路径识别与联检；离线 fixture 全绿。 | 是（不碰界面、不回放） |
| S2 确认与回放 | 工作台卡片、确认 / 编辑 / 拒绝 / 展开；`--intent-mode`；Finder 适配器；报告与查看器。 | 是（纵向切片端到端） |
| S3 键盘类动作 | `save_file`、`close_window`、`type_into`、`copy_paste`；复用 S1 的识别与 S2 的执行框架。 | 每个动作单独验收 |
| S4 菜单证据 | 原生录制器发送菜单观察；右键与菜单栏重命名；`select_menu` 识别。 | 是（依赖 S1/S2） |
| S5 浏览器与多窗口 | `switch_tab` 的浏览器适配；`open_file` 需要多窗口目标切换，另行设计，不阻塞前四个阶段。 | 独立设计 |

S1/S2 不得改动既有 flow 语义；每个阶段先合契约与离线用例，再合界面与适配器。真机验证统一走 HAOC-76 / HAOC-87 的获批时间窗。

## 10 验收与证据

- 首批动作表：[semantic-action-catalog.md](semantic-action-catalog.md)。
- `rename_file` 纵向设计（识别、参数、执行、验证、反例、真机清单）：[semantic-action-rename-file.md](semantic-action-rename-file.md)。
- 离线 fixture 与预期结果：[design/semantic-actions/fixtures](../design/semantic-actions/fixtures)，说明见 [design/semantic-actions/README.md](../design/semantic-actions/README.md)。
- 契约：[contracts.schema.json](../design/semantic-actions/contracts.schema.json)、[schema-diff.json](../design/semantic-actions/schema-diff.json)。

本轮验收只看三件事：

1. 设计可评审，且明确「原始步骤仍可展开、可回放」。
2. 8 个动作的参数、适用 app、是否可回放、验证方式、失败码齐全。
3. `rename_file` 有完整纵向设计，并给出离线 fixture 与真机验证清单。
