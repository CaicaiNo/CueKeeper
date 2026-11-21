# Root 步骤与管理员授权

HAOC-82 · 风险说明 · 契约见 [Shell 步骤设计](shell-steps.md)

用户态仍是默认：CLI、工作台、录制器和桌面适配器都以启动 CueKeeper 的非 root 用户运行，`privilege` 省略时是 `"user"`。本文只描述显式标注 `privilege: "root"` 的步骤。

## root 步骤就是任意特权代码

`privilege: "root"` 用调用方给出的 `argv` 通过 `sudo` 以 root 执行。它不是沙箱、不是白名单，也没有命令模板：

- 能写进 `argv` 的任何程序都会以 root 运行，包括解释器、包管理器和安装脚本。
- 密码框只回答「谁在授权」，不回答「授权了多大范围」。用户输入一次管理员密码，等于同意这条命令以 root 执行。
- 只运行可信来源的 flow。导入的 flow 与 UI 动作一样，是代码而不是数据。
- 需要最小权限时用 `privilege: "sudo"` 的固定任务：管理员预装 `root` 属主、`sudoers` 精确授权的单一程序，CueKeeper 只传该路径，不接受参数、环境、工作目录和脚本。
- 夜间和 CI 用无通用 `sudo` 权限的专用账号。

## 密码框是认证，不是沙箱

交互式 root 通过 `sudo -A` 调用 `SUDO_ASKPASS` helper 弹出原生对话框：

- 每个 root 步骤先执行 `sudo -A -k -v`：`-k` 忽略已缓存的凭据，`-v` 只校验身份、不执行任何命令；因此 `sudoers` 里只允许个别命令的策略不会被这条探测误拒。
- 身份通过后，同一步骤再执行 `sudo -A -u root -- <程序> <参数…>`；正常的 `timestamp_timeout` 会复用刚建立的凭据，命令阶段不再弹框。
- 选择 `osascript` + `display dialog … with hidden answer` 而不是自编译的 `NSSecureTextField` helper：`osascript` 是系统自带、无需签名与分发，密码只经过 `osascript → helper → sudo` 的管道；代价是对话框外观由 Standard Additions 决定，且密码会短暂出现在这两段进程内存与管道中（不会落盘）。原生 helper 能提供更严格的 secure input，但需要签名、分发和额外的信任链，首版不做。
- 密码不进入命令行参数、环境变量、报告、日志或临时文件。helper 的 stdout 是 `sudo` 读取密码的唯一通道；helper 只在私有目录（`0700`）里写不含密码的结果标记（`provided` / `retry` / `cancelled` / `timeout` / `unavailable`）。
- 连续失败：`sudo` 会在密码错误后再次调用 helper。helper 第二次被调用时只追加 `retry` 并以失败退出，不再弹框；父进程据此把「密码错误」与「命令自己退出非零」区分开。
- 报告只记录 `privilege: "root"`、`privilegeMode`、`execution` 与退出码。root 步骤的 stdout/stderr 永不采集，即使命令行给了 `--capture-shell-output`。

## 授权入口

| 入口 | 允许条件 | 说明 |
| --- | --- | --- |
| CLI | `--allow-shell --allow-sudo --interactive` | `--interactive` 与 `--json` 互斥（`--dry-run` 预览除外），机器模式不静默降级。 |
| 工作台 | 启动参数 `--allow-shell --allow-sudo`，且运行确认 `confirm: true` + 一次性计划令牌 | 预览已展示完整命令、目录与权限；令牌绑定会话、flow 摘要与计划。 |
| 非交互（CI） | `privilegeMode: "sudoers"` | 只走 `sudo -n`，不做任何弹框；未获授权时明确失败。 |

`privilegeMode` 省略时是 `"prompt"`（每次弹框）。`"sudoers"` 需要管理员预装 `NOPASSWD` 策略，用于无人值守；本仓库在 HAOC-76 真机验收通过前把 `sudoers` 执行保持在禁用状态，任何尝试都以 `SHELL_PRIVILEGE_REQUIRED` 明确阻塞，不会回退到弹框。

`sudoers` 模式在预检阶段执行 `sudo -n -l -- <程序> <参数…>`，只检查策略是否允许，不执行命令；未授权时该步骤在启动前就被阻塞。

## 锁屏、无 GUI 与 SSH

密码框依赖当前登录用户的图形会话：

- 锁屏、未登录、无图形会话（SSH、`launchd` 后台任务）或系统拒绝 Apple Events 时无法弹框。helper 收不到对话框结果，写入 `unavailable`，步骤以 `SHELL_PRIVILEGE_UNAVAILABLE` 阻塞并给出明确消息。
- 非 macOS 主机在预检阶段直接以 `SHELL_PRIVILEGE_UNAVAILABLE` 拒绝交互式 root。
- 无人值守场景不要依赖 `prompt`；要么预装 `sudoers` 策略，要么把特权步骤移出夜间流程。

## root 生成文件的属主与 cwd

- 以 root 运行的程序写出的文件属主是 **root**，之后同一 flow 里的用户态步骤可能无法修改或删除它们。测试夹具要放在专用目录，结束后由同一条 root 步骤清理，或用 `chown` 显式交还。
- `cwd` 默认是输入 flow 所在目录；root 步骤会以该目录作为工作目录执行。不要让 root 步骤的 `cwd` 指向用户可写、可被其他进程替换的目录中的脚本；root 会跟随该目录里的相对路径。
- root 步骤不接受 `env`，环境固定为 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`、`LANG=C`，避免把调用方环境（`DYLD_*`、`SUDO_*` 等）带进特权进程。
- root 步骤不接受 `shell: true`：必须逐项给出 `argv`，运行前展示完整程序、参数与工作目录。

## 失败、取消与超时

| 情况 | 结果 |
| --- | --- |
| 用户在对话框点「取消」 | 该步骤 `blocked`，`SHELL_PRIVILEGE_CANCELLED`，命令未运行，后续步骤 `skipped`。 |
| 对话框超时（默认 60 秒） | 同上，`SHELL_PRIVILEGE_CANCELLED`。 |
| 密码错误 | `blocked`，`SHELL_PRIVILEGE_REQUIRED`；不重试弹框，不运行命令。 |
| 账号无权使用 `sudo` | `blocked`，`SHELL_PRIVILEGE_REQUIRED`。 |
| 无法显示对话框 | `blocked`，`SHELL_PRIVILEGE_UNAVAILABLE`。 |
| 命令超时 | `failed`，`SHELL_TIMEOUT`，`execution: "terminated"`，记录进程组回收状态。 |
| 命令被中断（`SIGINT` / 工作台「停止」） | `failed`，`SHELL_CANCELLED`，随后不再启动任何步骤。 |
| 命令退出码不符 | `failed`，`SHELL_EXIT`，记录真实退出码。 |

超时只约束命令阶段；对话框有独立的 60 秒上限，因此输入密码的耗时不会占用命令的执行预算。

## 本单未验证的部分

离线用例用假 `sudo` 与假 askpass 覆盖成功、取消、错误密码、超时、无 GUI、未授权和命令超时，从不调用真实 `sudo`、不弹系统密码框、不启动 GUI。真机弹框、锁屏 / SSH 行为、`sudoers` 实际授权与 root 进程回收列入 HAOC-76，需单独预约时间窗。
