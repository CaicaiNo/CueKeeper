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

- 每个 root 步骤只发起**一次** `sudo -A -k -u root -- <程序> <参数…>`：`-k` 忽略已缓存的凭据，因此每次 root 步骤都对应一次密码框；sudo 用刚拿到的凭据执行随后的命令，同一步骤内不再二次弹框。
- 不使用 `sudo -A -k -v` 预检：macOS 在无 TTY 场景下不把 `-v` 校验过的 ticket 复用给下一次 sudo，会导致同一步骤弹两次密码框（HAOC-100）。
- 是否弹框、授权结果如何，都从 askpass helper 的结果标记判断：`cancelled` / `timeout` / `unavailable` 是认证失败；`retry` 且退出非 0 是密码被拒；`provided` 表示命令已执行，退出码就是命令自己的。sudo 全程没问密码时（`NOPASSWD` 命中了精确命令，或账号根本没有 sudo 权限），再用一次不弹框的 `sudo -n -l -- <程序> <参数…>` 判断策略是否允许，据此把「命令已执行但退出非 0」与「账号无权 sudo」区分开。
- 选择 `osascript` + `display dialog … with hidden answer` 而不是自编译的 `NSSecureTextField` helper：`osascript` 是系统自带、无需签名与分发，密码只经过 `osascript → helper → sudo` 的管道；代价是对话框外观由 Standard Additions 决定，且密码会短暂出现在这两段进程内存与管道中（不会落盘）。原生 helper 能提供更严格的 secure input，但需要签名、分发和额外的信任链，首版不做。
- 密码不进入命令行参数、环境变量、报告、日志或临时文件。helper 的 stdout 是 `sudo` 读取密码的唯一通道；helper 只在私有目录（`0700`）里写不含密码的结果标记（`provided` / `retry` / `cancelled` / `timeout` / `unavailable`）。
- 连续失败：`sudo` 会在密码错误后再次调用 helper。helper 第二次被调用时只追加 `retry` 并以失败退出，不再弹框；父进程据此把「密码错误」与「命令自己退出非零」区分开。
- 报告只记录 `privilege: "root"`、`privilegeMode`、`execution` 与退出码。root 步骤的 stdout/stderr 永不采集，即使命令行给了 `--capture-shell-output`。

## 授权入口

| 入口 | 允许条件 | 说明 |
| --- | --- | --- |
| CLI | `--allow-shell --allow-sudo --interactive` | `--interactive` 与 `--json` 互斥（`--dry-run` 预览除外），机器模式不静默降级。 |
| CLI（Keychain） | `--allow-shell --allow-sudo --non-interactive` | 只从登录钥匙串读取已保存的管理员密码，不弹框；缺凭据时阻塞。 |
| 工作台 | 启动参数 `--allow-shell --allow-sudo`，且运行确认 `confirm: true` + 一次性计划令牌 | 预览已展示完整命令、目录与权限；令牌绑定会话、flow 摘要与计划。 |
| 非交互（CI） | `privilegeMode: "sudoers"` | 只走 `sudo -n`，不做任何弹框；未获授权时明确失败。 |
| 工作台批量 | `keychain` 或预配置 `sudoers` | 批量固定加 `--json`，与 `--interactive` 互斥；`prompt` 模式在开始前以 `ROOT_PROMPT_ITEM` 拒绝，不会跑到一半弹框。 |

`privilegeMode` 省略时是 `"prompt"`（每次弹框）。`"sudoers"` 需要管理员预装 `NOPASSWD` 策略，用于无人值守；本仓库在 HAOC-76 真机验收通过前把 `sudoers` 执行保持在禁用状态，任何尝试都以 `SHELL_PRIVILEGE_REQUIRED` 明确阻塞，不会回退到弹框。`"keychain"` 见下一节。

`sudoers` 模式在预检阶段执行 `sudo -n -l -- <程序> <参数…>`，只检查策略是否允许，不执行命令；未授权时该步骤在启动前就被阻塞。

## Keychain 自动填充（无人值守 root）

`privilegeMode: "keychain"` 或 CLI 的 `--non-interactive` 让 root 步骤从登录钥匙串读取管理员密码，全程不弹密码框。默认仍是每次弹框；Keychain 是显式开启的模式，flow 里写了 `sudoers` 时 `--non-interactive` 不会改写它。

```sh
cuekeeper sudo set      # 输入一次管理员密码，交给 security 自己的隐藏提示
cuekeeper sudo status   # 只查元数据，不读取密码
cuekeeper sudo clear    # 删除钥匙串项
```

- 保存的是**管理员密码本身**，等价于完整 root 权限。只用于可信、单人使用的机器；不要在多用户共享、远程或不受控的机器上启用。
- 钥匙串项固定为服务 `com.cuekeeper.sudo`、账号 `$USER`，ACL 只信任 `/usr/bin/security`。`cuekeeper sudo set` 调用 `security add-generic-password -U -s com.cuekeeper.sudo -a "$USER" -T /usr/bin/security -w`：`-w` 放在最后且不带值，由 `security` 自己提示输入，密码不进入 argv、环境变量、文件、报告或日志。读取路径同样经 `security find-generic-password -w`，只把结果写进 sudo 的管道。
- 修改管理员密码后必须重新执行 `cuekeeper sudo set`（旧密码会被 sudo 拒绝，步骤报 `SHELL_PRIVILEGE_REQUIRED`）；离职、转借或怀疑泄漏时执行 `cuekeeper sudo clear` 并轮换系统密码。
- 首次读取（或钥匙串被锁定时）可能弹出一次系统 Keychain 授权框，选择「允许」即可；拒绝、取消、钥匙串里没有该项以及任何读取失败都统一报 `SUDO_CREDENTIAL_MISSING`，步骤 `blocked`，**不会**回退成密码框，也不会明文重试。
- 不要把项同步到 iCloud 钥匙串、其他机器或团队共享；不要把它写进仓库、截图或报告。Keychain 项只存在于本机登录钥匙串。
- 与 `sudoers` 的取舍：Keychain 配置更省事，但保存的是完整管理员密码，授权范围比一条 `NOPASSWD: /path/to/program` 宽得多。CI、共享主机和长期无人值守优先用 `sudoers`；个人可信工作站且需要手动维护时再用 Keychain。

## 本机实测：密码框可被辅助功能驱动

macOS 27 上用一次错误口令（非真实密码）实测交互式 root 的密码框：

- 弹框可由辅助功能树定位：`role: dialog`、标题「CueKeeper 管理员授权」、一个 `secure` 且已聚焦的 `textfield`，以及「继续」「取消」两个按钮。
- 物理键盘注入 `type` 被拒绝（`POLICY_DENIED`：安全输入框不支持语义动作，也不允许焦点回退）。
- 语义 `set-value` 可以写入该安全输入框，随后 `click`「继续」成功提交；sudo 拒绝了错误口令，步骤以 `SHELL_PRIVILEGE_REQUIRED` 阻塞，命令未运行。

结论：「安全输入框」不等于对已获辅助功能权限的进程构成边界——键盘注入被挡，但 AX 语义写入可用。密码框只能证明「谁在授权」，真正的边界是只运行可信 flow、只把辅助功能权限授予可信进程；Cuekeeper 自身仍不代输、不缓存、不落盘密码。

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
| Keychain 无凭据 / 读取被拒（`keychain` / `--non-interactive`） | `blocked`，`SUDO_CREDENTIAL_MISSING`；不弹框，不回退明文。 |
| 命令超时 | `failed`，`SHELL_TIMEOUT`，`execution: "terminated"`，记录进程组回收状态。 |
| 命令被中断（`SIGINT` / 工作台「停止」） | `failed`，`SHELL_CANCELLED`，随后不再启动任何步骤。 |
| 命令退出码不符 | `failed`，`SHELL_EXIT`，记录真实退出码。 |

超时上限覆盖整个步骤：命令预算加上对话框上限（默认 60 秒）。对话框自己在 60 秒后放弃并报告 `SHELL_PRIVILEGE_CANCELLED`，所以输入密码的耗时不会挤掉命令的执行预算；最坏情况下（命令在授权后卡死）报告时间会比命令预算多出一个对话框上限。

## 本单未验证的部分

离线用例用假 `sudo`、假 `security` 与假 askpass 覆盖成功、取消、错误密码、超时、无 GUI、未授权、Keychain 缺失 / 拒绝和命令超时，从不调用真实 `sudo` 或 `security`、不弹系统密码框、不启动 GUI、不读写真实钥匙串。真机弹框、锁屏 / SSH 行为、`sudoers` 实际授权、Keychain ACL 首次授权与 root 进程回收列入 HAOC-76 / HAOC-101 真机验收，需单独预约时间窗。`cuekeeper sudo set` 的真实写入由用户在自己的终端执行一次后确认。
