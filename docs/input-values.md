# 输入参数值与 `<flow>.values.json`

全局录制的 `type` 步骤只把参数**名字**写进 flow（`inputs: ["text_1"]`）。参数的值不放进 flow，而是写在 flow 同目录的旁挂文件里：

```
~/.cuekeeper/recordings/recording-20261126T080121Z.flow.json
~/.cuekeeper/recordings/recording-20261126T080121Z.flow.values.json
```

这样「录完就能直接回放」，同时 flow、修订、报告、`flow validate` 与 `hashFlowV2` 都不含原文。

## 文件格式

```json
{
  "version": 1,
  "flowId": "global-fd0822c0",
  "recordedFlowSha256": "9f1c…",
  "updatedAt": "2026-11-26T08:01:21.402Z",
  "values": {
    "text_1": {
      "value": "https://example.com/pkg",
      "complete": true,
      "steps": ["s11"],
      "targets": [{ "role": "textfield", "name": "请输入地址" }]
    },
    "text_2": { "sensitive": true, "complete": true, "steps": ["s13"] }
  }
}
```

- `value` 原样保存，含首尾空格；单个值上限 4000 字符、最多 64 个参数。
- `complete` 为 `false` 表示录制时没读全，原因在 `issues`：`chars_missing`（输入法提交没带字符）、`backlog_dropped`（事件积压丢字）、`truncated`（超过 4000 被截断）。
- `sensitive: true` 的条目没有 `value`；读取方不会拿到值。安全输入（`SECURE_INPUT`）不产生 `type` 步骤，因此不会写条目。
- `steps` / `targets` 只用于「这一项当时用在哪、目标控件是否改过」的提示，不参与匹配。

## 查找与失效

1. 先找 flow 的同名文件：把结尾 `.json` 换成 `.values.json`。
2. 找不到就扫同目录下的 `*.values.json`，取 `flowId` 相同、`updatedAt` 最新的一份（修订文件、导入后改名都能找回）。
3. 都没有就按「没有值」处理，回放时照常要求填写。

只按 `flowId` + 参数名匹配，**不按 flow 哈希**：改窗口标题、挪步骤都不影响取值。参数改名后旧值成为孤儿，新名字需要重填一次。文件损坏（JSON 坏、版本不对、字段越界）只警告并按没有值处理，不会挡住回放。

## 开关

| 场景 | 命令 |
| --- | --- |
| 录制时不保存值 | `cuekeeper record --global … --no-input-values` |
| 回放时不读取已存值 | `cuekeeper run <flow> --foreground --no-stored-inputs` |
| 显式指定值 | `cuekeeper run <flow> --foreground --inputs <values.json>`（永远优先） |

工作台的「实时回放」弹窗会预填已存值，并逐项显示来源（来自录制 / 不完整 / 敏感 / 无值）。「清除已存值」删除该条目；只有勾选「把这次填写的值存为默认」才会写回文件。提交不再 `trim()`，首尾空格会原样传给 CLI。

## 安全边界

- 文件权限 `0600`，目录沿用录制目录的 `0700`；写入用「临时文件 + rename」，不留半截文件。
- 明文存储：同机同用户的进程可以读，Time Machine / iCloud 备份会带上。不做加密（没有密钥管理时加密只是错觉）。
- 不写进 flow、修订、报告、日志、上传包；`*.values.json` 已在 `.gitignore` 里，flow 放进 git 仓库时不会带上值。
- 密码与令牌继续走 `SECURE_INPUT` + 人工检查点。用户把密码打进**普通**输入框时无法自动识别——不要这样录；可用 `--no-input-values` 或逐项清除。
