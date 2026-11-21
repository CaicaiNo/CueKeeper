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

解压 ZIP 后打开 `index.html` 可查看时间线。归档中的 `flow.json` 包含录制的文本。M1 将报告保存在本地。输出目录需事先存在，每次写入使用新文件名。

## 在 macOS 录制和回放

现场步骤和权限清单见 [TextEdit 验收](docs/textedit.md)。录制器单独构建。普通 `pnpm build` 只编译 TypeScript 并核对发布的 JSON Schema。实时 `--dry-run` 读取桌面可访问性树。带 `--snapshot` 的离线运行只读样本文件。

| 命令 | 用途 |
| --- | --- |
| `flow validate <flow.json>` | 检查 v1 结构、ID、行为引用和参数绑定 |
| `record --app <bundle-id> --window <精确标题> --out <flow.json>` | 录制目标窗口，显示计时 HUD，支持 `--no-indicator` 和 `--sound` |
| `run <flow.json> --dry-run` | 用当前窗口解析定位器 |
| `run <flow.json> --headed --report <report.json>` | 允许物理点击，回放并记录逐步结果 |
| `report pack <report.json> --flow <flow.json> --out <report.zip>` | 验证报告与流程配对，生成 ZIP |

所有命令支持 `--json`，标准输出提供单个 JSON 对象。错误有 `error.code` 和 `error.message`。生成的运行报告放在 `data` 中，失败报告的 `ok` 为 `false`。录制状态提示写标准错误。跳过其他应用输入时，录制成功结果带有 `data.warnings`。中断或跳过目标动作时，已有步骤保存至 `--out`，CLI 返回 `data.partial: true` 及原因。退出码为 `0` 完成、`1` 失败、阻塞或部分录制、`2` 输入文件或依赖错误、`130` 中断。

[架构与里程碑](docs/architecture.md)说明 schema、适配接口、录制限制与后续工作。
