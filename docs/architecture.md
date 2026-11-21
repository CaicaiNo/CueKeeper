# Cuekeeper 架构

## M1 数据流

```mermaid
flowchart LR
  Native["macOS 只读事件监听"] --> Record["录制编译"]
  Desktop["agent-desktop 1.3.1"] --> Record
  Record --> Flow["flow v1"]
  Manual["手写流程"] --> Flow
  Flow --> Run["定位、前置条件、回放"]
  Run <--> Desktop
  Run --> Report["report v1"]
  Report --> Zip["离线报告 ZIP"]
```

- `native/recorder.swift` 用 CGEventTap 在显式时限内监听鼠标和键盘。它先检查输入监控权限，只在指定应用位于前台时读取事件。可访问性树全部由 agent-desktop 读取。
- `native/recorder.swift` 在目标应用前台时采集输入，通过窗口命中检测筛选点击。独立的键盘过滤器在记录监听器之前消费暂停和停止的组合键，普通按键原样传递。切换应用、暂停和点击 HUD 会结束当前文字段。窗口服务器确认主屏 HUD 的窗口号、进程、层级及主屏边界后，录制才开始，停止时面板随之关闭。
- `src/record.ts` 读取录制开始时的窗口 ID，为点击及文字段首取快照。点击取包含事件坐标且层级最深的可操作节点，同层优先选面积更小的节点。文字根据焦点控件和时间间隙合并。受保护控件、无法及时观测的输入和不支持的操作会被跳过。权限丢失时停止采集。已捕获步骤按 v1 schema 写入，跳过与中断的原因由 CLI 返回。
- `src/desktop.ts` 调用 agent-desktop 的 JSON CLI。版本固定为 1.3.1，使用独立临时状态目录，退出时清理。文本经 stdin 传递。定位和执行分开，每次执行重新抓树并取得当次 ref。执行不自动重试。
- `src/run.ts` 将流程展开为动作，校验窗口和前置条件，执行业务动作。全局前置条件失败会阻塞整个流程，局部失败只阻塞所属动作。回放中的动作或断言失败会停止后续动作。报告保留投递状态，保存是否生效需要对应断言或外部文件核对。
- `src/report.ts` 校对流程摘要与动作顺序，再打包 `index.html`、`report.json`、`flow.json`、`assets/report.css` 和 `manifest.json`。清单记录每个归档内容文件的长度和 SHA-256。HTML 可以从解压目录直接阅读。

接口以 v1 契约为准。CLI 的 live 垂直切片限定单个既有、标题精确匹配的应用窗口。录制支持单次左键、ASCII 连续输入和常用快捷键。IME、拖拽、滚动、多窗口及系统对话框将在相应支持进入里程碑后验收。坐标以当前屏幕的逻辑点表示，回放会检查落点和窗口焦点，依然需要真实显示布局与无遮挡的测试窗口。保护字段判断依赖操作系统与控件提供的安全状态，测试流程请使用专用测试数据。

## v1 契约

`schemas/` 提供 flow、behavior、setup 和 report 四份 Draft-07 JSON Schema。相应示例放在 `examples/`。构建校验 Schema 与 `src/contracts.ts` 的生成结果一致。

- Flow 必须声明应用标识和精确窗口标题。动作包括 `click`、`type`、`key`、`wait` 与 `assert`。元素定位器用 `role`、可选 `name`、从窗口根开始的角色 `path` 和显式零基 `index` 组成。匹配采用精确比较，`name: ""` 表示无名称。多个命中且未指定序号时，回放会返回歧义错误。`point` 只用于点击，需要 `--headed`。
- `behavior` 是命名动作组。流程内可以把动作组放入 `behaviors`，用 `kind: "behavior"` 引用并提供 `args`。v1 支持在 `type.text` 中绑定字符串参数。独立 behavior 文件的 `version` 属于文件封装，嵌入流程时保留其余字段。编排者可在 JSON 中复制动作组或展开其动作。
- `setup` 可放在 flow 或 action 上。只有 `confirmed` 会参与回放，其他三态 `inferred`、`invalid` 和 `deleted` 在报告中记为跳过。独立 setup 文件嵌入时同样移除文件的 `version`。撤销属于工作台编辑功能。
- 检查支持 `exists`、`visible`、`text`、`value`。前两者要求布尔值，后两者与字符串精确比较。找不到目标只对 `exists: false` 构成匹配，模糊命中、快照缺失和不可读取的属性会明确失败。`wait` 定期重复读取，`assert` 读取一次。dry-run 只验证定位和作用域，结果记为 `resolved`。
- Report 的 `mode` 区分 dry-run 与 replay。`entries` 记录动作、前置条件、相对时间、耗时和投递状态。报告以规范化 JSON 的 SHA-256 绑定原始 flow 内容。v1 的破坏性改动需要新版本和显式迁移。

## 里程碑

| 里程碑 | 可验收输出 |
| --- | --- |
| M1 · macOS 最小闭环 | CLI、v1 Schema 和离线 ZIP。TextEdit 录下三步并连续通过十轮保存核对 |
| M2 · 录制与工作台 | 应用筛选、时间线、元素拾取、行为复用与前置条件编辑。用一条录制会话完成整理、撤销和回放 |
| M3 · Windows 兼容与报告上传 | Windows 原生采集桥、同一 v1 流程格式、报告查看及可选幂等上传。本机保留上传失败的 ZIP |

`design/` 保存六份既有原型，供 M2 复用。执行协议以 [agent-desktop v1.3.1](https://github.com/vercel-labs/agent-desktop/tree/v1.3.1) 为准。
