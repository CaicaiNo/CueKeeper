# 一致性检测产物（设计提案，未实现）

本目录只放 [录制/回放一致性审计](../../docs/fidelity.md) 的配套样例，不是已发布契约；`schemas/` 与 `src/` 均未引用这些文件。

| 文件 | 作用 |
| --- | --- |
| `fidelity-sidecar.sample.json` | 录制时生成的旁车样例：每个动作的 locator、身份签名、窗口相对几何、稳定性判定 |
| `flow-doctor.sample.json` | `cuekeeper flow doctor` 的建议输出：逐条 `fail` / `warn` / `ok` 与差异原因 |
| `report-fidelity.schema.json` | 报告旁车 `report.fidelity.json` 的 JSON Schema 草案；等 report v2 再考虑并入正式 schema |

## 约定

- 旁车不写入 flow；用 `flowSha256` 绑定原 flow，避免 flow 被修改后仍拿旧旁车比较。
- 几何只保存窗口相对坐标与矩形，不保存跨机无意义的绝对屏幕坐标。
- 文本目标只记录 `initialValueLength` 或摘要，不记录用户输入内容。
- `stability` 只有 `stable` / `fragile` / `unstable` 三档；`reasons` 用大写常量，便于稳定比较（示例：`POINT_LOCATOR`、`TYPE_BATCH_SEMANTICS`、`NO_POST_ASSERT`）。
- 这些字段名目前只是提案，实现前需要按 `src/contracts.ts` 的 typebox 风格复核。
