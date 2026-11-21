# 离线报告包

`report pack` 把一次运行整理成可离线打开的 ZIP。查看器没有后端、没有网络请求，也不需要启动本地服务。

```sh
node dist/cli.js run out/recorded.flow.json --headed --report out/run-01.json --json
node dist/cli.js report pack out/run-01.json --flow out/recorded.flow.json \
  --out out/run-01.zip --json
unzip -t out/run-01.zip
```

把 ZIP 解压到任意空目录，双击 `index.html` 即可查看。`index.html` 自带样式和脚本，不依赖 `assets/` 中的查看器文件。

## 归档内容

| 路径 | 内容 |
| --- | --- |
| `index.html` | 静态查看器，已预渲染时间线与每一步详情 |
| `report.json` | 原始 v1 报告 |
| `flow.json` | 原始 v1 流程 |
| `manifest.json` | 每个文件的大小与 SHA-256，以及资产与步骤的对应关系 |
| `assets/` | 截图、日志、AX 快照等运行产物，可选 |

`report.json` 和 `flow.json` 先校验 schema 与流程摘要。报告与流程不匹配、或时间线顺序对不上时，打包会失败，不生成 ZIP。

## 查看器

- 顶部：流程名、运行状态、完成进度、总耗时、目标应用与窗口。
- 左侧：按报告顺序排列的动作时间线，显示类型、状态、相对时间和耗时；`只看失败` 可过滤。
- 右侧：失败信息（错误码、期望、实际、定位器、送达状态、重试记录）、断言、截图、目标与日志。
- 失败或阻塞的步骤在打开时自动选中并展开；其余步骤默认折叠。
- `断流预览` 打开断流横幅，并把最后一步标记为「最后已知」。也可以在 URL 后加 `#disconnected` 直接进入该状态。报告最后一条的 `code` 为 `INTERRUPTED` 或 `STREAM_DISCONNECTED` 时，会自动进入断流态。
- 选中的步骤、失败的过滤状态和日志折叠状态保存在 `localStorage`。再次打开同一报告会显示「已恢复上次视图」。收件人首次打开时不会有这个提示。
- `↑` / `↓` 在时间线中切换步骤。

所有按钮都只操作本地 DOM。`报告 JSON` 与 `流程 JSON` 下载的是同一归档里的文件。

## 资产约定

把文件放在报告旁边的 `assets/` 目录（或通过 `--assets <dir>` 指定），打包时自动带入：

```text
out/run-01.json
out/assets/click-body/before.png
out/assets/click-body/after.png
out/assets/click-body/step.log
out/assets/click-body/ax.json
out/assets/logs/runner.log
```

- `assets/<步骤 ID>/...` 会挂到对应步骤的详情里。截图按文件名中的 `before` / `after` 区分；`.log` 与 `.txt` 作为日志预览；`.json` 作为 AX 快照预览；其他文件列出下载链接。
- 不以步骤 ID 开头的文件作为「运行产物」显示在左侧底部。
- 没有 `assets/` 时也能打包。缺少截图或日志时，详情里显示明确说明，不伪造内容。
- 同一个目标路径出现两次会报错，符号链接不会被跟随。

## Shell 步骤

`kind: "shell"` 的条目带一个封闭的 `shell` 对象：

| 字段 | 内容 |
| --- | --- |
| `mode` | `argv`（默认）或 `shell`（显式脚本） |
| `privilege` | `user`、`sudo` 或 `root` |
| `privilegeMode` | 仅 root 步骤：`prompt`（管理员密码框）或 `sudoers`（无人值守白名单） |
| `execution` | `preview`、`not-run`、`finished`、`terminated` 或 `unknown` |
| `exitCode` / `signal` | 二者互斥；只记录真实退出码或被终止的信号 |
| `cleanup` | 终止后按进程组回收的结果：`complete` 或 `unknown` |
| `stdout` / `stderr` | `{ kind, bytes, truncated, text? }`，每流最多 16 KiB |
| `warnings` | 仅 `SHELL_OUTPUT_TRUNCATED`，不覆盖原退出或取消结果 |

- 文本采集默认关闭。CLI 用 `--capture-shell-output` 单次开启，工作台在运行确认中单独勾选。
- 存在 Shell 秘密引用、测试秘密绑定或任一提权步骤时，只保留输出元数据（`kind: "omitted"`），不写文本。
- 报告和错误信息不记录原始 `argv`、脚本、环境变量值或工作目录。命令只在本机的源 flow 编辑与运行确认界面上显示。
- 含 NUL 或无效 UTF-8 的流标记为 `binary`，只记录字节数与截断状态。
- 缺少实时运行许可时，报告状态为 `blocked`，对应步骤带 `SHELL_NOT_ALLOWED` 或 `SHELL_PRIVILEGE_REQUIRED`，其余步骤为 `skipped`。管理员取消或密码框超时用 `SHELL_PRIVILEGE_CANCELLED`，无法弹出密码框用 `SHELL_PRIVILEGE_UNAVAILABLE`。
- root 步骤只记录 `privilege`、`privilegeMode`、`execution` 与退出码；特权命令的 stdout/stderr 永不进入报告。说明见 [Root 步骤与管理员授权](shell-security.md)。

含 Shell 定义的流程（包括尚未调用的行为）不能使用 `report pack`。打包会把原始 flow 写进 ZIP，而首版不允许发布命令与秘密引用；这类运行仍可用 `--report` 写 JSON，并在工作台查看。

## 会话视频（可选）

运行可以用 `--video --report <run.json>` 额外录一段目标窗口的会话视频。采集器把电影写到报告旁的 `media/session.mp4`，元数据写到 `media/video.json`；`report pack` 会把它带进归档的 `media/`，并在 `manifest.json` 的 `video` 里记录编码、时长、track 时间刻度、与报告的锚点（`atMs` → PTS）和采样阈值。设计、体积实测与实现落点见 [会话视频：帧差采样 + VFR + 时间线对齐](session-video.md)。

- **默认关闭**，只在显式开启的运行里存在；`report.json` 不变，视频不参与通过/失败判断。
- 没有视频的报告照旧打开，查看器显示「本报告未录制会话视频」；`status: "skipped"` 时显示封闭枚举的原因（例如未授权屏幕录制），不显示空播放器。
- 有视频时查看器显示 `<video>` 面板；点时间线任一步会把视频 seek 到 `(atMs - videoStartOffsetMs)`，空闲段停在最后一帧。
- `media/` 超过 128 MB 给出警告，超过 512 MB 拒绝打包；`report pack --no-media` 显式剔除电影（`manifest.video` 一并省略）。
- 运行中可暂停：`kill -USR1 <cuekeeper pid>` 暂停、`kill -USR2 <cuekeeper pid>` 继续。暂停期间画面停在最后一帧，`pausedMs` 记入 `manifest.video`，但不扣减 `durationMs`。
- 采集失败不会留下半截文件：`.partial.mp4` 只在 `finishWriting` 成功后改名，编码失败会删除它并把原因写进 `manifest.video.code`。
- ZIP 没有加密：谁拿到归档谁能看里面的视频，等于看到了目标窗口在那段时间里显示的一切。

## v1 报告的降级

前置条件触发修复时，`kind: "setup"` 的条目记录可选的 `repair`，包含 `attempted`、`kind` 和 `result`。条目 ID 仍为 `<作用域>/setup/<条件 ID>`。执行或观测失败时，条目码为 `ENSURE_FAILED`，`repair.code` 保留具体原因，例如 `APP_NOT_FOUND`、`LAUNCH_TIMEOUT`、`WINDOW_NOT_FOUND` 或系统权限错误。复查仍不满足时，条目码为 `PRECONDITION_FALSE`。

报告没有截图、重试记录或断流字段时：

- 截图区显示「报告未包含该步截图」以及放置路径。
- 重试区显示「报告未记录重试」。
- 断流态通过预览开关或报告末条的 `INTERRUPTED` 错误码进入。
- 期望值来自 `flow.json` 中的 `assert` / `wait` / `setup` 检查，实际值使用报告的 `message`。
