# 参数化批量执行设计

HAOC-69 定义数据表、CLI 和汇总契约，供 HAOC-71 实现。一份数据表绑定一个已保存的 flow 或 test item，每行执行该测试项一次。

## 数据表

首版用 UTF-8 JSON（无 BOM）。`rows` 是行对象数组，外层 `version` 表示格式版本，`columns` 明确预期列集合，因此第一行也能检查缺列。CSV 适合表格软件，但需要约定引号、换行、空单元格和编码，表格软件还可能改写前导零。JSON 对字符串、缺键和 `null` 的区分与现有 flow 一致。

```json
{
  "version": 1,
  "columns": ["recipient", "fill-billing.city"],
  "rows": [
    { "recipient": "0012", "fill-billing.city": "上海" },
    { "recipient": "0048", "fill-billing.city": "杭州" }
  ]
}
```

文件上限为 16 MiB，表含 1–64 列、1–1000 行，单元格为非空字符串，沿用 `args` 的 4000 个 UTF-16 代码单元上限。保留大小写、空白、换行和前导零。数字、布尔值、`null`、空字符串、重复 JSON 对象键及额外的顶层字段均报错。JSON Schema 按 Unicode 码点计长，runner 另以现有 `args` 校验执行 UTF-16 上限。 [Data schema 草案（Draft-07）](../design/batch/data.schema.json)

- `recipient` 是现有参数名。在整个测试项中只匹配一个调用参数时使用。匹配范围为行为调用中实际由 `type.text.param` 引用的参数，包含 secret 绑定。多次调用各计一次。`fill-billing.city` 中的前缀是**调用步骤 ID**，后缀是参数名。匹配区分大小写。歧义、未知列以及两列映射到同一调用参数均报错。
- 先按 `columns` 解析绑定，再核对各行对象的键集合，随后校验单元格。缺列报 `DATA_MISSING_COLUMN`，多列报 `DATA_EXTRA_COLUMN`，同一行同时缺列和多列时先报缺列，空对象归为缺列。错误给出行号及符合列名规则的相关列名，避免回显单元格值或非法键的原文。列名冲突、找不到参数、值或结构无效均作为输入错误。schema 负责结构，runner 负责跨字段及与测试项联检。
- 每行基于同一原始测试项绑定，只覆盖所选调用的 `args[param]`，其余参数沿用原值。源测试项须通过现有 `parseTestItem` 和 flow 校验。行绑定后复用 `parseFlow` / `plan`，保留原 flow ID、行为定义、展开步骤 ID 和断言内容。整表完成预检才开始调用桌面驱动或创建报告产物。
- 参数类型按现有 `.test.json` 的 `secrets` 绑定确定。任何指向 secret 的列都报 `DATA_SECRET_COLUMN`，包括填写环境变量名的情况。一次 replay 在预检中通过 `resolveSecrets` 从进程环境解析全部绑定，缺失、空值或超长时报告 `SECRET_UNAVAILABLE` 和涉及的调用参数，退出码 `2`。每行复用这组值，仅在运行时注入。dry-run 校验绑定和数据形状时可省略环境变量值。

## CLI

沿用 `run`，由 `--data <rows.json>` 启用批量模式。现有可接受的 `flow.json` 和 `test.json` 继续作为唯一位置参数。

```sh
cuekeeper run login.test.json --data accounts.json --headed --report out/batch.json --json
cuekeeper run login.test.json --data accounts.json --dry-run --snapshot target.snapshot.json --json
```

| 选项 | 批量行为 |
| --- | --- |
| `--report <batch.json>` | 写入汇总文件及同级的 `<batch.json>.rows/`，为每个完成行保存 v1 报告和对应 flow。父目录须存在，两个目标须为新路径，避免覆盖原有产物。省略时仅输出汇总。 |
| `--dry-run` | 每行解析定位器、断言作用域和基线等现有 dry-run 检查。步骤保留 `resolved`，不执行输入、修复或断言比较。实时 dry-run 读取桌面可访问性树。 |
| `--snapshot <snapshot.json>` | 与 `--dry-run` 同用，各行读取同一份离线夹具，沿用其目标及可覆盖窗口范围。 |
| `--headed` | 只用于 replay，逐行沿用单次运行的权限和输入行为。坐标点击缺少该选项时沿用 `HEADED_REQUIRED`。 |
| `--json` | stdout 只输出一条现有风格的 JSON 对象。有汇总时为 `{ "ok": ..., "data": ... }`，`data` 是汇总对象，`ok` 表示退出码是否为 `0`。预检出错时为 `{ "ok": false, "error": { "code": ..., "message": ... } }`。 |

文本输出列出失败和阻塞的行号、相关步骤 ID、错误码及总数。使用了 `--report` 时同时打印汇总路径。

## 执行顺序与退出码

按 `rows` 的数组顺序串行。每行分别调用 `runFlow`，重新建立窗口绑定、时间线并执行该行的前置条件。行内保留现有语义，动作或断言失败停止该行后续动作，全局前置条件阻塞整行，局部前置条件阻塞所属动作。行级 `failed` 或 `blocked` 均继续下一行。

应用状态在行间延续。每行需要独立初始状态时，可在测试项开头加入清场或复位步骤，再检查该状态。全局前置条件在首步之前检查，需要单独满足或由现有 `ensure` 修复。runner 不自动重试，也不回滚应用副作用。

| 结果 | 汇总 `status` | 退出码 |
| --- | --- | --- |
| 所有行通过或 dry-run 全部解析成功 | `passed` | `0` |
| 任一行失败，含同时出现阻塞的情况 | `failed` | `1` |
| 至少一行的前置条件阻塞，其余行通过或也阻塞 | `blocked` | `1` |
| 输入、前置依赖或文件错误，如 secret 缺失、驱动不可用或报告写入失败 | 已进入批量执行时为 `error`，预检失败仅返回 `error` 对象 | `2` |
| 收到中断信号 | 已进入批量执行时为 `interrupted`，预检期间仅返回 `INTERRUPTED` | `130` |

出现批次级错误或中断立即停止推进。尽力写出部分汇总并保留已经完成的行。如果汇总路径本身不可写，CLI 仍输出已知结果和写入错误。未完成的行不生成虚假的 v1 报告。人工重跑使用新输出路径，并检查中断行是否已影响应用状态。

## 汇总与 v1 兼容

批次汇总对象使用 `format: "cuekeeper-batch-report"`、`version: 1`。`flowId` 与源 flow ID 相同，`mode` 为 `replay` 或 `dry-run`，`startedAt` 沿用单次报告的 UTC 毫秒时间格式。`counts` 含 `total`、`passed`、`failed`、`blocked`、`notCompleted`，后四项之和等于 `total`。`rows` 按输入顺序包含已完成的行，行号 `row` 从 `1` 开始，对应 `rows[row - 1]` 的原始位置，与 JSON 文件的物理行号无关。

每行含 `row`、`status`（`passed`、`failed` 或 `blocked`）、`parameters`（以原列名为键的普通值），以及 `issues`（从失败或阻塞的 v1 条目提取 `{ stepId, code }`，无错误码的条目可省略 `code`）。使用 `--report` 时再加 `report` 和 `flow` 两个相对路径，均相对于汇总所在目录，使用 `/` 分隔。目录名 `row-000001` 来自固定宽度的行号。批次级 `error` 或 `interrupted` 在汇总根对象添加 `error: { code, message, row? }`，错误发生在某一行时附该行号。

```json
{
  "format": "cuekeeper-batch-report",
  "version": 1,
  "flowId": "login",
  "mode": "replay",
  "startedAt": "2026-11-21T14:00:00.000Z",
  "status": "failed",
  "counts": { "total": 2, "passed": 1, "failed": 1, "blocked": 0, "notCompleted": 0 },
  "rows": [
    {
      "row": 1,
      "status": "passed",
      "parameters": { "recipient": "0012", "fill-billing.city": "上海" },
      "issues": [],
      "report": "batch.json.rows/row-000001/report.json",
      "flow": "batch.json.rows/row-000001/flow.json"
    },
    {
      "row": 2,
      "status": "failed",
      "parameters": { "recipient": "0048", "fill-billing.city": "杭州" },
      "issues": [{ "stepId": "check-result", "code": "ASSERTION_FALSE" }],
      "report": "batch.json.rows/row-000002/report.json",
      "flow": "batch.json.rows/row-000002/flow.json"
    }
  ]
}
```

- 单次 `run`、v1 report schema 和 `report pack` 的输入保持原样。每行 `flowSha256` 取该行绑定后的 flow 摘要，`flow.json` 保存的就是该 flow，可把这对文件直接交给现有 `report pack`。截图基线从源测试项旁的 `baselines/` 读取，已保存证据沿用逐行 `report.json.assets/` 约定。汇总文件由 CLI 或脚本读取。
- 使用 `--report` 时先占用新的 `.rows/` 目录。采用同级暂存目录逐行写入 flow、report 和证据，整行写完后发布目录并计入汇总。汇总使用现有原子写入语义，完成或受控终止时发布。已完成的行可独立打包。
- 汇总只记录普通列值、行号、步骤 ID 与错误码，路径不取参数值。逐行 flow 保留环境变量引用，注入的值不会写入 `args`、报告、诊断或打包输入。逐行报告沿用断言字符串实际值的脱敏，并清理诊断中匹配本次注入 secret 的文本。含 secret 绑定的批次仍执行截图断言并记录数值结果，省略截图证据，避免把可见凭据写入图片。普通列值和手写断言期望会保存在本地产物，敏感素材应使用现有 secret 绑定。

## 工作台与实施顺序

首版通过 CLI 读取手写或工具生成的 JSON。工作台沿用已有参数填写及测试项保存能力。HAOC-71 先实现整表预检和行绑定，再接入串行运行、汇总和逐行持久化，通过离线用例后交付。真机回放验收由 HAOC-75 按获批时间窗执行。

## HAOC-71 离线验收

| 场景 | 应断言的结果 |
| --- | --- |
| N 行全通过 | 用假桌面驱动验证实际接收 N 行各自的字符串，顺序与输入一致，逐行重新检查前置条件。`counts.passed = N`、退出 `0`，行级 v1 报告与各自的绑定流程摘要一致，可打包。 |
| 部分失败 | 三行中第二行断言失败，第三行仍实际执行并通过。汇总为 `failed`，计数 `2/1/0`（通过/失败/阻塞），错误定位到第 `2` 行、其普通参数值和断言步骤。退出 `1`。 |
| 缺列 | 第二行缺少声明的普通列。退出 `2`，返回 `DATA_MISSING_COLUMN` 和第 `2` 行及列名。第一行也未执行，驱动调用数为 `0`，没有报告产物。补测多列、歧义列及重复映射也在整批预检时拒绝。 |
| Secret 缺失 | 表有效，replay 缺少 test item 绑定的环境变量。退出 `2`，返回 `SECRET_UNAVAILABLE`，驱动调用数为 `0`，没有报告产物。相同输入使用 `--dry-run --snapshot` 可解析。补齐变量后，用假驱动验证实际注入，并检查 JSON、逐行报告和打包素材没有该值。 |
| 前置条件阻塞 | 第一行全局前置条件阻塞，第二行前置条件满足并实际执行。汇总为 `blocked`，保留阻塞行和相关步骤，退出 `1`。 |
| 中断与文件错误 | 第一行完成后中断第二行（`130`），或模拟写入第二行失败（`2`）。第一行仍可打包，汇总只索引已发布的行，`notCompleted` 包含第二行及后续行。 |
| v1 回归 | 省略 `--data` 时，同一离线夹具仍产出原 v1 报告和 CLI `data`，已有 v1 报告可照常打包。使用 `--data` 时，某行报告可用本行 flow 打包，用绑定值不同的另一行 flow 打包会因摘要不匹配而失败。 |
