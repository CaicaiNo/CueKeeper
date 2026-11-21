# TextEdit 现场验收

在批准的时间窗内执行，原生构建和现场运行分开。一轮只构建一次。现场涉及 TextEdit、测试专用文件、辅助功能和输入监控。预留两项授权操作，各最多一次，已有权限时通常为零。权限由操作者在 macOS 手动处理。遇到额外弹窗或窗口错配时结束验收。

## 准备与录制

1. 执行 `pnpm build:recorder`，生成 `dist/cuekeeper-capture`。agent-desktop 使用 1.3.1，`CUEKEEPER_AGENT_DESKTOP` 可指定可信二进制的绝对路径。
2. 只使用专用空白纯文本文档 `Cuekeeper-M1.txt`，保存到新建测试目录。确认窗口标题和文件名一致，关闭测试无关的 TextEdit 窗口。
3. 在终端执行以下命令。确认每块显示器都有边框和顶部 HUD，计时在走。切换到已保存的测试文档并点击正文，使用英文键盘输入 `Cuekeeper M1`。切到飞书，再用 Cmd+Tab 切回 TextEdit，按 Cmd+S，最后用 Ctrl+Option+X 停止。录制时可用 Ctrl+Option+P 暂停或继续。暂停时 HUD 计时冻结，会话仍在 `--seconds` 到点时收尾。

```sh
mkdir -p out
node dist/cli.js record --app com.apple.TextEdit --window Cuekeeper-M1.txt \
  --out out/recorded.flow.json --seconds 25 --json
node dist/cli.js flow validate out/recorded.flow.json --json
node dist/cli.js run out/recorded.flow.json --dry-run --json
```

4. 确认 flow 的三步依次为 `click`、`type` 和 `key`，输入文本与测试文件一致，CLI 返回一次 `FOCUS_CHANGED` 提示，dry-run 每项为 `resolved`。
5. 单独录制一轮核对 HUD。把测试窗口放在 HUD 下方，点击 HUD 并观察鼠标事件是否穿透，再点击正文、输入、保存并停止。flow 应只包含正文点击、输入和保存。若有多个屏幕或 Space，确认切换时 HUD 仍可见。
6. 另开一轮检查截图，可用 `--no-indicator` 关闭边框和 HUD。默认窗口设置为 `sharingType = .none`，较新的系统截图和录屏工具可能仍会拍到 HUD。此 CLI 生成的是动作 flow 与报告 ZIP。 [Apple 窗口共享说明](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none)

默认静音，`--sound` 开启起止提示音。时间到点或按停止热键时，录制会保存动作。Ctrl+C 和运行中失去权限会写入已有动作，并在 CLI 标记部分录制。没有可用动作时，CLI 会报告具体原因。

## 回放与核对

每轮从同一个测试文件的空白已保存状态开始。通过 TextEdit 清空正文并保存，核对磁盘文件为空；保持目标窗口唯一并等待回放完成。回放会物理点击，期间暂停鼠标键盘操作。为每次运行使用新报告名。

```sh
node dist/cli.js run out/recorded.flow.json --headed --report out/run-01.json --json
node dist/cli.js report pack out/run-01.json --flow out/recorded.flow.json \
  --out out/run-01.zip --json
unzip -t out/run-01.zip
```

每轮同时核对 JSON 中三步的顺序和状态，并逐字节比较磁盘文件与预期 ASCII 文本。记录每轮结果和报告文件。完成后关闭测试文档，将窗口控制权交还操作者。若失败，保存对应结果并停止后续输入。真实验收通过需达到十轮均通过。
