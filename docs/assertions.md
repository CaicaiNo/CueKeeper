# M2 断言扩展设计

HAOC-68 定义流程、结果和工作台的契约，供 HAOC-70 实现。断言仍是一条 `kind: "assert"` 步骤。每次执行只检查一次，失败沿用现有回放行为，停止执行后续主步骤。

## 流程契约

保留 `version: 1` 和 `check.target` / `check.expect`。新增字段只出现在 `assert`，覆盖主流程步骤、内嵌 behavior 和独立 behavior。旧 flow 和 behavior 可以原样读取、回放、计算摘要。旧运行器会在 schema 校验阶段拒绝使用扩展字段的流程。

| `check.target.kind` | 可断言属性 | `check.expect` |
| --- | --- | --- |
| `element` | `exists`、`visible` | 布尔型 `equals` |
| `element` | `text`、`value` | 字符串 `equals`、`contains` 或 `matches` |
| `window` | `exists` | 布尔型 `equals` |
| `window` | `title` | 字符串 `equals`、`contains` 或 `matches` |
| `window` | `screenshot` | `region`、`baseline` 和 `maxDiffRatio` |

元素用原有定位器，在绑定的 `flow.target` 窗口内解析。`exists`、`visible` 的判定不变；没有 `normalize` 的字符串 `equals` 继续精确比较。无匹配元素时，只有 `exists` 获得布尔观测值 `false`。保留不完整 AX 树、歧义和属性不可读的现有错误。`wait`、`setup`（包括 repair）继续使用原契约。

```json
{
  "target": { "kind": "element", "role": "textfield", "name": "Status" },
  "expect": {
    "property": "text",
    "contains": "saved successfully",
    "normalize": { "ignoreCase": true, "whitespace": "collapse" }
  }
}
```

### 字符串匹配

- 三个操作字段恰好填一个。`equals` 允许空字符串，`contains` 要求非空且归一化后仍非空。`matches` 接收非空 ECMAScript Unicode 正则源字符串（上限 256 字符），进行搜索式匹配。要匹配全串可写 `^…$`。
- `normalize.ignoreCase` 默认为 `false`，`normalize.whitespace` 省略时保留原样。`trim` 去掉首尾 ECMAScript 空白，`collapse` 先把连续 `\s` 替换为一个 ASCII 空格，再去掉首尾空白。
- 对 `equals` 和 `contains`，对实际值和期望文本都先处理空白，再按需调用 `toLowerCase()`。对 `matches`，只对实际值处理空白，正则用 `u`，勾选忽略大小写时用 `iu`。正则源保持原样。
- 流程校验与工作台保存时预检正则语法和归一化后的子串。运行期在可超时终止的隔离执行单元里运行正则。每条断言的窗口选择与属性判定共用 500 ms 的正则执行预算，耗尽时报告 `ASSERTION_MATCH_TIMEOUT`。

### 窗口的定位和检查

`target.app` 必填，使用驱动支持的应用标识。适配层必须先确认应用归属，再用只读窗口清单筛选。`target.window` 可省略，此时检查该应用的窗口清单。填写时用 `target.match` 指定标题筛选方式，省略 `match` 时为区分大小写的 `equals`。筛选支持 `contains` 和 ECMAScript Unicode `matches`，保留标题原文。窗口检查有自己的目标，因而也能检查回放中打开的第二个窗口，同时保留原动作窗口的绑定。适配器复用 `agent-desktop v1.3.1` 的 `list-windows` 观察接口。 [窗口清单协议](https://raw.githubusercontent.com/vercel-labs/agent-desktop/v1.3.1/skills/agent-desktop/references/commands-system.md#L55)

| 已确认的匹配窗口数 | `exists` 的实际值 | `title` 与 `screenshot` |
| --- | --- | --- |
| 0（包括确认应用未运行） | `false` | `WINDOW_NOT_FOUND` |
| 1 | `true` | 读取该窗口的标题或按窗口 ID 截图 |
| 2 或更多 | `AMBIGUOUS_TARGET` | `AMBIGUOUS_TARGET` |

`title` 读取所选窗口的原始标题，可与空字符串比较。权限错误、读取超时、未知标题导致无法确认匹配集合等情况按观测失败处理。`exists: false` 需要已确认的空匹配集合。检查标题时，可按应用内唯一窗口定位，或用标题中稳定的一段定位，再比较完整标题。下例验证新文档窗口的完整标题。

```json
{
  "target": { "kind": "window", "app": "TextEdit", "window": "CueKeeper", "match": "contains" },
  "expect": { "property": "title", "equals": "CueKeeper Test.txt" }
}
```

### 区域截图

`expect.region` 是 `{ x, y, width, height }`。原点是按窗口 ID 获取的原始截图左上角，单位是原图像素。确认唯一窗口后调用驱动的 `screenshot --app … --window-id … <临时文件>`。驱动按窗口 ID 选窗并返回截图尺寸。整个断言使用只读观察，窗口消失或不可捕获时报告错误。 [截图命令源码](https://raw.githubusercontent.com/vercel-labs/agent-desktop/v1.3.1/crates/core/src/commands/screenshot.rs)

- `baseline` 存 `sha256` 与原始窗口图的 `frameWidth` / `frameHeight`。PNG 文件本身只包含裁剪区域，解码尺寸必须等于 `region.width` 和 `region.height`。先检查矩形边界及基线，再抓取实际窗口图。实际图原始尺寸必须与基线时一致。窗口位置变化不影响坐标，尺寸不同时报告尺寸错误。
- 窗口原图宽高各至多 8192，最多 33,554,432 像素。裁剪区域最多 16,777,216 像素。检查 PNG 头的格式、尺寸和像素总数后才解码。截图超过上限时按捕获失败处理。原图尺寸已知且与基线不符时可以在解码前报告尺寸错误。
- 比较前将 PNG 解码为 sRGB、8 位非预乘 RGBA，全透明像素的 RGB 统一为 0。任一通道有差异就计作一个不同像素。`diffRatio = differentPixels / (width * height)`，小于或等于 `maxDiffRatio` 即通过，判定前不舍入。工作台默认阈值为 0，可输入 0–100% 并换算为 JSON 的 0–1。对比只使用固定坐标的像素。

```json
{
  "target": { "kind": "window", "app": "TextEdit", "window": "CueKeeper Test.txt" },
  "expect": {
    "property": "screenshot",
    "region": { "x": 40, "y": 80, "width": 320, "height": 160 },
    "baseline": {
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "frameWidth": 1280,
      "frameHeight": 960
    },
    "maxDiffRatio": 0.01
  }
}
```

示例摘要是占位值，保存基线时填入文件计算所得的摘要。

### 配置校验与 dry-run

结构错误沿用 schema 校验。需要联检的规则在规划时校验，包括正则语法、归一化后子串、基线原图面积和矩形边界。保存或运行截图断言时读取对应基线文件验证内容。坏基线在运行时写入断言失败条目。dry-run 保留 `resolved` 的含义，仅检查配置、作用域及可用的基线，实际像素比对和属性判定留给 replay。窗口存在性在清单可用且结果无歧义时即为已解析，零匹配也可解析。窗口标题和截图在清单中需要唯一窗口。旧单窗口快照只覆盖 `flow.target` 已知的窗口。遇到需要应用级窗口清单的断言时，提示该夹具不覆盖，使用 `WINDOW_MISMATCH`。单测用可注入的桌面驱动提供完整应用窗口清单和 PNG 样本。

## 基线与工作台

- 沿用时间线的「添加断言」。选择「元素」「窗口」「区域截图」。元素沿用拾取器。窗口和截图预填当前行的应用与标题，可修改应用、填写标题筛选方式或留空。窗口属性显示「存在」「标题」，文本类属性显示「精确」「包含」「正则」及归一化选项。切换类型后只提交当前类型对应的字段。
- 区域截图提供「设为基线」和「更新基线」。选择已保存的完整目标窗口 PNG，在原图预览中圈选区域，确认窗口、原图尺寸、裁剪预览和阈值后保存。该入口可离线使用。修改区域时重新确认基线。更新只改变当前断言的引用，已保存的流程可继续使用其历史基线。
- 将裁剪图保存为流程或测试项 JSON 所在目录下的 `baselines/<sha256>.png`。由 PNG 文件字节计算 SHA-256。先写入基线文件，再发布引用它的 JSON。已有同名文件先核对内容，可重复使用。拒绝符号链接和内容不匹配的文件。复制流程时带上其引用的 PNG。工作台将截图断言保存为库 behavior 时同步复制所引用的基线到库目录，将它编入测试项时再按摘要复制到测试项目录。生成和更新基线都由用户在预览后确认。

## 报告与错误码

在 `kind: "assert"` 的条目上增加可选字段 `assertion`。新 runner 对实际尝试执行的断言写入 `expected`（原始 `check.expect`）和可用的 `actual`。布尔值保留布尔类型。字符串为归一化前的观测值。敏感属性及包含本次注入 secret 的实际字符串省略，`message` 说明原因并避免回显。未执行、仅解析或无法取得观测值时，viewer 显示相应状态。`false` 或 `""` 是有效观测。

| 情形 | 错误码 | `assertion.actual` |
| --- | --- | --- |
| 元素布尔值、文本、值、窗口存在性或标题不匹配 | `ASSERTION_FALSE` | 实际布尔值或原始字符串 |
| 正则无效或归一化后子串为空 | `ASSERTION_INVALID_MATCH` | 规划阶段的配置错误，指出步骤 ID 和字段 |
| 正则超时 | `ASSERTION_MATCH_TIMEOUT` | 属性匹配超时可保留已读字符串，选择窗口超时省略 |
| 窗口无匹配、歧义、属性不可读或观测失败 | `WINDOW_NOT_FOUND`、`AMBIGUOUS_TARGET`、`PROPERTY_UNAVAILABLE` 或现有驱动错误码 | 无可用观测时省略 |
| 矩形超出基线原图或配置超过像素数上限 | `ASSERTION_REGION_INVALID` | 规划阶段的配置错误，指出步骤 ID |
| 基线文件缺失 | `ASSERTION_BASELINE_MISSING` | 省略 |
| 基线不可读、摘要错误、格式或裁剪尺寸不符 | `ASSERTION_BASELINE_INVALID` | 省略 |
| 捕获时窗口消失或无法确认原窗口 | `WINDOW_CHANGED` | 省略 |
| 截图权限不足、命令超时、无有效 PNG 或截图过大 | `PERM_DENIED`、`COMMAND_TIMEOUT` 或 `ASSERTION_CAPTURE_FAILED` | 省略 |
| 实际窗口图尺寸不同 | `ASSERTION_SCREENSHOT_SIZE` | `frameWidth`、`frameHeight` |
| 区域像素差超过阈值 | `ASSERTION_SCREENSHOT_DIFF` | `frameWidth`、`frameHeight`、`differentPixels`、`diffRatio` |

截图比较成功时也写入四项观测数值。有持久化报告目标时，对截图失败保存可用的裁剪证据。`assertion.screenshots.baseline` 和 `assertion.screenshots.actual` 分别引用 ZIP 内的 `assets/<展开步骤 ID>/assertion-baseline.png` 和 `assets/<展开步骤 ID>/assertion-actual.png`。每份报告使用独立的证据目录，例如 `run-01.json` 对应 `run-01.json.assets/`，目录下保留展开步骤 ID 和文件名。打包器从该目录合并报告明确引用的证据，继续接收原有 `--assets` 和普通资产。打包时验证 `expected` 与对应流程步骤的 `check.expect` 一致。证据引用须与条目 ID 一致、存在且无路径冲突，基线副本还须匹配摘要。未能保存证据时保留比较结果，在 `message` 提示并省略无法保存的引用。无报告输出路径时可只返回结构化结果。

## Viewer

- 顶部从 `entries` 统计 `kind: "assert"` 的总数和通过数，显示「断言 N 条，M 条通过」。展开后的行为每次调用独立计数。阻塞、跳过和 `resolved` 单独标注，均计入总数。dry-run 标明已解析数量。`wait` 和 `setup` 不计入断言。
- 在现有「只看失败」旁增加「只看失败断言」筛选，匹配 `kind === "assert" && status === "failed"`。两个筛选和「全部」互斥。切换时保留仍可见的选中条目，否则选中第一条可见结果。空时显示「没有失败断言」。旧报告存储的布尔筛选状态继续按原筛选恢复。
- 详情显示期望、实际、定位器和错误码。截图展示阈值与实际差异比例，尺寸不符时展示实际与基线原图尺寸。证据按各自角色显示，可离线打开。旧 v1 报告允许省略 `assertion`，期望从绑定的 flow 渲染，实际显示「报告未记录实际值」，旧 `message` 保留在错误详情中。扩展报告仍为 v1。旧打包器的严格 schema 会拒绝包含 `assertion` 的报告。已经打包的旧 ZIP 使用它自带的 viewer。

## Schema diff 与交付顺序

[Schema diff](../design/assertions/schema-diff.json) 的每个值都是一组针对指定文件的 RFC 6902 操作。应用到副本时，以原 schema 文件路径为基准解析 `$ref`，引用 [草案定义](../design/assertions/contracts.schema.json)。一共替换三处 `assert.check`，报告拆出仅 `assert` 可用的可选 `assertion` 字段。对象形态继续使用 `additionalProperties: false`。HAOC-70 把定义迁入现有 TypeBox 源并通过 `npm run schemas:write` 生成正式 schema。

| 阶段 | 可验收输出 |
| --- | --- |
| HAOC-68 契约评审 | 草案可套用到生成的 schema，旧样本通过，非法字段、属性组合和挂载位置被拒绝 |
| HAOC-70 运行与资产 | 假驱动和 PNG 夹具覆盖所有判定与错误。报告能关联展开步骤和证据 |
| HAOC-70 工作台与交付 | 工作台能保存、更新基线并导出，旧报告和新报告均可查看。通过离线验证后按批准的时间窗做一次真机失败用例 |

## HAOC-70 离线验收

| 用例 | 断言可观察结果 |
| --- | --- |
| 四种旧元素属性 | `exists` 对存在/确认缺失均检查布尔正反例。`visible`、`text`、`value` 分别覆盖通过和不等，区分空字符串与未读到值。旧示例、等待与前置条件结果不变 |
| 字符串比较 | `equals`、`contains`、`matches` 各有通过及失败。大小写、`trim` 和多段空白归一化各测试开关对结果的影响。正则锚点、无效正则、超时和空子串覆盖配置或求值错误。报告保留实际值原文 |
| 窗口存在性 | 唯一/空清单分别验证 `equals: true` 和 `equals: false` 的通过与失败。歧义、权限错误和清单缺失均返回对应错误。查询第二窗口后，后续动作仍绑定原窗口 |
| 窗口标题 | 用无标题筛选及精确、包含、正则筛选定位。标题等于预期时通过，改名时失败且报告有实际标题。覆盖空标题、零命中、同名多窗口和标题不可读 |
| 区域截图 | 2×2 自制 PNG 中，0 差异通过，1/4 差异在 0.25 边界通过且低于边界失败。只修改区域外像素仍通过。覆盖纯 alpha 差异、全透明像素、缺失/坏基线、越界、尺寸变化、窗口消失和权限错误 |
| 报告打包及查看 | 展开的 behavior 步骤带两张证据并可离线打开。引用缺失或串步时拒绝打包。断言统计和筛选覆盖通过、失败、跳过、阻塞、已解析及旧报告。断言失败后续步骤跳过 |
| 工作台与作用域 | UI 切换断言类型后保存出正确字段。基线更新保留旧摘要，行为库与导出后仍能取到正确图。旧 flow/report 通过。误配 target/expect、额外字段、wait/setup 使用扩展字段均校验失败。dry-run 返回 `resolved` 并检查驱动调用记录中无截图和输入指令 |
