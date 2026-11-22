# Cuekeeper

Cuekeeper 把桌面操作录成可编辑的 JSON 流程，再按可访问性树定位控件、回放并生成离线报告。M1 提供命令行入口，目标平台为 macOS。执行器固定使用 agent-desktop 1.3.1。流程、报告和离线验证可跨平台使用。

## 安装

### 从发布包安装（推荐，无需 Node 和 pnpm）

发布产物是自包含目录包 `cuekeeper-<version>-macos-<arch>.tar.gz`，内含 CLI、工作台静态资源、预编译录制器和 Node 运行时。平台为 macOS，架构与产物名一致。

```sh
# 1. 校验下载产物（.sha256 文件与包同目录）
shasum -a 256 -c cuekeeper-<version>-macos-<arch>.tar.gz.sha256

# 2. 解到用户目录，不要用 sudo
mkdir -p ~/Applications
tar -xzf cuekeeper-<version>-macos-<arch>.tar.gz -C ~/Applications
export PATH="$HOME/Applications/cuekeeper-<version>-macos-<arch>/bin:$PATH"

# 3. 自检：Node 运行时、文件完整性、agent-desktop、录制器与权限
cuekeeper doctor
```

`doctor` 全部 `[ok ]` 后即可录制。它只读取状态：不弹授权框、不打开应用、不占用桌面。缺 `agent-desktop` 时按提示安装 1.3.1——Cuekeeper 锁定该版本，其他版本会拒绝执行。缺辅助功能或输入监控权限时，终端会打印系统设置直达入口与逐步说明，手动授权后重新运行 `cuekeeper doctor`；`record` 启动前也会做同样的自检，缺权限时以退出码 `2` 结束并给出同一份说明。

首次打开未签名产物时 macOS 会拦截。发布包没有 Developer ID 签名，也没有公证：右击产物 → 打开，或在「系统设置 → 隐私与安全性」中选择「仍要打开」；也可以在终端移除隔离属性后重试：

```sh
xattr -dr com.apple.quarantine ~/Applications/cuekeeper-<version>-macos-<arch>
```

升级：下载新版本，解到同一路径覆盖安装。保持路径不变，macOS 才会沿用录制器的权限授权。卸载：删除该目录即可；行为库留在 `~/.cuekeeper`，需要时手动删除。没有自动更新服务。

产物结构、打包命令、校验和、版本命名与签名边界见 [打包与分发](docs/packaging.md)。

### 从源码运行（开发者）

需要 macOS、Node.js 22+ 和 pnpm 10.28.2。GitHub Actions 在 `macos-latest` 上执行相同的安装、构建、测试和录制器编译，工作流见 `.github/workflows/ci.yml`。

```sh
git clone git@github.com:CaicaiNo/CueKeeper.git
cd CueKeeper
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

录制（首次使用先运行 `node dist/cli.js doctor` 检查环境；需要 macOS 辅助功能和输入监控权限，步骤见 [TextEdit 验收](docs/textedit.md)）：

```sh
pnpm build:recorder
node dist/cli.js record
```

不带 `--app`、`--window`、`--out` 时是「一键开始」：先倒计时 3 秒（`--countdown` 可调，`0` 表示不等待），提示切到要录制的 App 窗口；倒计时结束读取当前前台窗口，用窗口属主应用的 bundle ID 和精确窗口标题作为流程目标。录制结束（`Ctrl+Option+X` 提前结束，或 `--seconds` 超时）后，流程写到 `~/.cuekeeper/recordings/recording-<UTC 时间戳>.flow.json`，终端打印绝对路径和查看命令：

```sh
cuekeeper workbench ~/.cuekeeper/recordings
```

工作台会打开该目录里最新的 `recording-*.flow.json`。显式参数仍然可用，作为脚本或固定目标的进阶用法：

```sh
mkdir -p out/demo
node dist/cli.js record --app com.apple.TextEdit --window "无标题" --out out/demo/recorded.flow.json --seconds 30
# 只给 --app 时录该 App 的前台窗口；指定安装副本时加 --app-path "/Applications/TextEdit.app"
```

`--seconds` 默认 25（范围 1–90）。倒计时结束时没有前台窗口报 `WINDOW_NOT_FOUND`，无法确认窗口所属应用的 bundle ID 报 `APP_NOT_FOUND`。当前仍是单窗口录制：切到其他 App 后，那些窗口的输入会被跳过；跨 App 全局录制见 HAOC-108。

回放与报告。下面的离线命令使用仓库自带样本，不需要桌面权限，可直接验证安装：

```sh
mkdir -p out/demo
cp examples/textedit.flow.json out/demo/flow.json
node dist/cli.js run examples/textedit.flow.json --dry-run \
  --snapshot examples/textedit.snapshot.json --report out/demo/report.json --json
node dist/cli.js report pack out/demo/report.json \
  --flow examples/textedit.flow.json --out out/demo/report.zip --json
unzip -t out/demo/report.zip
```

录制流程的实时回放先干跑确认定位器，再加 `--headed` 执行物理点击：

```sh
node dist/cli.js run out/demo/recorded.flow.json --dry-run --json
node dist/cli.js run out/demo/recorded.flow.json --headed --report out/demo/recorded-report.json --json
```

固定应用路径的流程还需要 `pnpm build:recorder` 生成的原生身份查询程序 `dist/cuekeeper-identity`。它只读取进程、进程启动标识和窗口归属，不安装事件监听，也不申请辅助功能或输入监控权限。

工作台读取 `flow.json`、`recorded.flow.json`、`report.json` 等同目录文件（终端会打印本机地址，手动打开，`Ctrl+C` 关闭）：

```sh
node dist/cli.js workbench out/demo
```

可选：`pnpm link --global` 后可直接用 `cuekeeper` 代替 `node dist/cli.js`，不需要其他全局依赖。发布包用 `pnpm package` 生成，详细参数见 [打包与分发](docs/packaging.md)。

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

也可以省略目录，进入工作台后用「导入运行目录」选择。目录必须有 `flow.json` 或 `recorded.flow.json`；只有 `record` 默认生成的 `recording-*.flow.json` 时，工作台打开其中最新的一份。可同时放入以下文件。

| 文件 | 工作台用途 |
| --- | --- |
| `report.json` | 校验与 flow 配对，显示回放或离线运行时间 |
| `actions.json` | 提供录制时间、应用、窗口和缩略图索引 |
| `lifecycle.json` | 提供下载、安装、卸载事件，用于提出待确认的 `wait` 候选；`record --global` 会在有事件时自动写 |
| `snapshot.json` | 提供同一目标窗口的 agent-desktop 2.6 快照，支持重新拾取和离线运行 |

`actions.json` 使用 `{"version":1,"flowId":"…","durationMs":1800,"actions":[{"id":"step-1","atMs":240,"durationMs":35,"thumbnail":"images/step-1.png"}]}`。动作 ID 使用流程的展开 ID。可选的 `app` 和 `window` 默认取自 flow。旧录制缺少时间或图片时，工作台会显示现有的数据。v1 测试项仍绑定一个目标窗口，其他应用或窗口的动作可筛选和复盘。

v2 会话可从 `lifecycle.json` 的下载、安装、卸载事件提出候选等待，在「前置条件」区逐个确认后写入 `flow.with-waits.json`，并保留原 `flow.json`。事件没有位置或时间证据时不提候选，空闲段不会被当作等待条件。`record --global` 默认在录制期间只读观察 `~/Downloads` 与 `~/Applications`、`/Applications`，把下载完成、安装、卸载写成 `lifecycle.json`（`--no-lifecycle` 关闭；目录可用 `CUEKEEPER_LIFECYCLE_DOWNLOAD_DIRS`、`CUEKEEPER_LIFECYCLE_APP_DIRS` 指定），每条事件带 `afterStepId`，因此无需手写。下载完成会提出等待文件本身（`file_stable`）的候选，不依赖下载界面元素。等待执行、安装/下载证据与错误码见 [条件等待](docs/waiting.md)。

在时间线勾选动作并「合并为行为」。可将输入提取为 `string` 或 `secret` 参数。行为库保存在 `~/.cuekeeper/behaviors`，可用 `--library <directory>` 切换。引用在草稿中保留行为标识，复制会为草稿生成独立定义。也可直接加入动作、添加断言或修改定位器，然后在草稿中调整顺序。

导入运行目录后，工作台按流程目标与每个动作的应用、窗口自动推断前置条件：首次出现的应用生成「应用已启动」（`app_running`），首次出现的窗口生成「窗口已就绪」（`window_ready`），状态均为待确认（`inferred`）。已有的条件不会重复推断，已删除的条件也不会再次出现。左侧「前置条件」区可确认、更换应用或窗口（更换后回到待确认）、删除和撤销。`record` 保存的流程同样带有这两条推断建议。

保存只写入已确认的条件；待确认、已失效和已删除的条件不会进入测试项。若手工构造的测试项仍带有未确认条件，回放会为每条条件记一条跳过结果，且不执行修复动作。

保存会在运行目录生成可由 CLI 读取的文件。普通测试项输出 `test-*.flow.json`。含 secret 的项输出版本化的 `test-*.test.json`，CLI `flow validate` 和 `run` 都接受。为 secret 参数填写 `CUEKEEPER_SECRET_*` 环境变量名，在实时回放前通过当前终端环境提供值。文件中只保存绑定和变量名。带 `--snapshot` 的离线解析无须注入文本。

```sh
node dist/cli.js flow validate /path/to/test.flow.json --json
node dist/cli.js run /path/to/test.flow.json --dry-run --snapshot /path/to/snapshot.json --json
```

工作台在本机监听。离线模式只读快照。实时回放需要 macOS、`--allow-live-replay` 启动选项和界面中的目标窗口确认。含坐标点击的测试项由 CLI 使用 `--headed` 回放。

### Shell 步骤

`kind: "shell"` 的步骤在用户态串行执行命令，可与 UI 动作混排。默认形态 `argv` 把数组逐项交给 `spawn`，不经过 shell；`shell: true` 时必须用 `command`，固定通过 `/bin/sh -c` 启动非登录 shell。契约见 [Shell 步骤设计](docs/shell-steps.md)，命令与参数不写入报告。

```sh
node dist/cli.js run /path/to/shell.flow.json --allow-shell --json
node dist/cli.js run /path/to/shell.flow.json --dry-run --json
node dist/cli.js run /path/to/test.json --allow-shell --allow-sudo --capture-shell-output --report out/run.json
node dist/cli.js run /path/to/root.flow.json --allow-shell --allow-sudo --interactive --report out/run.json
node dist/cli.js sudo set                 # 一次性保存管理员密码到登录钥匙串
node dist/cli.js run /path/to/root.flow.json --allow-shell --allow-sudo --non-interactive
```

- 实时执行必须显式给 `--allow-shell`；`privilege: "sudo"` 的固定任务与 `privilege: "root"` 的 root 步骤另需 `--allow-sudo`，固定任务首版仍按禁用处理，真实提权留给 HAOC-76 真机验收。
- `privilege: "root"` + `privilegeMode: "prompt"`（默认）每次运行弹原生密码框，必须再加 `--interactive`；与 `--json` 互斥（`--dry-run` 预览除外）。`privilegeMode: "sudoers"` 走 `sudo -n` 无人值守白名单，未授权时明确阻塞。密码不落盘、不进报告，风险说明见 [Root 步骤与管理员授权](docs/shell-security.md)。
- `--non-interactive` 或 `privilegeMode: "keychain"` 从登录钥匙串读取 `cuekeeper sudo set` 保存的管理员密码，不弹框；缺凭据报 `SUDO_CREDENTIAL_MISSING` 并阻塞，不会回退弹框。`cuekeeper sudo status` 只查元数据，`cuekeeper sudo clear` 删除该项。
- `--dry-run` 只输出静态计划（步骤 ID、模式、权限），不解析秘密、不启动 shell 或 sudo；纯 Shell 流程无需 `--snapshot`。
- 输出文本默认不采集；`--capture-shell-output` 单次开启。存在秘密引用或提权步骤时只保留元数据。
- 含 Shell 定义的 flow 不能 `report pack`，仍可 `--report` 写 JSON 并在工作台查看。
- 工作台启动加 `--allow-shell`（提权再要 `--allow-sudo`），运行前展示展开计划并用一次性令牌确认；「停止」取消当前运行与剩余步骤。

### 从快照拾取元素

不录制也能把动作绑定到目标控件。`pick` 只读取窗口快照，不点击、不抢焦点，也不改变前台窗口。

同一应用装有多份副本时，`record` 与 `pick` 的 `--app-path` 指定其中一个。录制只在握手确认窗口 owner 的 PID、进程启动标识和规范 `bundleURL` 后写入该路径；回放按路径锁定实例，之后只用窗口 ID 发送输入，不再按 bundle ID 或全局前台猜测。路径失效返回 `APP_PATH_INVALID`，路径不符或同标识多实例返回 `APP_AMBIGUOUS`，固定路径流程中的裸坐标返回 `UNSAFE_POINT`。若流程先安装、后使用该 App，pin 路径在启动时还不存在也不会提前失败：该 App 的预检延后到首次真正使用（`launch_app`、`activate_app`、`focus_window`、窗口输入/断言），安装完成后在该路径重新核对 bundle ID 才继续；首次使用时仍不存在就在该步返回 `APP_PATH_INVALID`，不会改绑同 bundle 的其他副本。

```sh
node dist/cli.js pick --app com.apple.TextEdit --window Cuekeeper-M1.txt --json
node dist/cli.js pick --app com.apple.TextEdit --window Cuekeeper-M1.txt --select e1 --json
```

不带 `--select` 时按可交互元素优先列出候选，每项含 `ref`、`role`、`name`、`path`、`bounds` 和 `point`。`ref` 可用完整值（`@scuekeeper:e1`）或结尾序号（`e1`）。带 `--select` 时输出 `locator`，可直接作为 `click.target`、`type.target` 或 `scroll.target` 写入 flow，并通过 `flow validate`；`point` 和 `frame` 只用于核对位置。加 `--snapshot <snapshot.json>` 可对保存的快照离线拾取，便于先在没有图形界面时检查候选。工作台动作详情的「重新拾取」使用同一套候选与定位器逻辑。

## 在 macOS 录制和回放

现场步骤和权限清单见 [TextEdit 验收](docs/textedit.md)。录制器单独构建。普通 `pnpm build` 只编译 TypeScript 并核对发布的 JSON Schema。实时 `--dry-run` 读取桌面可访问性树。带 `--snapshot` 的离线运行只读样本文件。

| 命令 | 用途 |
| --- | --- |
| `doctor [--json]` | 只读自检：Node 运行时、文件完整性、agent-desktop 版本、录制器与辅助功能/输入监控权限；末行为下一步 |
| `--version` | 打印版本，发布包还带构建提交 |
| `flow validate <flow.json\|test.json>` | 检查 v1 结构、ID、行为引用和参数绑定；v2 则校验每步 scope、windowKey 绑定、appPaths/inputs/intent 引用，含缺口时拒绝 |
| `record [--app <bundle-id>] [--window <精确标题>] [--out <flow.json>] [--app-path <路径>] [--countdown 3]` | 默认倒计时后录制当前前台窗口，流程写入 `~/.cuekeeper/recordings`；显式参数优先。显示计时 HUD，支持 `--no-indicator`、`--sound` 与显式开启剪贴板文本的 `--clipboard` |
| `record --global [--max-seconds 600] [--out <flow.json>] [--exclude <bundle-ids>] [--no-lifecycle]` | 跨 App 全局录制，生成 v2 flow；录制期间只读观察下载与安装，把生命周期事件写入 flow 同目录的 `lifecycle.json`（`--no-lifecycle` 关闭） |
| `pick --app <bundle-id> --window <精确标题> [--app-path <路径>] [--select <ref>] [--snapshot <snapshot.json>]` | 只读快照，按可交互元素优先列出候选，或输出可写入 flow 的定位器 |
| `run <flow.json> --dry-run` | 用当前窗口解析定位器；纯 Shell 流程无需快照 |
| `run <flow-v2.json> --dry-run [--report <report-v2.json>]` | 输出 v2 结构计划，按步骤 scope 标记 `resolved`；不启动、聚焦或输入 |
| `run <flow-v2.json> --foreground [--inputs <values.json>] [--headed] [--report <report-v2.json>]` | 跨 App 实时回放：按 scope 启动/激活、绑定窗口、每步确认前台后投递并核对投递状态；`--inputs` 提供 `input` 参数值 |
| `run <flow.json> --allow-shell [--allow-sudo] [--interactive|--non-interactive] [--capture-shell-output]` | 执行 Shell 步骤；固定任务首版禁用，root 步骤走密码框、sudoers 或登录钥匙串 |
| `sudo set\|status\|clear [--json]` | 保存 / 查询 / 删除登录钥匙串里的管理员凭据，供 `--non-interactive` 的 root 步骤使用 |
| `run <flow.json> --headed --report <report.json>` | 允许物理点击，回放并记录逐步结果 |
| `run <flow.json> [--input-source-switch [--input-source <id>] [--strict-ime]]` | 默认完全不管理输入法：不读、不切、不恢复，`type` 只做 Unicode 注入。加 `--input-source-switch` 才在英文文本前切到 ABC/U.S. 并在结束恢复原输入源；详见[输入法守卫](docs/ime.md) |
| `ime status\|list\|set\|restore\|unlock` | 查看当前输入源、手动切换、按 `ime.json` 恢复崩溃的运行 |
| `run <test.json> --data <rows.json> [--report <batch.json>]` | 每行覆盖行为调用参数后串行执行；报告写汇总与逐行 v1 报告 |
| `report pack <report.json> --flow <flow.json> --out <report.zip>` | 验证报告与流程配对，生成可离线打开的 ZIP；`--assets <dir>` 带入截图、日志和 AX 快照；配置上传后自动入队 |
| `report upload [--queue <dir>] [--retry-paused]` | 处理本地上传队列；暂停项修复原因后用 `--retry-paused` 手动继续 |
| `serve --config <server.json> --data <dir>` | 启动自建上传服务；列表、下载、查看器接口见[上传服务](docs/server.md) |

v2 flow 顶层没有 `target`，每一步用 `scope` 声明窗口、应用或系统界面；`windowKey` 在 flow 内绑定一个 App，标题变化后仍跟随同一窗口。契约、报告和哈希定义见 `schemas/flow-v2.schema.json` 与 `schemas/report-v2.schema.json`。批量、报告打包和工作台运行仍只支持 v1，遇到 v2 会以 `UNSUPPORTED_FLOW_VERSION` 停止；工作台可以按 scope 分组复盘 v2 时间线。

v2 实时回放需要显式 `--foreground`，因为它会跨 App 抢前台并注入输入。运行时一次只持有一个前台租约（`~/.cuekeeper/run.lock`，可用 `CUEKEEPER_STATE_DIR` 改目录），取消、失败和正常结束都会释放。每步先按 `windowKey` 绑定进程实例与原生窗口号，再确认前台；窗口被移动或改名不影响绑定，同名新窗口不会接管旧 `windowKey`，进程重启、路径错误副本和人工切走分别以 `APP_AMBIGUOUS`、`APP_PATH_INVALID`、`FOCUS_INTERRUPTED` 停在原步骤。

密码与系统授权界面不中止整条录制：连续 secure 区间折叠成一个 `manual_checkpoint`，区间内的按键、文本、截图和剪贴板一律丢弃，系统授权界面（Security Agent）不作为可回放的作用域。回放暂停后由操作者在真实界面完成授权或输入密码，再回到运行终端输入 `continue` 独立确认；CueKeeper 只验证系统 secure 状态已清除且 `resume` 的只读条件成立，默认等待 120 秒。取消、超时或无法证实恢复都会停在该检查点，后续步骤不执行，报告只记录检查点、触发步、恢复条件与结果。含检查点的 flow 需要交互式终端，`--json` 会在任何桌面操作前以 `MANUAL_CHECKPOINT_REQUIRED` 拒绝；secure 状态探测和录制一样来自 `pnpm build:recorder` 构建的 helper。密码、Keychain 内容和授权值不进入 flow、报告、日志或 argv。

macOS 全局录制也会把 `CoreServicesUIAgent` 的可见弹框（包括由该系统进程显示的 Gatekeeper 安全提示）保存为人工检查点，原因是 `system_dialog`。例如从 Finder 双击 `.pkg` 后，录制会把弹框检查点放在该双击之后。回放先等待检测到弹框，操作者处理后在运行终端输入 `continue`，CueKeeper 确认弹框关闭、secure 状态清除且恢复条件成立后才继续。只记录弹框的出现与消失，弹框的文案和操作留在桌面界面。使用此功能需要重新构建录制 helper。

默认在主屏显示边框和 HUD。窗口服务器确认面板后，HUD 显示「录制就绪」，终端在标准错误输出 `INDICATOR_READY`。录制时可切到飞书等其他应用，返回目标窗口后继续，已捕获的动作会保留。`Ctrl+Option+P` 暂停或继续，`Ctrl+Option+X` 停止并保存。可用 `--no-indicator` 关闭边框和 HUD，热键仍可用。

批量执行用 `--data <rows.json>` 一次跑多行数据，格式见[参数化批量执行设计](docs/batch-run.md)。每行只覆盖列名指向的调用参数，其余沿用测试项；`--report <batch.json>` 写汇总，并在同级 `<batch.json>.rows/row-NNNNNN/` 保存逐行 v1 报告与绑定后的 flow，可直接用 `report pack` 单独打包：

```sh
node dist/cli.js run out/demo/login.test.json --data out/demo/accounts.json \
  --report out/demo/batch.json --headed --json
node dist/cli.js report pack out/demo/batch.json.rows/row-000001/report.json \
  --flow out/demo/batch.json.rows/row-000001/flow.json --out out/demo/row-1.zip --json
```

所有命令支持 `--json`，标准输出提供单个 JSON 对象。错误有 `error.code` 和 `error.message`。生成的运行报告放在 `data` 中，失败报告的 `ok` 为 `false`。录制状态提示写标准错误。正常结束且有有效动作时，CLI 返回 `ok: true`，跳过的事件记录在 `data.warnings`。录制失败或中断时，已有步骤保存至 `--out`，CLI 返回 `data.partial: true` 及原因。没有有效动作时返回错误。退出码为 `0` 完成、`1` 失败、阻塞或部分录制、`2` 输入文件或依赖错误、`130` 中断。`doctor` 用 `0` 表示全部检查通过、`1` 表示有检查失败；`record` 的启动自检使用 `2`，错误码为 `RECORDER_MISSING`、`RECORDER_UNUSABLE` 或 `PERMISSIONS_REQUIRED`。

[架构与里程碑](docs/architecture.md)说明 schema、适配接口、录制限制与后续工作。每个输入操作的录制、回放、离线测试、真机状态与错误码见[输入操作支持矩阵](docs/support-matrix.md)。报告上传的配置、队列与 CLI 用法见[报告上传客户端](docs/upload-client.md)。中文输入法对录制与物理按键的影响、默认不管理输入法的取舍与 `--input-source-switch` 的切换/恢复规则见[输入法守卫](docs/ime.md)。
