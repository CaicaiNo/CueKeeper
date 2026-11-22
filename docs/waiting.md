# 条件等待与安装/卸载观测

下载、安装和卸载不用固定 sleep。`wait` 步骤只读观察当前状态，直到条件成立或单调时钟到达截止时间；等待期间不启动、不聚焦、不点击、不写剪贴板。实现分三处：`src/wait.ts`（等待引擎）、`src/install-state.ts`（安装与下载证据）、`src/run-v2.ts`（v2 等待分支）。

## 契约

`wait` 允许 `window` 或 `app` scope，不能观察系统 surface：

| scope | check |
| --- | --- |
| `window` | `window_exists`、`element_enabled`、`element`（既有元素条件）、`window`（存在/标题） |
| `app` | `app_running`、`app_installed` |

`timeoutMs` 默认 15000，范围 1000–1800000。进程退出用 `app_running: false` 观察；它不证明安装或卸载成功。

## 等待引擎

- 第一次观察立即执行，已满足的条件只读一次、不设定时器。
- 单调时钟（`performance.now`）计算截止时间；最后一次观察在截止后仍会执行一次，再报超时。
- 状态通知可选：`subscribe` 唤醒等待，同时保留有限轮询（100 ms 起、最多 500 ms），漏掉通知不会卡住。
- 可取消：取消抛出 `WAIT_CANCELLED`，消息保留取消原因。

## 安装与下载证据

- **下载完成**：目标文件必须能在下载目录唯一确定。部分文件（`.crdownload`/`.download`/`.part`/`.tmp`）和 0 字节文件不算完成；`notBeforeMs` 可排除录制开始前就存在的旧文件。
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
| `DOWNLOAD_PATH_INVALID` | 下载目录不是绝对路径、不可读，或文件名不合法 |
| `DOWNLOAD_NOT_FOUND` | 目录中没有匹配的完成文件 |
| `DOWNLOAD_AMBIGUOUS` | 有多个匹配文件，不按位置挑选 |
| `DOWNLOAD_INCOMPLETE` | 匹配到部分文件或 0 字节文件 |
| `PROCESS_MISMATCH` | 观察到的 PID 已不属于绑定的 App |

等待中的观察错误若是 `NOT_FOUND`、`WINDOW_NOT_FOUND`、`APP_NOT_FOUND` 或 `INCOMPLETE_TREE`，视为“还没到”，继续等；其他错误立即停止。

## 工作台候选等待

工作台不按空闲时间猜条件。运行目录内可放 `lifecycle.json`，由录制/观察层写入明确的下载、安装、卸载事件：

```json
{
  "version": 1,
  "events": [
    { "at": 1200, "kind": "download_completed", "app": "com.example.Web", "path": "/Users/qa/Downloads/App.pkg" },
    { "at": 1800, "kind": "install_completed", "app": "com.example.CuekeeperTest", "afterStepId": "step-7" }
  ]
}
```

`kind` 为 `download_completed`、`installer_shown`、`install_completed`、`app_appeared`、`uninstaller_shown`、`app_disappeared`。位置由 `afterStepId` 指定，或由 `actions.json` 的 `atMs` 与事件时间推出；两者都没有时不提出候选。

- `install_completed` → `app_installed = true`；`app_disappeared` → `app_installed = false`。
- `app_appeared` 优先等待该 App 已录制的窗口，没有窗口时等待安装证据。
- `installer_shown` / `uninstaller_shown` 优先等待已录制的该窗口，否则等待 App 运行。
- `download_completed` 没有可用 check 能证明“下载界面完成”，候选保持“需补充条件”，确认时返回 `WAIT_CANDIDATE_INCOMPLETE`。

用户在「前置条件」区确认后才写入 `flow.with-waits.json`（存在同名文件时顺延编号）。工作台不修改原 `flow.json`，也不启动或聚焦任何 App。
