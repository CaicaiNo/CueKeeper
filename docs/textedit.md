# TextEdit 现场验收

在批准的时间窗内执行，原生构建和现场运行分开。一轮只构建一次。现场涉及 TextEdit、测试专用文件、辅助功能和输入监控。预留两项授权操作，各最多一次，已有权限时通常为零。权限由操作者在 macOS 手动处理。遇到额外弹窗或窗口错配时结束验收。

## 主屏录制验收 · 5 分钟

使用下方命令。首轮可设 `--seconds 90`，留出切换应用和核对 HUD 的时间。每轮指定新的 `--out`，所有点击和键入由操作者完成。

| 时间 | 操作 | 预期 | 失败判据 |
| --- | --- | --- | --- |
| 0–1 分钟 | 单次构建录制器并核对时间戳，准备专用空白纯文本文件。启动后等待终端 `INDICATOR_READY` 或 HUD「录制就绪」 | 窗口服务器确认主屏面板，主屏能看到边框和高亮 HUD。授权提示为 0–2 个 | 构建失败、窗口错配、额外弹窗或终端报告 `INDICATOR_NOT_VISIBLE` 时立即停止。终端就绪但主屏仍不可见时也停止 |
| 1–3 分钟 | 点击正文一次，输入 `Cuekeeper M1`，按 Cmd+S。切到飞书再切回 TextEdit。按 `Ctrl+Option+P` 暂停两秒，再按一次继续，最后按 `Ctrl+Option+X`。按下 P 或 X 时保持 Ctrl 和 Option 按住 | 暂停时计时冻结，继续后恢复。切换时会话继续，停止后指示器消失。暂停及停止热键由录制器消费 | 热键进入正文或 flow，切换导致退出，计时或指示器异常 |
| 3–4 分钟 | 另起一轮，分别点主屏边框和 HUD 下方可安全操作、效果可见的位置，再完成一次普通正文点击并停止 | 底层窗口收到点击，这轮 flow 只含一次普通点击 | 底层点击被拦截，指示器上的点击进入 flow，或普通点击缺失 |
| 4–5 分钟 | 查看第一轮 flow、CLI 输出和磁盘上的专用文件，关闭测试文档 | 三步依次为 `click → type → key`，最后一步是 Cmd+S。文本与磁盘内容逐字节一致，CLI 提示 `FOCUS_CHANGED`。采集进程已退出 | flow 缺失、动作数量或顺序错误、文本不符，或采集进程仍存在 |

该清单用于录制验收。下方十轮回放是单独的完整验收。

## 准备与录制

1. 执行 `pnpm build:recorder`，生成 `dist/cuekeeper-capture`。先用 `node dist/cli.js doctor` 做只读自检（Node、文件、agent-desktop 1.3.1、录制器、辅助功能与输入监控）；发布包用 `cuekeeper doctor`。agent-desktop 使用 1.3.1，`CUEKEEPER_AGENT_DESKTOP` 可指定可信二进制的绝对路径。
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

元素拾取可单独复核。`pick` 只读取一次可访问性树，不点击、不抢焦点；先确认目标窗口标题唯一：

```sh
node dist/cli.js pick --app com.apple.TextEdit --window Cuekeeper-M1.txt --json
node dist/cli.js pick --app com.apple.TextEdit --window Cuekeeper-M1.txt --select e1 --json
```

候选应包含正文 `textfield`。`--select` 输出带 `role`、`name`、`path`、`point` 和 `frame`，其中的 `locator` 写入 flow 后仍要通过 `flow validate` 和离线 dry-run。没有图形界面时可加 `--snapshot <snapshot.json>` 对保存的快照复核同一逻辑。

`--no-indicator` 可关闭边框与 HUD，此时以标准错误的 `Recording for up to ...` 提示开始，热键仍可用。时间到点或按停止热键时，录制会保存动作。Ctrl+C 和运行中失去权限会写入已有动作，并在 CLI 标记部分录制。没有可用动作时，CLI 会报告具体原因。

单击在鼠标松开时入录。相邻两次按下间隔小于 120 ms 且距离小于 3 个逻辑点时，重复按下会被合并。系统识别为双击或三击时，后续按下不会新增步骤，而是把上一步升级为 `count: 2` 或 `count: 3`；超过三次的连续点击按三击记录并报告 `MULTI_CLICK_TRUNCATED`。右键记为 `button: "right"`。滚轮记录 `deltaX`/`deltaY`（CGEvent 行增量，各轴 ±1000）；同一目标 350 ms 内的滚轮事件合并为一步，`durationMs` 记录整段时长。按住鼠标移动超过 3 个逻辑点时记为 `kind: "drag"`：起点、终点、`path`（8 px 或 16 ms 抽稀，最多 64 点）和 `durationMs` 都入录；按住修饰键的拖拽或落在目标窗口外的拖拽会跳过并分别报告 `DRAG_MODIFIERS_SKIPPED` / `DRAG_OUTSIDE_WINDOW`。无按键移动在 3 pt 内停留 ≥300 ms 记 `kind: "hover"`，元素回放取 bounds 中心并等待原停留时长。Cmd+V 默认仍录快捷键；加 `--clipboard` 后只固化 ≤4000 字符的纯文本，记为 `kind: "paste"`。IME 提交的 Unicode 文本按 `type` 记录并标 `ime: true`，组合过程不重放。

双击、三击和右键在回放中分别调用 `double-click`、`triple-click`、`right-click`；双击与三击是物理输入，需要 `--headed`，否则以 `HEADED_REQUIRED` 失败而不是退化成单击。元素滚动调用 `scroll --direction/--amount`，坐标滚动调用 `mouse-wheel --dx/--dy`，同样需要 `--headed`。真机上的滚轮方向、惯性和游戏/远程桌面场景尚未在本轮验收。

排查点击时，可为上述录制命令加 `--trace-clicks`，并单独保留标准错误中的 `CLICK_TRACE` 行。日志含原生鼠标按下、拖动和松开，附坐标、`eventNumber`、`clickState`、AppKit 命中窗口和 Quartz 窗口字段。查看 `suppressed` 和 `reason` 可判断是否因 `duplicate_down` 被过滤；拖拽对应 `drag_started` / `dragging` / `drag_accepted`。松开事件的 `downId` 对应原生按下的 `id`，也用于对照 flow 收录结果。`before_ready`、`overlay` 和 `OUTSIDE_WINDOW` 分别表示就绪前、指示器范围内和 CLI 快照检查拒绝。激活分类根据回调时观察到的应用和窗口推断。日志包含会话期间的鼠标位置，适合只在专用测试时开启。

## 回放与核对

每轮从同一个测试文件的空白已保存状态开始。通过 TextEdit 清空正文并保存，核对磁盘文件为空；保持目标窗口唯一并等待回放完成。回放会物理点击，期间暂停鼠标键盘操作。为每次运行使用新报告名。

```sh
node dist/cli.js run out/recorded.flow.json --headed --report out/run-01.json --json
node dist/cli.js report pack out/run-01.json --flow out/recorded.flow.json \
  --out out/run-01.zip --json
unzip -t out/run-01.zip
```

每轮同时核对 JSON 中三步的顺序和状态，并逐字节比较磁盘文件与预期 ASCII 文本。记录每轮结果和报告文件。完成后关闭测试文档，将窗口控制权交还操作者。若失败，保存对应结果并停止后续输入。真实验收通过需达到十轮均通过。
