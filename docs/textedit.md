# TextEdit 现场验收

批准窗口内执行；原生构建和现场运行分开。一轮只构建一次。现场预计 5–10 分钟，涉及 TextEdit、测试专用文件、辅助功能和输入监控。预留两项授权操作，各最多一次，已有权限时通常为零。权限由操作者在 macOS 手动处理。若出现未预期的弹窗、前台切换或窗口错配，终止流程。

## 准备与录制

1. 执行 `pnpm build:recorder`，生成 `dist/cuekeeper-capture`。agent-desktop 使用 1.3.1，`CUEKEEPER_AGENT_DESKTOP` 可指定可信二进制的绝对路径。
2. 只使用专用空白纯文本文档 `Cuekeeper-M1.txt`，保存到新建测试目录。确认窗口标题和文件名一致，关闭测试无关的 TextEdit 窗口。
3. 在终端执行以下命令，看到录制提示后切换到已保存的测试文档。点击正文一次，用英文键盘输入 `Cuekeeper M1` 并按 Cmd+S。停留在目标窗口，待 25 秒计时结束。Ctrl+C 会中止并且丢弃当前录制。

```sh
mkdir -p out
node dist/cli.js record --app com.apple.TextEdit --window Cuekeeper-M1.txt \
  --out out/recorded.flow.json --seconds 25 --json
node dist/cli.js flow validate out/recorded.flow.json --json
node dist/cli.js run out/recorded.flow.json --dry-run --json
```

确认实际录制的动作依次为 `click`、`type` 和 `key`，dry-run 每项为 `resolved`。

## 回放与核对

每轮从同一个测试文件的空白已保存状态开始。通过 TextEdit 清空正文并保存，核对磁盘文件为空；保持目标窗口唯一并等待回放完成。回放会物理点击，期间暂停鼠标键盘操作。为每次运行使用新报告名。

```sh
node dist/cli.js run out/recorded.flow.json --headed --report out/run-01.json --json
node dist/cli.js report pack out/run-01.json --flow out/recorded.flow.json \
  --out out/run-01.zip --json
unzip -t out/run-01.zip
```

每轮同时核对 JSON 中三步的顺序和状态，并逐字节比较磁盘文件与预期 ASCII 文本。记录每轮结果和报告文件。完成后关闭测试文档，将窗口控制权交还操作者。若失败，保存对应结果并停止后续输入。真实验收通过需达到十轮均通过。
