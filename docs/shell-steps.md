# CueKeeper Shell 步骤设计

HAOC-78 · 评审稿 · 首版目标为 macOS 本地执行

## 执行身份与使用范围

CLI、工作台、录制器和桌面适配器都以启动 CueKeeper 的非 root 用户运行。交互使用时是当前登录用户，CI 使用专用非管理员账号。新增 shell 执行入口拒绝以真实或有效 UID 0 运行。CLI 以输入 flow 或 test 文件所在的真实目录为基准，工作台以当前会话目录为基准，命令在步骤所在位置串行执行。

准备测试夹具、清理测试目录、启动用户级服务和发送测试 API 请求都用用户态。确有需要时，可将重启一个专用系统级测试服务、重置一个由 root 管理的测试夹具作为固定任务委托给管理员。系统级服务须由现有服务管理器接管生命周期。流程用显式步骤启停服务，失败停止后也要由环境自身清理测试状态。首版无需远程执行、容器编排或新增运行时依赖。

CueKeeper 整体使用 root 会让导入的命令、测试工作台和桌面适配器都获得管理员能力，还可能把报告、缓存和测试文件写成 root 属主。macOS 按应用或二进制身份管理 Accessibility、输入监控等隐私权限，UID 0 无法代替相应的授权或登录用户的图形会话。拒绝整机 root 模式。[Apple Accessibility 帮助](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac) · [Apple PPPC 文档](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web)

## Flow 契约

提供可应用的 Draft-07 JSON Patch，覆盖 flow 顶层动作、内嵌 behavior、独立 behavior 和 report。所有新增对象均封闭。`privilege: "root"` 与 `privilegeMode` 是 HAOC-82 的增补，权威定义以 `schemas/flow.schema.json` 与 `schemas/report.schema.json` 为准；`design/shell-steps/schema-diff.json` 保留为 HAOC-78 的原始补丁。`env` 只允许契约规定格式的动态键。现有分支和版本号保持原样，旧 flow、behavior 和 report 无需迁移。旧版 CueKeeper 会按未知动作拒绝含 shell 的文档。[Schema diff](../design/shell-steps/schema-diff.json)

| 字段 | 约束与行为 |
| --- | --- |
| `id`、`kind`、`setup` | 必填步骤 ID、`kind: "shell"`、可选的现有局部前置条件。全局 setup 仍先于动作，shell 自身无需窗口。第一次 UI 动作按现有规则绑定目标窗口。 |
| `argv` | 默认形态。数组首项是程序，其余项逐个按原值传入 `spawn`，最多 65 项。空参数有效。参数内的空格、引号、美元符号、分号和 glob 都按字面传递。程序名支持绝对路径、基于步骤 `cwd` 的带斜线相对路径，或由固定 PATH 解析的裸名称。 |
| `shell`、`command` | `shell` 省略或为 `false` 时必须提供 `argv`。仅 `shell: true` 可提供 `command`，用固定的 `/bin/sh -c` 启动非登录 shell。两种形态互斥。行为参数只维持原有输入动作绑定规则，规划器不把参数插入命令、路径或环境变量。 |
| `cwd` | 可选，默认输入文件或会话的基准目录。相对路径基于该目录解析，绝对路径允许并在运行前展示。规范化并检查目录存在，无法解析时报启动失败。该路径可由操作者指定，用户态执行没有文件系统沙箱。 |
| `env` | 最多 32 个大小写敏感的键。值为普通字符串或 `{"secretEnv":"CUEKEEPER_SECRET_FIXTURE_TOKEN"}`。运行前从宿主环境按名称解析引用，缺值时阻止启动。变量值中的 NUL 无效，执行前检查参数和环境合计 UTF-8 体积不超过 64 KiB。 |
| `timeoutMs`、`expectedExitCode` | 用户态默认 30,000 ms，可设 1–120,000 ms。预期退出码默认 0，可设 0–255。默认值在规划时计算，保留原输入与 flow hash。 |
| `privilege` | 默认 `"user"`。`"sudo"` 必须使用单元素 `argv`，绝对路径须符合 `/Library/CueKeeper/privileged/<任务 ID>` 且登记在本机管理员清单。该形态禁止传入 `cwd`、`env`、`timeoutMs` 和命令字符串，固定 30 秒任务期限，由管理员任务负责。 |
| `privilege: "root"`、`privilegeMode` | 以 root 执行逐项 `argv`，不接受 `shell: true`、`command` 或 `env`。`privilegeMode` 默认 `"prompt"`：每次运行弹原生密码框，需 CLI `--interactive` 或工作台运行确认；可选 `"sudoers"`：`sudo -n` 无人值守白名单。允许 `cwd`、`timeoutMs` 和 `expectedExitCode`。风险、授权与失败语义见 [Root 步骤与管理员授权](shell-security.md)。 |

用户态环境仅由 CueKeeper 建立的 `HOME`、`USER`、`LOGNAME`、`TMPDIR`、`LANG=C` 和固定 `PATH=/usr/bin:/bin:/usr/sbin:/sbin` 起步。HOME 与用户名取自运行账号，TMPDIR 由每次运行创建的私有临时目录提供。需要 Homebrew 或项目工具时填绝对路径。保留这些基础键以及 `SUDO_*`、`DYLD_*`、`LD_*`、`CUEKEEPER_*` 和 `NODE_OPTIONS`，禁止 flow 直接覆盖。宿主环境、登录配置和凭据只通过明确允许的输入进入步骤。子进程的 stdin 为 EOF，无交互终端。

```json
{
  "id": "prepare-fixture",
  "kind": "shell",
  "argv": ["/bin/sh", "./scripts/prepare-fixture.sh", "sample with spaces"],
  "cwd": "./fixtures",
  "env": { "FIXTURE_TOKEN": { "secretEnv": "CUEKEEPER_SECRET_FIXTURE_TOKEN" } },
  "timeoutMs": 15000
}
```

## 提权方案

| 方案 | 能力和成本 | 无人值守 |
| --- | --- | --- |
| **精确的 sudoers 白名单** | 推荐首版。专用普通账号只获准运行固定的 root 任务。机器管理员安装并维护策略，CueKeeper 使用系统自带的 `sudo`。权限集中在几个可审核的任务上。 | 仅限验收通过的 `NOPASSWD` 固定任务，并由任务配置显式授权。需要密码或 Touch ID 的 sudo 路径属于人工操作。 |
| **交互式 root（`sudo -A` + askpass）** | 首版交互路径。`sudo -A` 调用本地 helper，用 `osascript` 的 `display dialog … with hidden answer` 弹出原生密码框，密码只经过管道交给 sudo。每个 root 步骤认证一次，不缓存密码。适用于人工确认的特权命令。 | **不可无人值守。** 密码或 GUI 同意均需人在场；锁屏、SSH 与无图形会话会明确失败。 |
| **受限特权 helper** | 后续若需较多固定操作，使用签名的 launchd daemon 与 XPC，验证客户端身份，按操作 ID 和类型化参数授权。注册和分发成本较高。现代 macOS 优先评估 `SMAppService`，旧 `SMJobBless` 已弃用。 | 人工安装和系统批准 **不可无人值守**。安装完成后，只有无需提示且已授权的 XPC 操作可进入夜间任务。 |

[sudo 官方手册](https://github.com/sudo-project/sudo/blob/main/docs/sudo.man.in) · [sudoers 官方手册](https://github.com/sudo-project/sudo/blob/main/docs/sudoers.man.in) · [Apple Authorization Services](https://developer.apple.com/documentation/security/authorization-services) · [Apple Service Management](https://developer.apple.com/documentation/servicemanagement)

- 管理员在 CueKeeper 外安装每条固定任务与只读登记表，以 `visudo` 校验 `/etc/sudoers.d` 的精确策略。给指定账号授予单一绝对路径和 `""` 空参数匹配，使用 `NOPASSWD` 与 `NOSETENV`。省略 sudoers 的参数规则可能允许调用方附带任意参数。禁止通配符、开放解释器、任意命令转发和 `NOPASSWD: ALL`。登记表、可执行文件、父目录及其脚本、配置和依赖都由 root 管理，普通用户不可改写或替换。任务固定工作目录、环境、输入与服务名，避免关系到用户可写文件的间接执行。
- 安全预检校验登记、路径归属及可写性，拒绝符号链接组件。静态预检不验证 sudoers 的实际授权。实际执行只调用一次 `/usr/bin/sudo -n -k -u root -- <登记路径>`，使用固定环境、`cwd: /` 和关闭的 stdin。`-n` 禁止交互，带命令的 `-k` 忽略凭据缓存。部署要求关闭会触发交互的 sudo/PAM 配置。CueKeeper 不缓存凭据；这个固定任务形态不做 `sudo -v`、没有弹窗回退。需要交互式管理员授权的场景使用独立的 `privilege: "root"` 路径，见 [Root 步骤与管理员授权](shell-security.md)。
- 固定任务通过其 stdout 返回有界的开始和完成结构记录，下游程序与日志无法写入该通道。完成记录携带真实任务退出码、超时或取消结果。未收到开始记录时，sudo 拒绝或未能授权按 `SHELL_PRIVILEGE_REQUIRED` 处理，不根据 stderr 文案或 sudo 的退出码猜测业务结果。sudo 本身启动失败或收到开始后缺失有效完成记录按 `SHELL_START_FAILED` 处理，除非已确定取消或超时。
- 操作者必须信任用户态命令及其脚本依赖。执行门拦截 CueKeeper 从导入内容发起的执行和提权请求。获准的用户态代码具备该账号已有的系统权限，包括直接请求系统提权的能力。夜间运行使用无通用 sudo 权限的专用账号。

## 固定任务登记与协议（首版）

- 登记表固定在 `/Library/CueKeeper/privileged/registry.json`，由 root 维护：

  ```json
  {
    "version": 1,
    "tasks": {
      "reset-fixture": { "path": "/Library/CueKeeper/privileged/reset-fixture" }
    }
  }
  ```

- 预检逐项校验：任务 ID 与路径一致、登记项存在且路径完全相同、从特权根目录起没有符号链接组件、登记表与任务是属主为 root 的普通文件、组和其他用户不可写、任务对属主可执行。登记表本身不证明 sudoers 已授权。
- 执行只发起一次 `sudo -n -k -u root -- <登记路径>`，固定 `cwd: /`、固定 `PATH` 与 `LANG=C`、关闭 stdin。不传参数、不探测、不使用 `sudo -v`。
- 固定任务在 stdout 上写两行 NDJSON：

  ```json
  {"record":"start","task":"reset-fixture"}
  {"record":"finish","task":"reset-fixture","state":"finished","exitCode":0}
  ```

  只接受一条开始记录和一条完成记录；任务 ID 不符、缺少退出码、额外记录或非 JSON 行都按协议失败处理。stderr 与原始输出不进入报告。
- 未收到开始记录（sudo 拒绝或未授权）→ `SHELL_PRIVILEGE_REQUIRED`；sudo 本身无法启动，或已收到开始但缺少有效完成记录 → `SHELL_START_FAILED`。不根据 stderr 文案或 sudo 退出码猜业务结果。
- 固定任务默认关闭真实提权：CLI 与工作台注入的适配器继续把固定任务挡在预检。同一适配器只对 `privilege: "root"` 开放交互式密码授权；`sudoers` 形态在 HAOC-76 前保持禁用，尝试时以 `SHELL_PRIVILEGE_REQUIRED` 明确失败。协议解析、授权分支和失败分支由 mock 与假 askpass 在离线用例中覆盖；真实 sudo、PAM 与特权进程回收留给 HAOC-76。

## 运行门与工作台

1. **引入或编辑。** 工作台在导入 flow、test 或 behavior 时，展示 shell 的数量和提权标记，包括尚未调用的定义。保存、校验、导入以及查看报告均无副作用。在步骤列表的插入位置选择「Shell」，用逐项参数编辑器录入程序和参数。显式切到「Shell 脚本」后才显示脚本编辑器。步骤卡展示命令摘要、工作目录、用户态或「需管理员预配置」标记。编辑和确认界面可查看完整命令、解析后路径及环境键，秘密引用只显示变量名。录制产物仍从现有捕获动作生成。
2. **预检。** 从完整展开计划发现可达 shell 步骤，在桌面适配器初始化、前置条件修复或任何动作之前检查执行许可。CLI 实时运行必须有 `--allow-shell`，提权另需 `--allow-sudo`。缺任一授权即生成阻塞报告，给出对应步骤，其他动作跳过。离线预览无需执行许可。纯 shell 且无 AX 前置条件的 flow 无需初始化桌面适配器，保留 v1 必填的 `target` 以维持文档形状。
3. **再次确认。** 工作台实时运行沿用现有 live 启用门，并要求由启动参数开启 `--allow-shell`，涉及特权再开启 `--allow-sudo`。每次运行先展示展开步骤、解析后的命令和目录、权限等级、超时与输出采集状态，再确认执行。服务端发放短期、一次性确认令牌，绑定规范化后的 test、当前会话及执行计划。服务端校验未被修改并在启动前消费令牌，重新检查本机提权策略。前端勾选、导入提示和上一次授权均无法代替这次确认。命令引用的磁盘文件仍需操作者信任和管理。
4. **root 提权。** `privilege: "root"` 的 `prompt` 形态在 CLI 还需 `--interactive`，`--json` 与之互斥（`--dry-run` 预览除外），不静默降级；工作台用运行确认与一次性计划令牌作为二次确认。`sudoers` 形态只走 `sudo -n`，未授权时在预检阶段阻塞。执行任一 root 步骤前展示完整程序、参数与工作目录，报告只保留元数据。
5. **预览。** `--dry-run` 只为 shell 展示静态计划，标明「未执行」，无需解析秘密或启动 shell、sudo、提权任务。CLI 干跑报告显示步骤 ID、模式与权限，工作台本地预览显示完整命令与目录。含 shell 的混合流程以保存的 `--snapshot` 检查 UI 部分，工作台使用导入的快照。缺快照时给出输入错误。只有无 AX 前置条件的纯 shell 流程可直接离线预览。后续 UI 步骤依赖脚本生成的状态时，以供应的快照为准。

## 进程、退出与取消

- 用户态使用 Node `spawn`，按字节流并行读取 stdout、stderr。macOS 把每步放进独立 POSIX 会话和进程组。短生命周期的 Node 监督进程持有进程组，直到完成回收，并观察与 runner 的 IPC 断开。超时、取消或 runner 退出时先发组 `SIGTERM`，1 秒后对该组仍在运行的进程发 `SIGKILL`。结束时也回收留在该组的子进程，随后才推进计划。验证直接子进程退出和管道关闭，对清理设上限。显式脱离会话的进程无法由组信号保证回收，步骤契约禁止自行 daemonize 或后台驻留。程序需要长期服务时，使用预先配置的服务管理器。
- root 任务须有自身的 30 秒单调时钟截止时间和 root 权限下的进程组监督。取消时 runner 先向 sudo 前端发送 `SIGTERM`，由已验收的 sudo 监控转发，任务回收自己控制的子组并报告结束。父进程意外消失或转发失败仍由任务自己的期限兜底，最多另加 1 秒强杀宽限。没有确认回收时停止后续动作并在报告里标记清理状态未知，不能仅凭 sudo 前端退出就继续。真机验证不通过则继续关闭特权能力。
- 超时从启动步骤起计。取消信号从 CLI 的 `SIGINT` / `SIGTERM` 或工作台「停止」传入当前运行的 AbortController。请求取消后等待有界清理，禁止启动后续步骤。完成、取消与超时竞争时，以 runner 先观察到的完成信号或终止触发为准。故障及取消后，末尾未运行的动作填 `skipped`，保持按展开顺序输出。用户态实际退出码等于预期才通过，被信号终止即失败。沿用已有局部 setup 的阻塞语义。

[Node.js 子进程文档](https://github.com/nodejs/node/blob/v22.x/doc/api/child_process.md)

## 输出、脱敏与报告

- 每步保留至多 **16 KiB / 流** 的 UTF-8 文本，整轮报告的 shell 文本合计至多 **1 MiB**。超过后继续排空管道，记录截断及观察到的原始字节数。按 UTF-8 边界裁剪文本，并清理 ANSI 序列和可能误导显示的控制字符。含 NUL 或无效 UTF-8 的流标为 `binary`，只写元数据。受信的提权结构记录独立校验，不显示 sudo stderr 或特权任务的原始输出。
- 文本采集默认关闭，可用单次 CLI `--capture-shell-output` 或工作台运行确认中的独立开关开启。存在 shell secret 引用、现有 test secret 绑定或任一提权步骤时，运行报告只保留 shell 输出元数据。对可发布文本，在拼接流块后去除可识别的凭证内容，再进入日志、JSON 或 UI。用户须把秘密放进环境引用，避免在命令、普通环境值和脚本正文中写凭据。可选文字采集无法识别所有任意文本中的凭据。
- `kind: "shell"` 沿用展开步骤 ID、状态、时间和时长，带封闭的 `shell` 对象。对象记录 `mode`、`privilege`、root 步骤的 `privilegeMode`、`execution` 和适用时的退出码、信号、清理状态、stdout/stderr 与警告。纯报告及 CLI 默认显示步骤 ID、模式、权限和结果摘要。完整命令在本地源 flow 编辑和确认界面查看。持久化报告与错误消息不写入原始 argv、脚本、环境、cwd 或未经脱敏的异常内容。工作台按文本渲染命令与输出。
- 现有 `report pack` 会把原始 flow 写入 ZIP。首版遇到包含 shell 定义的 flow 时拒绝打包，涵盖未调用的 behavior。结果仍可写入 `--report`，由工作台读取报告及展示。旧 flow 的打包、查看和上传保持既有契约。

| 结果 | 报告行为 |
| --- | --- |
| 匹配预期码 | `passed`，`execution: "finished"`。 |
| 干跑 / 门禁拦截 | `resolved` + `preview`，或 `blocked` + `not-run`。缺 shell 授权用 `SHELL_NOT_ALLOWED`；缺 sudo 授权、登记、`--interactive`、错误密码或账号无 sudo 权限用 `SHELL_PRIVILEGE_REQUIRED`；取消或超时用 `SHELL_PRIVILEGE_CANCELLED`；无法弹出密码框用 `SHELL_PRIVILEGE_UNAVAILABLE`。 |
| `SHELL_EXIT` | 实际退出码不符或子程序自行被信号终止。分别记录数字退出码或信号名。 |
| `SHELL_TIMEOUT` / `SHELL_CANCELLED` | 终止运行并记录 `execution: "terminated"` 与清理状态。CLI 取消沿用退出码 130，工作台展示「已取消」。 |
| `SHELL_START_FAILED` | 启动、输入解析或执行协议异常。若已经开始但结果不明，标记清理状态未知并停止。 |
| `SHELL_OUTPUT_TRUNCATED` | 放在 `shell.warnings` 并标记相应流的 `truncated`，不覆盖原退出、失败或取消结果。 |

## 离线验收

| 场景 | 可观察的断言 |
| --- | --- |
| Schema 与旧数据 | 未改动的 flow、behavior、report 通过基线与扩展 schema。新分支覆盖三个动作入口。混合 argv/command、额外字段、违规 env 键、相对提权路径、提权参数和自定义提权环境均被拒绝。 |
| argv 与 Shell | 在临时目录用本地小程序回写参数，断言含空格、引号、glob、空字符串及 shell 元字符逐项保持。显式脚本的管道和重定向发挥作用。用假桌面验证 shell 放在 UI 动作前后仍按展开顺序运行。 |
| cwd、env 和秘密 | 断言命令看到输入文件基准目录、固定 PATH 和声明的变量。宿主无关凭据不可见。错误 cwd 或缺 secret 在启动前失败。报告和日志不出现注入的值，覆盖跨数据块、无效 UTF-8 及超限样本。 |
| 超时、退出、取消 | 临时进程写入 PID 和真实结果，断言忽略 TERM 的同组孙进程在 KILL 后消失、管道被关闭。预期非零码成功，意外退出和信号失败。取消、超时或退出后无后续副作用。 |
| 输出与提权预检 | 用双流大输出断言有界保留、总量截断仍能完成、二进制不落盘。用注入的 sudo 适配器模拟未登记、拒绝、协议异常、真实退出 1、超时与取消，断言实际调用仅含固定路径和参数。预检阻塞时连桌面替身都不启动。 |
| 工作台、报告 | 导入和干跑没有执行。令牌跨会话、计划修改或重复使用均失败。停止后收到终止结果。报告文本做转义，shell flow 禁止打包，旧 ZIP 内容一致。 |
| 交互式 root | 假 sudo 与假 askpass 覆盖成功、取消、错误密码、超时、无 GUI 与命令超时；断言命令未运行时后续步骤为 `skipped`，密码不出现在报告、argv、环境、结果标记或私有目录的任何文件里，`sudoers` 未授权在预检阶段阻塞，`sudoers` 执行在 HAOC-76 前保持禁用。真机弹框与锁屏 / SSH 行为列入 HAOC-76。 |

## 实施拆分

| 顺序 | 文件与里程碑 | 验收环境 |
| --- | --- | --- |
| 1. 用户态 Shell 与 CLI | 改动 `src/contracts.ts`、`src/flow.ts`、`src/shell.ts`、`src/run.ts`、`src/cli.ts`、生成的 `schemas/{flow,behavior,report}.schema.json`、`src/report.ts`。交付 CLI 门禁、离线预览、串行进程回收与安全报告。 | Node 离线用例，`test/shell.test.mjs` 及现有 flow/report 测试。 |
| 2. 工作台编辑与运行 | 改动 `src/workbench.ts`、`src/workbench-session.ts`、`workbench/{app.js,model.js,style.css}`、`docs/report.md`。交付导入提示、步骤编辑、一次性确认、停止和结果展示。 | `test/workbench.test.mjs` 走本地 API 与假桌面。与真实 UI 的有序回放列入 HAOC-76。 |
| 3. 管理员固定任务 | 改动 `src/shell-privilege.ts`、`src/shell.ts`、`docs/shell-steps.md`。定义管理员登记表与固定任务监督协议，用 mock 完成授权与故障分支，真机验收后启用 sudo。第三项接续第一项，避免共享文件并行修改。 | Mock 离线，sudo／PAM／Touch ID 和特权终止转发列入 HAOC-76。 |
| 4. 交互式 root | 改动 `src/contracts.ts`、`src/shell-privilege.ts`、`src/shell.ts`、`src/run.ts`、`src/cli.ts`、`src/workbench.ts`、`workbench/{app.js,model.js}`、`docs/shell-security.md`。增加 `privilege: "root"` 与 `privilegeMode`、askpass helper、门禁与工作台编辑。 | `test/shell.test.mjs` 假 sudo／假 askpass 离线用例；真机弹框与 `sudoers` 授权列入 HAOC-76。 |

HAOC-76 在用户批准的 macOS 时间窗内验证两项。第一项用一次性测试账号和测试夹具，检查用户态 shell → UI 动作 → shell 的顺序、文件属主与报告。第二项使用管理员预配置的无害固定任务，分别验证精确授权能运行、撤回或改为需认证时立即失败且无密码、Touch ID 或 GUI 弹窗、真实退出 1 不会误判、超时与取消后特权进程退出。任何安装、授权、真实桌面操作或提权执行均依项目纪律单独预约。离线验收不得调用实际 sudo 或桌面输入。
