# 报告上传客户端

本文件说明 `report pack` 之后的可选上传路径。线协议、字段与错误码以[报告上传协议](upload-protocol.md)和 [`upload.schema.json`](../schemas/upload.schema.json) 为准；本文件只描述客户端如何配置、排队和重试。自建服务端的启动、存储和读取接口见[上传服务](server.md)。

## 配置

未配置时 `report pack` 行为完全不变：只写本地 ZIP，不创建队列、不发网络请求、输出字段与旧版一致。

配置来源按以下顺序解析：

1. 环境变量（任一 `CUEKEEPER_UPLOAD_*` 存在时按环境变量解析，缺项直接报错）：
   - `CUEKEEPER_UPLOAD_URL`：服务地址，必须是 HTTPS origin；仅回环地址（`localhost` / `127.0.0.1` / `::1`）允许 HTTP，供测试用 mock server 使用。URL 不允许带用户名、密码、路径、查询或片段。
   - `CUEKEEPER_UPLOAD_PROJECT`：`projectId`，匹配 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`。
   - `CUEKEEPER_UPLOAD_TOKEN_ENV`：保存 token 的环境变量名（推荐）。
   - `CUEKEEPER_UPLOAD_TOKEN`：直接以环境变量注入 token 的快捷方式，等价于引用 `CUEKEEPER_UPLOAD_TOKEN`。
2. 配置文件：
   - 路径由 `--config <path>` 或 `CUEKEEPER_UPLOAD_CONFIG` 指定；未指定时为 `~/.cuekeeper/upload.json`（不存在即视为未配置）。
   - 内容：`{"version":1,"url":"https://…","projectId":"…","tokenEnv":"CUEKEEPER_UPLOAD_TOKEN"}`。
   - `{"enabled":false}` 可显式关闭；未知字段报错，便于发现拼写错误。

token 只从环境变量读取。配置文件只存变量名，队列项只存 `env:NAME` 形式的凭据引用；token 不会写入 ZIP、报告、队列 JSON、URL、日志或错误消息。队列项的 `server`、`projectId` 在入队时固定，之后修改配置不会改变已有队列项的目标。

队列目录默认 `~/.cuekeeper/upload-queue`，可用 `--queue <dir>` 或 `CUEKEEPER_UPLOAD_QUEUE` 覆盖。

## 打包与入队

```sh
node dist/cli.js report pack out/run/report.json --flow out/run/flow.json \
  --out out/run/report.zip --json
```

配置有效时，打包成功后自动入队并输出 `data.upload`：

```json
{"queued":true,"queue":"/Users/me/.cuekeeper/upload-queue","id":"<队列项 id>","duplicate":false}
```

- `--no-upload`：本次只打包，不入队。
- 入队失败（磁盘、权限或配置错误）不会撤销已写好的 ZIP：`data.upload` 为 `{"queued":false,"error":"…"}`，命令仍返回 0，打包结果与上传结果分开记录。
- 同一 `(server, projectId, bundle sha256)` 只会有一个队列项。重复打包同一字节返回 `duplicate:true`，不会产生第二个运行。
- 打包固定时间戳，同一报告与资产生成同一字节，因此重复打包的 sha256 与上传内容一致。
- 上传成功后不删除本地 ZIP；ZIP 的去留仍由现有本地文件规则决定。

## 队列与重试

```sh
node dist/cli.js report upload --json
```

每次调用串行处理所有到期队列项：

1. 校验 ZIP 的大小与 SHA-256。缺失或内容改变时暂停，不删除文件；恢复原字节后重新打包/重新入队会解除暂停。
2. 以完整 ZIP 的 SHA-256 作为 `Idempotency-Key` 创建运行；服务端命中已有运行时返回同一 `runId`。
3. 从服务端确认的 `committedBytes` 开始，按 8 MiB 顺序 PUT 剩余块，然后调用 `complete`。请求带块级 `X-Chunk-Sha256`。
4. 会话冲突按协议恢复：`CHUNK_OUT_OF_ORDER`、`UPLOAD_INCOMPLETE`、`UPLOAD_EXPIRED`、`UPLOAD_FINALIZED` 用同一幂等键重发创建请求对齐进度；`UPLOAD_VERIFYING` 等待 `Retry-After` 后重试完成。
5. 网络失败、超时（单请求默认 60 秒）、`429`、`5xx` 留在队列，指数退避并带抖动；`Retry-After` 优先。默认 8 次后暂停，需人工处理。
6. `400`、`401`、`403`、`404`、`409`（不可恢复）、`413`、`415`、`422` 等非可重试错误立即暂停，`lastError` 记录 `code`、`status`、`retryable` 和可读 `message`。

暂停项保留原幂等键。原因修复后：

```sh
node dist/cli.js report upload --retry-paused --json
```

`--retry-paused` 将暂停项恢复为待处理并重置本地重试计数，但不会改变 ZIP 摘要、服务地址、项目或凭据引用。

队列实现细节：

- 每个队列项一个 JSON 文件，写入采用同目录临时文件加 `rename` 的原子替换。
- 处理时使用 `<item>.json.lock` 锁文件，同一项只由一个 worker 处理；超过 10 分钟的锁视为陈旧并可回收。
- 已完成的队列项保留为 `done`，用于证明幂等与避免重复上传；不会再次处理。
- `report upload` 的退出码：全部完成或仅剩待重试项为 `0`；存在需要人工处理的暂停项为 `1`。`--json` 输出 `done` / `pending` / `paused` / `skipped` 计数与逐项结果。

## 错误处理摘要

| 情形 | 客户端行为 |
| --- | --- |
| 未配置上传 | 只写本地 ZIP，行为与旧版一致 |
| 配置缺项、URL 非 HTTPS、token 环境变量不存在 | 打包仍成功，`upload.queued=false` 并给出原因；上传阶段则暂停该项 |
| 断网、超时、`429`、`5xx` | 保留 ZIP 与队列项，退避后重试 |
| `401` / `403` | 暂停并提示更新 token 或项目授权 |
| `413` / `422` / 其他 `4xx` | 暂停并给出服务端可读原因，不自动重试 |
| ZIP 被移动、删除或改写 | 暂停原任务，不删除文件，不产生新运行 |
| 页面跳转（`3xx`） | 拒绝跟随，避免认证头泄露 |

## 测试用 mock server

`test/support/upload-api.mjs` 是按协议形状实现的内存 mock，只用于验证客户端，不是交付服务端。它覆盖：

- 成功上传、缺省认证（401）、跨项目（403）、大小上限（413）、内容类型（415）、块摘要（422）、整包摘要（422）。
- 幂等创建（同一键返回同一 `runId`）、丢响应（创建后断开连接）、`CHUNK_OUT_OF_ORDER`、`CHUNK_CONFLICT`、`UPLOAD_INCOMPLETE`、`UPLOAD_EXPIRED`、`UPLOAD_FINALIZED`、`UPLOAD_VERIFYING`。
- 可注入任意错误状态与 `Retry-After`，可切换离线以模拟断网恢复。

运行：`npm run build && npm test`（`test/upload.test.mjs`）。

## 当前限制

- 只实现上传（创建、传块、完成）；列表、下载、查看器和对比不在本单范围。
- 凭据存储首版只支持环境变量引用，不接入系统钥匙串。
- 队列由 `report upload` 前台处理，没有常驻 daemon；打包后需要调用一次该命令，或由外部调度器周期调用。
- 真实服务端见[上传服务](server.md)；`test/support/upload-api.mjs` 只用于客户端协议测试。
