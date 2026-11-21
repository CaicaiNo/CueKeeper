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

## v1 报告的降级

查看器不扩展 `schemas/report.schema.json`。报告没有截图、重试记录或断流字段时：

- 截图区显示「报告未包含该步截图」以及放置路径。
- 重试区显示「报告未记录重试」。
- 断流态通过预览开关或报告末条的 `INTERRUPTED` 错误码进入。
- 期望值来自 `flow.json` 中的 `assert` / `wait` / `setup` 检查，实际值使用报告的 `message`。
