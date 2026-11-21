# TextEdit 现场验收

在批准的时间窗内执行，原生构建和现场运行分开。一轮只构建一次。现场涉及 TextEdit、测试专用文件、辅助功能和输入监控。预留两项授权操作，各最多一次，已有权限时通常为零。权限由操作者在 macOS 手动处理。遇到额外弹窗或窗口错配时结束验收。

## 主屏录制验收 · 5 分钟

使用下方命令。首轮可设 `--seconds 90`，留出切换应用和核对 HUD 的时间。每轮指定新的 `--out`，所有点击和键入由操作者完成。

| 时间 | 操作 | 预期 | 失败判据 |
| --- | --- | --- | --- |
| 0–1 分钟 | 单次构建录制器并核对时间戳，准备专用空白纯文本文件。启动后等待终端 `INDICATOR_READY` 或 HUD「录制就绪」 | 窗口服务器确认主屏面板，主屏能看到边框和高亮 HUD。授权提示为 0–2 个 | 构建失败、窗口错配、额外弹窗或终端报告 `INDICATOR_NOT_VISIBLE` 时立即停止。终端就绪但主屏仍不可见时也停止 |
| 1–3 分钟 | 点击正文，输入 `Cuekeeper M1`，按 Cmd+S。切到飞书再切回 TextEdit，按 `Ctrl+Option+P` 暂停两秒再继续，按 `Ctrl+Option+X` 停止 | 主屏显示 3pt 边框和顶部计时 HUD。暂停时计时冻结，继续后恢复。切换时会话继续，停止后指示器消失 | 指示器或热键失效，切换导致退出，或停止后指示器仍在 |
| 3–4 分钟 | 另起一轮，分别点主屏边框和 HUD 下方可安全操作、效果可见的位置，再完成一次普通正文点击并停止 | 底层窗口收到点击，这轮 flow 只含一次普通点击 | 底层点击被拦截，指示器上的点击进入 flow，或普通点击缺失 |
| 4–5 分钟 | 查看第一轮 flow、CLI 输出和磁盘上的专用文件，关闭测试文档 | 三步依次为 `click → type → key`，最后一步是 Cmd+S。文本与磁盘内容逐字节一致，CLI 提示 `FOCUS_CHANGED`。采集进程已退出 | flow 缺失、动作数量或顺序错误、文本不符，或采集进程仍存在 |

该清单用于录制验收。下方十轮回放是单独的完整验收。

## 准备与录制

1. 执行 `pnpm build:recorder`，生成 `dist/cuekeeper-capture`。agent-desktop 使用 1.3.1，`CUEKEEPER_AGENT_DESKTOP` 可指定可信二进制的绝对路径。
2. 只使用专用空白纯文本文档 `Cuekeeper-M1.txt`，保存到新建测试目录。确认窗口标题与文件名一致且唯一，并把专用文档选为当前 TextEdit 窗口。
3. 在终端执行以下录制命令。看到 `INDICATOR_READY` 或 HUD「录制就绪」后开始操作。启动失败时保留 CLI 诊断。使用英文键盘输入，切回 TextEdit 可用 Cmd+Tab。暂停时 HUD 计时冻结，会话仍在 `--seconds` 到点时收尾。

```sh
mkdir -p out
node dist/cli.js record --app com.apple.TextEdit --window Cuekeeper-M1.txt \
  --out out/recorded.flow.json --seconds 90 --json
node dist/cli.js flow validate out/recorded.flow.json --json
node dist/cli.js run out/recorded.flow.json --dry-run --json
```

4. 需要进一步检查定位器时，可执行上面的 `run --dry-run`，三步应均为 `resolved`。

`--no-indicator` 可关闭边框与 HUD，此时以标准错误的 `Recording for up to ...` 提示开始，热键仍可用。时间到点或按停止热键时，录制会保存动作。Ctrl+C 和运行中失去权限会写入已有动作，并在 CLI 标记部分录制。没有可用动作时，CLI 会报告具体原因。

## 回放与核对

每轮从同一个测试文件的空白已保存状态开始。通过 TextEdit 清空正文并保存，核对磁盘文件为空；保持目标窗口唯一并等待回放完成。回放会物理点击，期间暂停鼠标键盘操作。为每次运行使用新报告名。

```sh
node dist/cli.js run out/recorded.flow.json --headed --report out/run-01.json --json
node dist/cli.js report pack out/run-01.json --flow out/recorded.flow.json \
  --out out/run-01.zip --json
unzip -t out/run-01.zip
```

每轮同时核对 JSON 中三步的顺序和状态，并逐字节比较磁盘文件与预期 ASCII 文本。记录每轮结果和报告文件。完成后关闭测试文档，将窗口控制权交还操作者。若失败，保存对应结果并停止后续输入。真实验收通过需达到十轮均通过。
