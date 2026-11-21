# 报告上传协议 v1

Cuekeeper 将已生成的 `report pack` ZIP 可选上传到自建服务。上传以 [离线报告包](report.md) 为输入，HTTP 路径中的 `/v1` 是上传协议版本。包内的 flow、report 和 manifest 沿用现有 v1 格式。JSON 请求、响应和错误字段见 [`upload.schema.json`](../schemas/upload.schema.json)。

## 客户端与认证

- 未配置服务端时，`report pack` 只写本地 ZIP。显式启用上传并配置 HTTPS 服务地址、`projectId` 和凭据引用后，打包成功即自动入队。打包结果与上传结果分别记录，测试结果由 `report.json` 决定。
- 所有 API 请求都使用 `Authorization: Bearer <token>`。部署只有一个 workspace。workspace token 可访问该 workspace 下的项目，project token 仅可访问绑定的项目。两种 token 都可独立授予 `runs:write`（创建、传块、完成）和 `runs:read`（列表、摘要、下载、查看器）。服务端每次请求都检查 scope、项目归属和撤销状态。跨项目使用 project token 返回 `403`。对有权查看的项目，未知或归属不匹配的运行和上传 ID 返回 `404`。
- 项目与 token 由管理员预置和轮换。客户端从凭据存储或环境注入读取 token，队列只存凭据引用。token、认证头和对象存储凭据均不得进入 ZIP、URL、日志或错误响应。客户端只向配置的 HTTPS 服务发送认证头，且拒绝 API 重定向。

## 上传与校验

下表的路径以 `/api/v1/projects/{projectId}` 开头。`projectId`、`runId`、`uploadId` 使用 schema 中的 `Id` 格式，`index` 按十进制整数解析后使用 `ChunkIndex`。JSON body 使用 `application/json`。`204` 响应和完成请求均无 body。校验头部时，只取对应定义列出的字段，头名与媒体类型转为小写，`Content-Length` 按整数解析。`limit` 也按十进制整数解析。各接口使用表中对应的 schema 定义，字段间约束由服务端执行。[JSON Schema Draft-07](https://json-schema.org/draft-07/draft-handrews-json-schema-validation-01)

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /runs` | `CreateRunHeaders`（`Idempotency-Key`）和 `CreateRunRequest` | `201` 创建运行，`200` 命中已有运行。两者均返回 `CreateRunResponse` |
| `PUT /runs/{runId}/uploads/{uploadId}/chunks/{index}` | `ChunkHeaders` 加 `application/octet-stream` 二进制 | `204`，块已持久写入，含同一块的成功重传 |
| `POST /runs/{runId}/uploads/{uploadId}/complete` | 无 body | `200 RunSummary`，含同一会话已成功完成的重试 |
| `GET /runs` | `ListRunsQuery` | `200 ListRunsResponse` |
| `GET /runs/{runId}` | 无 body | `200 RunSummary` |
| `GET /runs/{runId}/bundle` | 无 body | `200 application/zip`，通过 `Content-Disposition: attachment` 返回原始 ZIP |
| `GET /runs/{runId}/viewer` | 无 body | `200 text/html; charset=utf-8`，返回服务端生成的查看器 |

### 1. 创建运行

客户端先确定最终上传版 ZIP，再以完整 ZIP 字节的 SHA-256 小写十六进制作为 `Idempotency-Key`，并发送 `{"bundleBytes":16777216}`。服务端按 `(projectId, bundleSha256)` 查找已有 Run。已有键声明不同 `bundleBytes` 返回 `409 IDEMPOTENCY_CONFLICT`。为首次请求检查大小上限，超过时返回 `413 PAYLOAD_TOO_LARGE`。通过后在事务中以该键唯一建 Run，初始状态为 `pending`，同时创建上传会话。相同项目内，同一份字节只对应一个 `runId`。不同项目可上传相同 ZIP。对同一报告重新打包后若字节改变，则属于新上传。

- `pending` 返回 `{runId, state, upload}`。`upload` 含 `uploadId`、`chunkBytes`、`committedBytes`、`expiresAt`。活跃会话保持同一 ID。会话过期或已因整包摘要不符而关闭时，重发创建请求可为同一 Run 原子分配新会话，`committedBytes` 从 0 开始。并发创建只分配一个当前会话。
- `ready` 返回 `{runId, state}`，客户端可结束队列项。即便 ZIP 已过期，也返回原 `runId`，不恢复已过期产物。`rejected` 重放已记录的 `413 PAYLOAD_TOO_LARGE` 或 `422 BUNDLE_INVALID`，每次响应有自己的 `requestId`。

### 2. 传输与续传

首版统一使用服务端代理的顺序分块 PUT。`chunkBytes` 固定为 8 MiB（8,388,608 字节），`index` 从 0 开始，表示从 `index × chunkBytes` 开始的一段。最后一块可短于 `chunkBytes`，长度由 `bundleBytes` 推出。请求须带 `Content-Length` 和该段字节的 `X-Chunk-Sha256`，且使用原始字节，不加内容编码。单块 ZIP 只发送一次 PUT。每个项目可配置较低上限，协议硬上限为 1 GiB（1,073,741,824 字节）。

服务端校验块编号、实际长度与摘要，先持久化到独立的暂存键，再在同一事务中确认会话与偏移、记录块并推进 `committedBytes`。服务端只接受连续的下一块。当前会话内，已提交块以同一长度、同一摘要重传时返回 `204`，不同内容返回 `409 CHUNK_CONFLICT`，跳块返回 `409 CHUNK_OUT_OF_ORDER`。客户端在超时、重启或进度冲突后重发创建请求，按服务端给出的 `committedBytes` 续传。传输中断的半块从块首重发。会话默认在创建后 24 小时过期。过期或被替换的会话不能写入新会话，服务端返回 `409 UPLOAD_EXPIRED`。

| 传输方式 | 取舍 |
| --- | --- |
| 单次 `multipart/form-data` | 请求少、易接入。大包超时要从头发送，难以跨进程续传。 |
| 对象存储预签名 URL | 大包直传可减少 API 带宽占用。分块续传还要管理签名、到期续签与完成校验，本地目录也需要单独适配。[S3 预签名 URL 文档](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) |
| 服务端分块 PUT（v1） | 本地目录、S3 和 MinIO 使用相同协议，服务端统一做鉴权、限额和续传。代价是流量经过 API，暂存和合并占用存储空间。 |

### 3. 完成校验

客户端确认所有字节已提交后，调用 `complete`。服务端锁定当前会话的写入，顺序读取块并重算整个 ZIP 的长度和 SHA-256，再校验归档。持有效验证租约的会话即使跨过上传到期时刻也可完成。验证期间的同会话并发完成或传块请求返回 `409 UPLOAD_VERIFYING`。同一已成功完成的 `uploadId` 重调 `complete` 始终返回该 Run 的摘要，产物状态取当前值。之后再传块返回 `409 UPLOAD_FINALIZED`。被终态拒绝的会话重调 `complete` 时，重放已记录的状态和错误码。

1. 块未齐时返回 `409 UPLOAD_INCOMPLETE`，可续传。整包摘要不符时返回 `422 BUNDLE_DIGEST_MISMATCH` 并关闭当次会话，保留 Run 的 `pending` 状态。客户端须核对本地 ZIP 与原始键，再手动重试。
2. 校验 ZIP 路径、文件类型与解压边界，再核对 `manifest.json` v1 中每个文件的实际大小、SHA-256、资产路径和步骤关联。归档文件与清单必须一一对应（清单本身除外），并包含 `report.json`、`flow.json`、`index.html`。逐项校验现有 report、flow schema、`flowId`、`reportStartedAt`、按 `hashFlow` 算出的 `flowSha256`，以及报告动作 ID、类型和顺序与 `plan(flow)` 的一致性。摘要只从经校验的内容派生。
3. 摘要匹配但归档、清单或报告校验失败时，Run 进入 `rejected` 并记录 `422 BUNDLE_INVALID`。归档解压超过限额时记录 `413 PAYLOAD_TOO_LARGE`，同样进入 `rejected`。包需修正并重新计算键才能重新入队。
4. 校验通过后先持久写入最终 ZIP，再以一个事务发布 Run 摘要、Flow 关联和 Artifact 元数据，并标为 `ready`。读接口只公开 `ready`。数据库事务提交前发生故障时，可重试同一次完成。验证所有权必须可在进程崩溃或租约过期后回收，旧持有者失去发布权。临时块和未被数据库引用的对象由清理任务回收，清理须避开活跃会话和验证租约。

## 本地队列与错误

队列持久保存服务地址、项目、凭据引用、ZIP 路径、大小、SHA-256、已知运行/会话 ID、最近错误和下次重试时间。写 ZIP 和队列项时使用原子替换。重启后恢复队列，同一队列项只由一个 worker 处理。ZIP 缺失或内容改变时暂停原任务，待恢复原字节或显式重新入队。配置改动时，已有队列项仍绑定原服务与项目。任何上传失败都保留 ZIP，上传成功后也由本地文件保留规则决定去留。

网络断开、超时、`429`、`5xx` 自动指数退避并带抖动。有 `Retry-After` 则至少等待指定秒数。`UPLOAD_VERIFYING` 等待后重查或重试完成，其余可恢复的 `409` 重发创建请求以对齐进度与状态。超过本地重试预算时暂停，允许手动继续。鉴权、配置、容量或内容问题需要先处理原因。`retryable` 表示可自动继续同一队列项，手动继续也必须保留该项的键。

API 错误使用 `ErrorResponse`，形如 `{"requestId":"req_1","error":{"status":409,"code":"UPLOAD_INCOMPLETE","retryable":true,"message":"Upload is incomplete"}}`。`error.status` 与 HTTP 状态相同，`message` 供人阅读且不得包含敏感内容。`401` 带 `WWW-Authenticate: Bearer`，`429` 和 `UPLOAD_VERIFYING` 带秒数形式的 `Retry-After`。代理或网络层未提供 JSON 时，按 HTTP 状态或连接失败处理。[HTTP 语义](https://www.rfc-editor.org/rfc/rfc9110.html)

| HTTP | `error.code` | `retryable` | 客户端处理 |
| --- | --- | --- | --- |
| 400 | `BAD_REQUEST` | false | 修正请求体、路径、查询参数、请求头或块长度。 |
| 401 | `UNAUTHENTICATED` | false | 更新缺失、无效、过期或被撤销的 token。 |
| 403 | `FORBIDDEN` | false | 修正项目授权或 scope。 |
| 404 | `NOT_FOUND` | false | 检查项目、运行及会话 ID。 |
| 409 | `IDEMPOTENCY_CONFLICT` | false | 检查本地 ZIP 大小及幂等键。 |
| 409 | `CHUNK_CONFLICT` | false | 核对本地 ZIP，避免覆盖服务端已验证的块。 |
| 409 | `CHUNK_OUT_OF_ORDER`, `UPLOAD_INCOMPLETE` | true | 对齐已提交字节并续传。 |
| 409 | `UPLOAD_EXPIRED`, `UPLOAD_FINALIZED` | true | 重发创建请求，取得新会话或确认已完成。 |
| 409 | `UPLOAD_VERIFYING` | true | 等待服务端验证，重新查询进度或调用完成。 |
| 410 | `ARTIFACT_EXPIRED` | false | 提示 ZIP 和查看器已过期，仍可读摘要。 |
| 413 | `PAYLOAD_TOO_LARGE` | false | 减小包或请求体，或由管理员调整部署限额。 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | false | 修正 `Content-Type` 或内容编码。 |
| 422 | `CHUNK_DIGEST_MISMATCH` | false | 检查块内容与摘要，修复后手动续传，会话进度未变。 |
| 422 | `BUNDLE_DIGEST_MISMATCH` | false | 核对原 ZIP 后手动重开会话。 |
| 422 | `BUNDLE_INVALID` | false | 重新生成有效的 ZIP，以新键入队。 |
| 429 | `RATE_LIMITED` | true | 遵循 `Retry-After`。 |
| 5xx | `SERVER_ERROR` | true | 退避后按同一键或会话重试。 |

## 服务端实体与索引

| 实体 | 字段 | 索引与约束 |
| --- | --- | --- |
| Project | `id`、`name`、`createdAt`、`artifactTtlDays`、`maxBundleBytes` | `id` 主键。单 workspace 由部署约束。 |
| Flow | `projectId`、`flowId`、`createdAt` | `(projectId, flowId)` 主键。流程版本以 Run 的 `flowSha256` 区分。 |
| Run | `id`、`projectId`、`bundleSha256`、`bundleBytes`、`state`、`currentUploadId`、`createdAt`、`completedAt`。就绪后存 `flowId`、`flowSha256`、`startedAt`、`mode`、`status`、`durationMs`、`entryCounts`。拒绝时存错误状态和代码。 | `id` 主键，`(projectId, bundleSha256)` 唯一。就绪数据索引 `(projectId, startedAt, id)`、`(projectId, flowId, startedAt, id)` 和 `(projectId, status, startedAt, id)`。 |
| Artifact | `id`、`runId`、`storageKey`、`expiresAt`、`deletedAt` | `id` 主键，`runId` 唯一，按 `expiresAt` 索引清理。大小和摘要复用 Run。 |
| Upload | `id`、`runId`、`state`（`receiving`、`verifying`、`completed`、`closed`）、`committedBytes`、`createdAt`、`expiresAt`、`verificationLeaseUntil`、`verificationOwner`，以及按块记录的 `index`、`bytes`、`sha256`、`storageKey` | `id` 主键，`(runId, createdAt)` 查询历史，`(state, expiresAt)` 清理暂存，块唯一键 `(uploadId, index)`。Run 只指向一个当前会话。 |

## 列表、对比、下载与保留

- `GET /runs` 每次查一个项目，结果为 `{items, nextCursor}`。可按 `flowId`、`status`（`passed`、`failed`、`blocked`）、`startedAt` 的 `from`（含）与 `to`（不含）组合过滤。所有时间字段使用 UTC 毫秒格式，同时传入 `from` 和 `to` 时要求 `from < to`。按 `(startedAt, runId)` 降序，`limit` 默认 50、最大 100。后续页把 `nextCursor` 作为查询参数 `cursor`，沿用相同项目和过滤条件。游标由服务端绑定项目和过滤条件，非法或失配返回 `400`。`nextCursor: null` 表示已到末页。对 `pending` 或 `rejected` 的 Run 调用单条读接口时返回 `404`。
- `RunSummary` 提供 `flowId`、`flowSha256`、`mode`、`status`、`startedAt`（运行开始）、`completedAt`（上传校验通过并发布）、`durationMs`（所有报告条目中 `atMs + durationMs` 的最大值）和 `entryCounts`（按状态计数，包含 setup 条目）。同项目下可选取两个 Run 对比状态、耗时和条目计数。同一 `flowSha256` 且相同 `mode` 的运行可在查看器中按条目 ID 和类型对照。跨版本通过摘要对比并展示版本差异。首版通过列表、详情和查看器提供对比输入。
- `/bundle` 返回上传 ZIP 的原字节，`/viewer` 由服务端从已校验的报告与流程渲染时间线和详情。两条路径都要求 `runs:read` 并发送 `Cache-Control: no-store`。到期前存储暂时不可用时返回 `503 SERVER_ERROR`。对象存储地址和凭据保持私有。
- 默认从 `completedAt` 起保留 ZIP 30 天，项目可配置。服务端在 `expiresAt` 到达时立即停止提供 ZIP 和查看器，返回 `410`，清理任务随后删除对象。摘要中的 `artifact.state` 随之为 `expired`。保留 Run 摘要与幂等记录供长期追溯，包括拒绝或放弃的运行键。暂存块按会话到期清理，概要元数据保留。下载过期不影响摘要列表与对比。

## 上传数据安全

- 上传版 ZIP 默认省略 `assets/`，可按路径允许经审核的产物。截图可上传前遮盖或裁切，日志、AX 快照和报告文本须按项目规则清除敏感值。规则也覆盖 `flow.json` 的输入文本、窗口标题以及查看器内嵌内容。配置的脱敏规则失败时暂停上传。对于必须保留的敏感字段，项目可选择只存本地。已有本地原始 ZIP 可与经审核的上传版并存。
- 先过滤和脱敏，再重建清单与查看器，最后计算整包 SHA-256。修改 `flow.json` 时重新计算 `report.json` 和清单的 `flowSha256`，并确保步骤与报告仍对应。脱敏版 `flowSha256` 标识脱敏后的流程内容。禁止从未经脱敏的本地 ZIP 直接复制旧清单或旧查看器到上传版。
- 服务端按不可信归档处理 ZIP。只接受普通文件以及约定路径，拒绝逃逸路径、重复路径、符号链接和加密条目。限制为最多 10,000 个文件、最多 2 GiB 实际解压数据，`report.json`、`flow.json` 和 `manifest.json` 各最多 16 MiB。校验在隔离暂存区内执行，按实际输出累加字节。存储键由服务端生成。日志仅记录必要的请求 ID、项目与运行标识、状态和时序。
- 托管查看器使用服务端受控模板，所有报告文本做输出转义，带禁止脚本、外部资源与嵌入的 CSP，且不加载包内 HTML 或用户资产。包内 `index.html` 只随原始 ZIP 作为附件分发。
