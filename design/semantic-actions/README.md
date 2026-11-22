# 语义动作设计附件（HAOC-99）

设计稿，未实现。主文档：[docs/semantic-actions.md](../../docs/semantic-actions.md)。

## 文件

| 文件 | 内容 |
| --- | --- |
| `contracts.schema.json` | `flow.intents`、`report.intents` 与菜单旁车的 Draft-07 定义。所有对象封闭，`params` 按 `action` 精确约束。 |
| `schema-diff.json` | 对 `schemas/flow.schema.json` 与 `schemas/report.schema.json` 的 RFC 6902 补丁。只新增顶层 `intents`，不改 `steps` / `entries`。 |
| `fixtures/*.json` | 离线识别 fixture：输入 flow（可选菜单旁车），预期识别结果或规划错误。 |

补丁用 `$ref` 指向本目录的 `contracts.schema.json`，与 `design/assertions/schema-diff.json` 的评审方式一致。实现阶段由 `src/contracts.ts` 内联生成，`$ref` 不会进入发布的 `schemas/`。

## fixture 格式

```json
{
  "fixture": "rename-return-no-extension",
  "description": "Finder 列表视图：选中无扩展名条目 → Return → 输入 → Return",
  "flow": { "version": 1, "id": "…", "name": "…", "target": { "app": "com.apple.finder", "window": "Downloads" }, "steps": [] },
  "observations": null,
  "expect": {
    "intents": [
      {
        "action": "rename_file",
        "covers": ["step-1", "step-2", "step-3", "step-4"],
        "params": { "oldName": "draft", "newName": "final" },
        "state": "proposed",
        "confidence": "high",
        "rule": "finder.rename.return"
      }
    ]
  }
}
```

- `observations` 为 `null` 或 `{ "version": 1, "observations": [...] }`，对应与 flow 同目录的 `*.observations.json`（flow 文件名去掉 `.json` 后加 `.observations.json`）。
- `expect.intents` 为空数组时，用 `reason` 说明是「没有规则命中」还是「缺证据」等识别期原因。
- `expect.error` 表示规划期应拒绝，例如 `INTENT_STALE`。
- 除 `intent-stale.json` 外，fixture 的 flow 必须能通过当前 v1 schema。
- fixture 的 `expect.intents` 是识别器输出（`state: "proposed"`），不是 flow 内容；录制器不写 `intents`，只有工作台保存用户确认 / 拒绝的决定后才写入 flow。
- `expect.intents` 用识别输出的精简形状（不含 `id` / `fallback`）；写回 flow 时由实现补 `id`，并保留用户选择的状态。
- `intent-stale.json` 故意带尚未实现的 `intents` 字段，作为规划联检的输入：当前 v1 会因未知字段拒绝整个文件，实现后应先通过 schema，再在 `plan()` 里报 `INTENT_STALE`。

实现 S1 时把每个 fixture 转成 `test/intents.test.mjs` 的真实断言：断言产出的动作、参数、置信度、覆盖步骤与错误码，不新增只打印结果的脚手架。

## fixture 清单

| 文件 | 场景 | 预期 |
| --- | --- | --- |
| `rename-return-no-extension.json` | 无扩展名 Return 路径 | `high`，`draft → final` |
| `rename-return-extension-typed.json` | 用户输入完整新名 | `high`，`a.txt → b.txt` |
| `rename-return-extension-inferred.json` | 只输入基名 | `medium`，`a.txt → b.txt` |
| `rename-return-cancelled.json` | 输入后 Escape | 无建议 |
| `rename-wrong-app.json` | TextEdit 中的相似手势 | 无建议，`INTENT_UNSUPPORTED_APP` |
| `rename-point-click.json` | 坐标点击 | 无建议 |
| `rename-context-menu-observed.json` | 右键 + 菜单旁车 | `high`，覆盖 3 步 |
| `rename-context-menu-unobserved.json` | 右键但无旁车 | 无建议，`INTENT_EVIDENCE_MISSING` |
| `rename-menu-bar-observed.json` | 菜单栏旁车 | `high`，覆盖 3 步 |
| `intent-stale.json` | 已确认意图指向缺失步骤 | `INTENT_STALE` |

这些 fixture 同时是评审用的行为样例：任何规则改动都必须说明哪些 fixture 的预期发生变化，不能只改实现不改预期。

## 不在本轮

- 不生成 `schemas/*.schema.json`。
- 不新增 `src/`、`test/` 或 `workbench/` 文件。
- 不启动 GUI、不录制、不碰权限。
