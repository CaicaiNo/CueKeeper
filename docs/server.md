# 自建上传服务

`cuekeeper serve` 实现[报告上传协议 v1](upload-protocol.md)的服务端：接收 `report upload` 的分块上传，校验整包后发布运行摘要，并提供列表、详情、原始 ZIP 下载和查看器。首版为单机、单 workspace、文件系统存储，不依赖数据库服务或对象存储。

## 启动

```sh
# 生成 token 摘要（token 只经 stdin 传入，不写入命令行历史）
printf '%s' "$CUEKEEPER_ADMIN_TOKEN" | node dist/cli.js serve --hash-token

node dist/cli.js serve --config ~/.cuekeeper/server.json --data ~/.cuekeeper/server-data
```

默认只监听 `127.0.0.1:8787`。`--host` / `--port` 覆盖配置中的监听地址；`0.0.0.0` 只在明确需要时使用。`--json` 时启动后输出一行 `{"ok":true,"data":{"url":"…","data":"…"}}`，之后进程保持运行，收到 `SIGINT` / `SIGTERM` 后关闭监听并退出。

## 配置

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 8787,
  "projects": [
    { "id": "textedit", "name": "TextEdit", "artifactTtlDays": 30, "maxBundleBytes": 268435456 }
  ],
  "tokens": [
    {
      "id": "admin",
      "tokenSha256": "<sha256>",
      "scopes": ["runs:write", "runs:read"]
    },
    {
      "id": "textedit-ci",
      "tokenSha256": "<sha256>",
      "scopes": ["runs:write"],
      "projectId": "textedit"
    }
  ]
}
```

- 配置只接受 `tokenSha256`。写明文 `token` 会报错，避免把 token 带进仓库或备份。
- 不填 `projectId` 的是 workspace token，可访问配置中的所有项目；填了就是项目 token，访问其他项目返回 `403`。
- `runs:write` 允许创建运行、传块、完成；`runs:read` 允许列表、详情、下载、查看器。
- `artifactTtlDays` 从完成时刻起计算 ZIP 与查看器的保留天数，默认 30，`0` 表示完成即过期。
- `maxBundleBytes` 是项目级整包上限，默认 256 MiB，不能超过协议硬上限 1 GiB。
- 未知字段、重复项目 ID、未定义项目的 token 都会在启动时报错。配置读取失败以退出码 `2` 结束。

客户端仍使用现有的 `report pack --config` / `report upload`：

```sh
export CUEKEEPER_UPLOAD_URL=http://127.0.0.1:8787   # 回环地址允许 HTTP
export CUEKEEPER_UPLOAD_PROJECT=textedit
export CUEKEEPER_UPLOAD_TOKEN=...                    # 或 CUEKEEPER_UPLOAD_TOKEN_ENV
node dist/cli.js report pack out/run-01/report.json --flow out/run-01/flow.json --out out/run-01.zip
node dist/cli.js report upload
```

## 接口

所有路径以 `/api/v1/projects/{projectId}` 开头，请求需带 `Authorization: Bearer <token>`。

| 方法与路径 | 成功响应 |
| --- | --- |
| `POST /runs` | `201` 新建运行 / `200` 命中同一 `(projectId, bundleSha256)`；返回 `CreateRunResponse` |
| `PUT /runs/{runId}/uploads/{uploadId}/chunks/{index}` | `204` |
| `POST /runs/{runId}/uploads/{uploadId}/complete` | `200 RunSummary` |
| `GET /runs` | `200 ListRunsResponse` |
| `GET /runs/{runId}` | `200 RunSummary`，只公开 `ready` |
| `GET /runs/{runId}/bundle` | `200 application/zip` 原始字节，`Content-Disposition: attachment` |
| `GET /runs/{runId}/viewer` | `200 text/html; charset=utf-8` |

- 分块固定 8 MiB，`index` 从 0 开始，最后一块可短于 8 MiB。请求必须带 `Content-Length`、`X-Chunk-Sha256`，内容类型为 `application/octet-stream`，不接受内容编码。
- 创建时以整包 SHA-256 为 `Idempotency-Key`；同项目同字节只产生一个 `runId`。重发创建请求会返回当前会话与 `committedBytes`，可从中断处续传。
- 会话默认 24 小时后过期；过期后重发创建请求会为同一 Run 分配新会话，进度从 0 开始。
- 列表按 `(startedAt, runId)` 降序，`limit` 默认 50、最大 100；`nextCursor` 绑定项目与过滤条件，改了过滤条件再用旧游标返回 `400`。
- 错误统一为 `{"requestId":"req_…","error":{"status":…,"code":…,"retryable":…,"message":…}}`。`401` 带 `WWW-Authenticate: Bearer`，`UPLOAD_VERIFYING` 带秒数形式的 `Retry-After`。

## 校验与限制

`complete` 会重算整包长度和 SHA-256，再按不可信归档处理 ZIP：

- 只接受存储（method 0）或 deflate（method 8）、非加密、普通文件条目；拒绝符号链接、重复路径、绝对路径、`..` 段、ZIP64。
- 只接受 `index.html`、`report.json`、`flow.json`、`manifest.json` 和 `assets/` 下的文件，最多 10,000 个文件。
- 解压总量最多 2 GiB；`report.json`、`flow.json`、`manifest.json` 各最多 16 MiB。每个条目按声明的解压大小分配缓冲区，声明与实际不符即失败，避免解压炸弹。
- 归档与 `manifest.json` 必须一一对应；逐个文件校验大小、SHA-256，再校验 report / flow schema、`flowId`、`flowSha256`、时间线顺序、资产与步骤的对应关系。
- 失败返回 `422 BUNDLE_INVALID`（归档结构、清单或报告不合法）或 `413 PAYLOAD_TOO_LARGE`（超出文件数、解压量或元数据上限）。Run 记入 `rejected`，同一幂等键重放同样的错误；修正 ZIP 后字节改变即成为新的键。
- 整包摘要与幂等键不符返回 `422 BUNDLE_DIGEST_MISMATCH`，Run 保持 `pending`，会话关闭；重发创建请求可取得新会话。
- 服务端不读取或记录请求体、token 和 Authorization 头；日志只用于内部错误。

## 存储与元数据

```text
<data>/
  meta/state.json          # 运行、会话、产物元数据（原子替换）
  objects/<project>/<sha>.zip
  views/<runId>.html
  staging/<uploadId>/<index>-<sha>.bin
```

元数据选型：**单个 JSON 快照**，每次变更写入同目录临时文件、`fsync` 后用 `rename` 原子替换。单 workspace、单节点的运行量和写入频率很小，JSON 便于直接检查、备份和恢复；块与 ZIP 的字节不进快照，只记录内容寻址的键。因此不引入 SQLite 依赖，也不改变 Node 版本要求。

**限制：一个数据目录只能由一个服务进程使用**，没有跨进程锁。需要水平扩展或多实例共享存储时再引入数据库/对象存储。

块先落盘再推进 `committedBytes`；最终 ZIP 写入 `objects/` 之后，才在元数据中原子发布 `ready`、摘要和产物引用。进程在两者之间崩溃时，客户端可重发 `complete`。

## 查看器

`/viewer` 返回包内已预渲染的 `index.html`，并附加以下响应头：

- `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; …`：禁止脚本、外部资源、表单和嵌入，静态时间线仍可阅读。
- `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

包内 HTML 中的脚本不会执行，`assets/` 也不通过服务端提供，只随原始 ZIP 下载。`upload-protocol.md` 描述的是服务端受控模板渲染；首版按本单要求直接返回包内静态查看器，安全边界由上面的 sandbox + CSP 保证。需要服务端模板化渲染时再单独改这一层。

## 保留与清理

- 产物在 `completedAt + artifactTtlDays` 到期后立即停止提供：`GET /bundle`、`GET /viewer` 返回 `410 ARTIFACT_EXPIRED`，列表与详情仍可查，`artifact.state` 变为 `expired`。
- 启动时和每 10 分钟执行一次清理：删除过期 ZIP、查看器副本和已完成/过期会话的暂存块；Run 摘要与幂等记录永久保留。
- 崩溃留下的 `verifying` 会话在验证租约（120 秒）过期后自动回到 `receiving`，可重试完成。

## 备份与恢复

停止服务后复制整个 `<data>` 目录即可；`meta/state.json`、`objects/`、`views/` 必须一起备份，否则会出现元数据指向缺失对象。配置文件单独备份（只含 token 摘要）。恢复时把同一份目录放回、启动服务即可；`state.json` 损坏时服务拒绝启动，需换回最近备份，不会自动清空。

## 当前限制

- 单 workspace、单节点、文件系统存储；不做多租户、SSO、S3/MinIO。
- `complete` 在内存中组装并校验整包，受项目上限约束；上限越大，峰值内存越高。
- 未实现主动限流（`429 RATE_LIMITED` 已定义但不会主动返回）。
- 下载与查看器不做逐字节 Range 分片；ZIP 以流式附件返回。
- 查看器为静态 HTML，交互脚本被 CSP 禁用。
