# v2 系统状态检查（文件 / 进程）

`kind: "assert"` 的两种系统级变体：检查一个绝对路径的文件是否存在，或检查一个可执行进程是否在运行。它们不绑定 App 或窗口，不使用 Dock 等 UI surface，也不会启动、聚焦、点击或提权。

## 文件

```json
{
  "id": "report-exists", "kind": "assert",
  "scope": { "kind": "file", "path": "/Users/qa/Downloads/report.pdf" },
  "check": { "kind": "file_exists", "equals": true }
}
```

- 只读元数据（`stat`）。零字节普通文件存在；指向普通文件的符号链接按 `stat` 语义视为存在。
- 目录和其他非普通文件的实际值为 `false`；`ENOENT`、`ENOTDIR` 为 `false`。
- 权限等其他探测错误是**未知**：步骤失败并报 `SYSTEM_CHECK_FAILED`，`actual` 记为 `null`，反向检查也不会因此通过。
- 路径必须是绝对 POSIX 路径，不能含控制字符或 `..` 分段。
- 文件 wait（`directory` + `name`/`suffix`、下载完成语义）是另一条契约，保持不变。

## 进程

```json
{
  "id": "chrome-running", "kind": "assert",
  "scope": { "kind": "process", "name": "Google Chrome" },
  "check": {
    "kind": "process_running", "equals": true,
    "args": ["--remote-debugging-port=9222", "--profile", "a b"]
  }
}
```

`scope` 二选一：`{ "kind": "process", "name": "..." }` 或 `{ "kind": "process", "path": "/absolute/executable" }`。

- 身份来自系统（`proc_pidpath`），不是进程自己写的 `argv[0]`；因此一个把 `comm` 改成别的名字的进程不会被误判。`name` 比对真实可执行文件的 basename，`path` 与 `proc_pidpath` 的完整路径逐字比较，均区分大小写，不做软链接等价推断。
- 僵尸进程（state 以 `Z` 开头）不算运行。
- `args` 只在 `name` 模式下允许，`path` 模式只比对可执行文件本身。数组里每一项是一个字面 argv 元素：空格与引号原样保留，不能为空、不能含 NUL 或控制字符，最多 32 项，每项最多 4096 个字符（UTF-8 最多 12288 字节）。流程保存的上限与探测器的传输上限按这个最坏情况对齐：合法保存的长参数会整段参与比较，不会因字节数超过 4096 被当成未知。
- `args` 的匹配语义写死为「`argv[1...]` 中一段**连续、同序、逐项字节相等**的参数」。`["--profile", "a b"]` 匹配一个 `a b` 参数，不匹配 `a` 和 `b` 两个参数；`argv[0]` 不参与比较。
- 参数按 **UTF-8 字节**逐项比较，不做 Unicode 归一化：`e` + U+0301（组合重音）与 U+00E9（预组合 é）是两个不同参数，只有进程实际收到的那一种字节能命中。
- 带 `args` 时只检查**当前有效 UID** 的同名候选：任一候选证实匹配即为 `true`；所有候选都确定不匹配、或没有同名候选时为 `false`；没有命中但仍有候选的参数读不出来（权限、受保护进程、PID 复用、身份在读取前后变化）时是**未知**，报 `SYSTEM_CHECK_FAILED`，`actual` 为 `null`，反向检查同样失败。
- 可执行路径读不出来的**存活**进程不会被丢掉：例如进程的镜像文件已被删除、或进程受保护时，用内核短名（`pbi_name`，同样是系统给的、不是 `argv[0]`）判断它是否仍可能命中。内核名不同的无关进程被排除，不会阻断其它目标的检查；内核名可能就是目标的存活候选保留为**未知**（`SYSTEM_CHECK_FAILED`、`actual: null`），而不是「未运行」。反向检查同样无法通过；只有所有可能命中的候选都能读出并可证明不匹配时才返回 `false`。
- 观测到的单个 argv 元素超过 12288 字节（不可能被保存为期望值）或不是合法 UTF-8 时，按「不匹配」处理，不会让同一进程里其它位置的短参数也变成未知。
- 参数值与观测到的原始 `argv` 只存在于流程和探测内存里：不进入 helper 响应、报告、进度、日志或故障消息。报告里 `stateCheck` 只有 `kind` / `expected` / `actual`。
- 本期不做 PID 匹配；进程名不接受路径分隔符。

## 结果与报告

失败沿用的错误码：值不满足期望是 `ASSERTION_FALSE`（步骤与整次回放失败，后续步骤 `skipped`）；探测本身出错是 `SYSTEM_CHECK_FAILED`。两种情况都会结束本次流程。

每个实际执行过的状态检查在报告里写入：

```json
{ "id": "chrome-running", "status": "passed",
  "stateCheck": { "kind": "process_running", "expected": true, "actual": true } }
```

`actual` 是布尔值，未知时为 `null`。dry-run、被跳过、以及运行前被安全门拦住的步骤不写入观测，也不伪造 `stateCheck`。

## 探测边界

- 枚举：固定 `/bin/ps -axww -o pid= -o uid= -o state=`（3s 超时、有界输出），只取 pid/uid/state，不读 `comm` 或 `args`。
- 身份与参数：只读原生 helper（`npm run build:recorder` 构建的 `dist/cuekeeper-identity`）的两个子命令，固定命令 + 一次有界 JSON 请求 + 有界的运行时间与输出。参数比较在 helper 内用带 `argc` 有界的 `KERN_PROCARGS2` 完成，并在读取前后核对同一 PID 的身份。
- helper 缺失、提前退出、请求管道写入失败（`EPIPE`）、超时或输出超限都报告 `SYSTEM_CHECK_FAILED`（未知），回放照常收尾并写出报告；不会让 CLI 直接退出。
- helper 缺失时报告 `SYSTEM_CHECK_FAILED`，提示用 `npm run build:recorder` 构建。
