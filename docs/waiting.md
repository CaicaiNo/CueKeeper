# 条件等待与安装/卸载观测

下载、安装和卸载不用固定 sleep。`wait` 步骤只读观察当前状态，直到条件成立或单调时钟到达截止时间；等待期间不启动、不聚焦、不点击、不写剪贴板。实现分四处：`src/wait.ts`（等待引擎）、`src/install-state.ts`（安装与下载证据）、`src/lifecycle.ts`（录制期间的只读生命周期观察）、`src/run-v2.ts`（v2 等待分支）。

## 契约

`wait` 允许 `window`、`app` 或 `file` scope，不能观察系统 surface：

| scope | check |
| --- | --- |
| `window` | `window_exists`、`element_enabled`、`element`（既有元素条件）、`window`（存在/标题） |
| `app` | `app_running`、`app_installed` |
| `file` | `file_exists`、`file_stable` |

`timeoutMs` 默认 15000，范围 1000–1800000。进程退出用 `app_running: false` 观察；它不证明安装或卸载成功。

文件 scope 只描述本地目录与一个文件：`{"kind":"file","directory":"/Users/qa/Downloads","name":"App.pkg"}`，或用 `suffix` 匹配下载器改写过的名字（`App (1).pkg`）。`directory` 必须是绝对路径且不能含 `..`，`name`/`suffix` 不能含分隔符。

| check | 成立条件 | 证据 |
| --- | --- | --- |
| `file_exists` | 目录中恰好一个未写完的文件与 `name`/`suffix` 匹配（`equals` 为 `false` 时表示该文件不存在） | 文件名；`incomplete` 表示只找到部分文件或 0 字节 |
| `file_stable` | 同一个文件的 size 与 mtime 在 `quietMs`（默认 1000，100–60000）内始终不变 | 文件名、size、已稳定时长；至少观察两次，瞬时读数不算完成 |

## 等待引擎

- 第一次观察立即执行，已满足的条件只读一次、不设定时器。
- `file_stable` 例外：它需要同一文件在 `quietMs` 内保持不变，因此至少观察两次；第一次读数只记录 size 与 mtime。
- 单调时钟（`performance.now`）计算截止时间；最后一次观察在截止后仍会执行一次，再报超时。
- 状态通知可选：`subscribe` 唤醒等待，同时保留有限轮询（100 ms 起、最多 500 ms），漏掉通知不会卡住。
- 可取消：取消抛出 `WAIT_CANCELLED`，消息保留取消原因。

## 安装与下载证据

- **下载完成**：目标文件必须能在下载目录唯一确定。部分文件（`.crdownload`/`.download`/`.part`/`.tmp`）和 0 字节文件不算完成；`notBeforeMs` 可排除录制开始前就存在的旧文件。按 `name` 查找时，同名文件旁的 `Name.pkg.crdownload` 这类正在写入的临时文件算「还没写完」，不是「没有这个文件」。两个匹配文件按 `DOWNLOAD_AMBIGUOUS` 停止，不按位置挑选。
- **安装**：只有固定路径上的 `.app` 存在且 `CFBundleIdentifier` 匹配，或存在同一 pkg 的 receipt（pkg ID 等于 bundle ID 或以 `<bundleId>.` 开头），才算已安装。进程存在或退出都不作为安装证据。
- **卸载**：固定路径上的 bundle 消失才算移除；绑定进程退出单独记录。PID 已属于另一个 App 时按错误进程处理。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `WAIT_TIMEOUT` | 截止时间内条件未成立；消息保留 scope、条件与最后一次观察 |
| `WAIT_CANCELLED` | 运行被取消 |
| `WAIT_UNSUPPORTED` | 未知的等待条件，不猜测 |
| `WAIT_OBSERVER_FAILED` | 观察抛出未分类错误 |
| `WAIT_TIMEOUT_INVALID` | 超时不在 1000–1800000 |
| `DOWNLOAD_PATH_INVALID` | 下载目录不是绝对路径、不可读，含 `..`，或文件名不合法 |
| `DOWNLOAD_NOT_FOUND` | 目录中没有匹配的完成文件 |
| `DOWNLOAD_AMBIGUOUS` | 有多个匹配文件，不按位置挑选 |
| `DOWNLOAD_INCOMPLETE` | 匹配到部分文件或 0 字节文件 |
| `PROCESS_MISMATCH` | 观察到的 PID 已不属于绑定的 App |

等待中的观察错误若是 `NOT_FOUND`、`WINDOW_NOT_FOUND`、`APP_NOT_FOUND` 或 `INCOMPLETE_TREE`，视为“还没到”，继续等；其他错误立即停止。

## 工作台候选等待

工作台不按空闲时间猜条件。运行目录内的 `lifecycle.json` 记录明确的下载、安装、卸载事件：

```json
{
  "version": 1,
  "events": [
    { "at": 1200, "kind": "download_completed", "path": "/Users/qa/Downloads/App.pkg" },
    { "at": 1800, "kind": "install_completed", "app": "com.example.CuekeeperTest", "afterStepId": "step-7" }
  ]
}
```

`kind` 为 `download_completed`、`installer_shown`、`install_completed`、`app_appeared`、`uninstaller_shown`、`uninstall_completed`、`app_disappeared`。位置由 `afterStepId` 指定，或由 `actions.json` 的 `atMs` 与事件时间推出；两者都没有时不提出候选。

### 事件由录制自动产生

`record --global` 默认在录制期间只读观察，结束后把事件写进 flow 同目录的 `lifecycle.json`：

- 下载：列出 `~/Downloads`（或 `CUEKEEPER_LIFECYCLE_DOWNLOAD_DIRS`，用 `:` 分隔）里新出现的 `pkg`/`mpkg`/`dmg`/`zip` 文件；size 与 mtime 稳定 1 秒后写一条 `download_completed`，带文件路径。录制开始前就存在的文件不算事件。
- 安装/卸载：列出 `~/Applications`、`/Applications`（或 `CUEKEEPER_LIFECYCLE_APP_DIRS`）的 `.app`，读出 `CFBundleIdentifier` 后，新出现的写 `install_completed`，消失的写 `uninstall_completed`。读不出 bundle ID 的包不算安装证据；装在这两个目录之外的 App 不产生事件，需要手工补 `lifecycle.json`。
- 每条事件在到达时记下当时的最后一步为 `afterStepId`，所以候选自带位置。观察本身不启动、不聚焦、不动文件；`--no-lifecycle` 关闭观察。观察失败只写警告，不打断录制。默认目录下 `lifecycle.json` 属于最近一次录制；需要按次留存时用 `--out` 指向独立目录。

### 候选映射

- `download_completed` 且事件带文件路径 → 等待该文件 `file_stable`（默认 `quietMs` 1000），不依赖下载界面元素；没有路径时保持「需补充条件」。
- `install_completed` → `app_installed = true`；`app_disappeared` / `uninstall_completed` → `app_installed = false`。
- `app_appeared` 优先等待该 App 已录制的窗口，没有窗口时等待安装证据。
- `installer_shown` / `uninstaller_shown` 优先等待已录制的该窗口，否则等待 App 运行。

用户在「前置条件」区确认后才写入 `flow.with-waits.json`（存在同名文件时顺延编号）。工作台不修改原 `flow.json`，也不启动或聚焦任何 App。
