# 批量运行报告

工作台批量运行的产物分两层：**批次汇总**回答「哪一条、哪一轮、哪一步失败」，**逐轮报告**保留完整的步骤、断言证据和截图。两层都在运行目录里，不依赖工作台进程。

```
run-directory/
  batch-2026-11-24T08-20-08-998Z-a4f1ecd6/
    batch.json                 ← 批次汇总（本文件定义）
    round-01-01/report.json    ← 第 1 轮、队列第 1 条
    round-01-01/report.json.assets/…   ← 断言截图（仅截图断言产生）
    round-01-02/report.json
    …
```

`batch.json` 每跑完一行就原子重写一次（`.tmp` → `rename`），不是等批次结束才写。机器休眠、崩溃或被手动停止时，已经完成的行仍然可查，未完成的行只出现在 `counts.notCompleted`。

结构由 `schemas/workbench-batch.schema.json` 固定（`format: "cuekeeper-workbench-batch"`，`version: 2`），代码里的校验器是 `src/contracts-workbench.ts` 的 `workbenchBatchCheck`。

## 汇总根对象

| 字段 | 含义 |
| --- | --- |
| `id` | 批次目录名，可直接用来定位产物 |
| `status` | `running` / `passed` / `failed` / `blocked` / `stopped`。有失败优先报 `failed` |
| `stopReason` | `complete` / `failure`（失败即停）/ `operator`（手动停止）/ `time`（到点停止） |
| `startedAt` / `finishedAt` / `durationMs` | 批次墙钟时间；运行中 `finishedAt` 缺省 |
| `host` | 平台、架构、系统版本、Node、Cuekeeper、agent-desktop 版本。换机器后复现先比对这里 |
| `config` | 轮次、轮次间隔、失败策略、停止时刻 |
| `counts` | `planned`、`completed`、`passed`、`failed`、`blocked`、`error`、`interrupted`、`notCompleted` |
| `failureCounts` | 按失败类别计数，早上一眼看出是断言问题还是环境问题 |
| `firstFailure` | 第一条非通过记录：`run`、`path`、`item`、`round`、`status`、`failure` |
| `items[].runs[]` | 每个工作流的每一次执行，按实际顺序 |
| `log[]` | 与 runs 同步的扁平时间线，带 `run` 序号，便于按时间排查 |
| `error` | 批次级错误（目录或汇总写入失败），与单行失败分开 |

`items[]` 同时列出未勾选的工作流（`selected: false`），方便事后确认「这次到底跑了哪些」。

## 单次执行

```json
{
  "run": 7,
  "round": 3,
  "status": "failed",
  "startedAt": 1795508411907,
  "finishedAt": 1795508411930,
  "durationMs": 23,
  "exitCode": 1,
  "signal": null,
  "failure": {
    "category": "assertion",
    "code": "ASSERTION_FALSE",
    "stepId": "check-refund",
    "stepKind": "assert",
    "message": "期望「退款成功」可见，实际未在 5 s 内出现",
    "expected": { "property": "text", "equals": "退款成功" },
    "actual": "待退款",
    "screenshots": {
      "baseline": "assets/check-refund/assertion-baseline.png",
      "actual": "assets/check-refund/assertion-actual.png"
    }
  },
  "report": "round-03-02/report.json",
  "steps": [
    { "id": "click-refund", "kind": "click", "status": "passed" },
    { "id": "check-refund", "kind": "assert", "status": "failed", "code": "ASSERTION_FALSE" }
  ]
}
```

- `run` 是批次内全局序号，从 1 开始；`round` 是轮次，队列顺序另由 `items` 的顺序表达。
- `report` 相对批次目录，逐轮报告里有完整条目、断言与证据。
- `steps` 只为**非通过**的执行保留（最多 500 条），通过的执行不重复写步骤，控制整晚汇总的体积。
- `failure` 只取第一个失败/阻塞条目，后面的步骤通常是连锁跳过，没有诊断价值。
- `screenshots` 的路径相对同目录的 `report.json`，由逐轮报告定义。

## 失败类别

类别由错误码映射（`failureCategory()`），页面上直接显示中文标签；未知错误保持 `unknown`，不会硬塞进某个分类。

| 类别 | 页面标签 | 先查什么 |
| --- | --- | --- |
| `assertion` | 断言未通过 | `expected` / `actual`、截图基线；业务状态是否被上一轮污染 |
| `locator` | 定位不到 | 窗口标题是否变了、控件是否改名；`WINDOW_NOT_FOUND` 多为应用没开或标题不符 |
| `focus` | 焦点被抢 | 是否有别的应用抢了前台；`FOCUS_INTERRUPTED` 表示运行期间被人切走 |
| `permission` | 权限不足 | 辅助功能 / 输入监控 / 安全输入状态；权限变更后重新跑一轮 |
| `timeout` | 超时 | 应用启动慢、等待条件不成立；看步骤的 `timeoutMs` |
| `identity` | 应用身份异常 | 同一 bundle 多份副本、路径被替换或升级 |
| `driver` | 驱动失败 | agent-desktop 版本、进程是否崩溃；看 `message` 原文 |
| `artifact` | 产物写入失败 | 磁盘空间、批次目录权限 |
| `shell` | 脚本失败 | 命令本身、退出码、权限模式 |
| `unknown` | 其他错误 | 直接看逐轮报告的 `message` 与该错误码的原始来源 |

## 早上的排查顺序

1. 打开 `batch.json`，先看 `status`、`counts`、`failureCounts`。失败集中在 `assertion` 就查业务，集中在 `locator`/`focus`/`permission` 就查环境。
2. 看 `firstFailure`，拿到 `run` 与 `failure`；页面上的「首个失败」横幅指向同一记录。
3. 打开 `items[].runs[]` 里对应的 `report`，读完整步骤、断言和截图。
4. 需要手工复现时，复制 `items[].reproduce`（例如 `cuekeeper run "/path/test-xxx.test.json" --foreground --headed --json`），单独跑这一条。
5. 批次级 `error` 非空时先解决产物问题，再判断行级结果是否可信。

## 版本

`version: 2` 增加了 `failure`、`steps`、`firstFailure`、`failureCounts`、`host`、`reproduce` 与 `counts` 的细分字段；`version: 1` 是早期内部格式，只含状态、耗时和步骤 ID。读取方应以 `version` 分支，不要假设字段永远存在。
