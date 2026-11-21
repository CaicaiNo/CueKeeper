# Cuekeeper

Cuekeeper 把桌面操作录成可编辑的 JSON 流程，再按可访问性树定位控件、回放并生成离线报告。M1 提供命令行入口，目标平台为 macOS。执行器固定使用 agent-desktop 1.3.1。流程、报告和离线验证可跨平台使用。

## 构建与离线验证

需要 Node.js 22+ 和 pnpm 10。以下命令使用仓库自带的 TextEdit 树样本检查定位器和报告。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
node dist/cli.js flow validate examples/textedit.flow.json --json

mkdir -p out
node dist/cli.js run examples/textedit.flow.json --dry-run \
  --snapshot examples/textedit.snapshot.json --report out/textedit-dry.json --json
node dist/cli.js report pack out/textedit-dry.json \
  --flow examples/textedit.flow.json --out out/textedit-dry.zip --json
unzip -t out/textedit-dry.zip
```

解压 ZIP 后打开 `index.html` 可查看运行摘要、动作时间线和每一步的详情。查看器完全离线，失败步骤会自动展开，断流态可预览，选中的步骤会在下次打开时恢复。截图、日志和 AX 快照可按步骤放进 `assets/` 一并打包，格式见 [离线报告包](docs/report.md)。归档中的 `flow.json` 包含录制的文本。M1 将报告保存在本地。输出目录需事先存在，每次写入使用新文件名。

## 本地工作台

在终端运行以下命令，然后手动打开打印的本机地址。用 `Ctrl+C` 关闭工作台。

```sh
pnpm build
node dist/cli.js workbench /path/to/run-directory
```

也可以省略目录，进入工作台后用「导入运行目录」选择。目录必须有 `flow.json` 或 `recorded.flow.json`。可同时放入以下文件。

| 文件 | 工作台用途 |
| --- | --- |
| `report.json` | 校验与 flow 配对，显示回放或离线运行时间 |
| `actions.json` | 提供录制时间、应用、窗口和缩略图索引 |
| `snapshot.json` | 提供同一目标窗口的 agent-desktop 2.6 快照，支持重新拾取和离线运行 |

`actions.json` 使用 `{"version":1,"flowId":"…","durationMs":1800,"actions":[{"id":"step-1","atMs":240,"durationMs":35,"thumbnail":"images/step-1.png"}]}`。动作 ID 使用流程的展开 ID。可选的 `app` 和 `window` 默认取自 flow。旧录制缺少时间或图片时，工作台会显示现有的数据。v1 测试项仍绑定一个目标窗口，其他应用或窗口的动作可筛选和复盘。

在时间线勾选动作并「合并为行为」。可将输入提取为 `string` 或 `secret` 参数。行为库保存在 `~/.cuekeeper/behaviors`，可用 `--library <directory>` 切换。引用在草稿中保留行为标识，复制会为草稿生成独立定义。也可直接加入动作、添加断言或修改定位器，然后在草稿中调整顺序。

保存会在运行目录生成可由 CLI 读取的文件。普通测试项输出 `test-*.flow.json`。含 secret 的项输出版本化的 `test-*.test.json`，CLI `flow validate` 和 `run` 都接受。为 secret 参数填写 `CUEKEEPER_SECRET_*` 环境变量名，在实时回放前通过当前终端环境提供值。文件中只保存绑定和变量名。带 `--snapshot` 的离线解析无须注入文本。

```sh
node dist/cli.js flow validate /path/to/test.flow.json --json
node dist/cli.js run /path/to/test.flow.json --dry-run --snapshot /path/to/snapshot.json --json
```

工作台在本机监听。离线模式只读快照。实时回放需要 macOS、`--allow-live-replay` 启动选项和界面中的目标窗口确认。含坐标点击的测试项由 CLI 使用 `--headed` 回放。

### 从快照拾取元素

不录制也能把动作绑定到目标控件。`pick` 只读取窗口快照，不点击、不抢焦点，也不改变前台窗口。

```sh
node dist/cli.js pick --app com.apple.TextEdit --window Cuekeeper-M1.txt --json
node dist/cli.js pick --app com.apple.TextEdit --window Cuekeeper-M1.txt --select e1 --json
```

不带 `--select` 时按可交互元素优先列出候选，每项含 `ref`、`role`、`name`、`path`、`bounds` 和 `point`。`ref` 可用完整值（`@scuekeeper:e1`）或结尾序号（`e1`）。带 `--select` 时输出 `locator`，可直接作为 `click.target` 或 `type.target` 写入 flow，并通过 `flow validate`；`point` 和 `frame` 只用于核对位置。加 `--snapshot <snapshot.json>` 可对保存的快照离线拾取，便于先在没有图形界面时检查候选。工作台动作详情的「重新拾取」使用同一套候选与定位器逻辑。

## 在 macOS 录制和回放

现场步骤和权限清单见 [TextEdit 验收](docs/textedit.md)。录制器单独构建。普通 `pnpm build` 只编译 TypeScript 并核对发布的 JSON Schema。实时 `--dry-run` 读取桌面可访问性树。带 `--snapshot` 的离线运行只读样本文件。

| 命令 | 用途 |
| --- | --- |
| `flow validate <flow.json>` | 检查 v1 结构、ID、行为引用和参数绑定 |
| `record --app <bundle-id> --window <精确标题> --out <flow.json>` | 录制目标窗口，显示计时 HUD，支持 `--no-indicator` 和 `--sound` |
| `pick --app <bundle-id> --window <精确标题> [--select <ref>] [--snapshot <snapshot.json>]` | 只读快照，按可交互元素优先列出候选，或输出可写入 flow 的定位器 |
| `run <flow.json> --dry-run` | 用当前窗口解析定位器 |
| `run <flow.json> --headed --report <report.json>` | 允许物理点击，回放并记录逐步结果 |
| `report pack <report.json> --flow <flow.json> --out <report.zip>` | 验证报告与流程配对，生成可离线打开的 ZIP；`--assets <dir>` 带入截图、日志和 AX 快照 |

默认在主屏显示边框和 HUD。窗口服务器确认面板后，HUD 显示「录制就绪」，终端在标准错误输出 `INDICATOR_READY`。录制时可切到飞书等其他应用，返回目标窗口后继续，已捕获的动作会保留。`Ctrl+Option+P` 暂停或继续，`Ctrl+Option+X` 停止并保存。可用 `--no-indicator` 关闭边框和 HUD，热键仍可用。

所有命令支持 `--json`，标准输出提供单个 JSON 对象。错误有 `error.code` 和 `error.message`。生成的运行报告放在 `data` 中，失败报告的 `ok` 为 `false`。录制状态提示写标准错误。正常结束且有有效动作时，CLI 返回 `ok: true`，跳过的事件记录在 `data.warnings`。录制失败或中断时，已有步骤保存至 `--out`，CLI 返回 `data.partial: true` 及原因。没有有效动作时返回错误。退出码为 `0` 完成、`1` 失败、阻塞或部分录制、`2` 输入文件或依赖错误、`130` 中断。

[架构与里程碑](docs/architecture.md)说明 schema、适配接口、录制限制与后续工作。
