# 会话视频离线实验（HAOC-91）

两个独立程序，**都在内存里画合成画面**：不启动 App、不抓屏、不要任何 TCC 权限。结论用于 [会话视频设计](../../../docs/session-video.md)。

- `encode-spike.swift`：CoreGraphics 画 1920×1080 的"窗口"，`AVAssetWriter` + VideoToolbox 编 H.264/HEVC，再回读校验 PTS、时长与指定时间点取帧。
- `diff-spike.swift`：同一套合成画面，比较 160×90 缩略图的分块差，量出各种变化到底改了几块。

## 复现

```sh
cd design/video/experiment
mkdir -p out
swiftc -O encode-spike.swift -o out/encode-spike && ./out/encode-spike out/   # ~2 分钟
swiftc -O diff-spike.swift   -o out/diff-spike   && ./out/diff-spike         # ~3 秒
```

产物（`*.mp4`、二进制、jsonl）在 `out/`，已被仓库 `.gitignore` 的 `out/` 规则忽略；只提交源码与本记录。原始输出：`out/results.jsonl`、`out/diff-results.jsonl`。

环境：macOS 27.0（26A428）、Apple M4、Swift 6.4、VideoToolbox 硬件 H.264。编码参数固定为 1080p、目标码率 3 Mbps、`AVVideoAllowFrameReordereringKey = false`、`ExpectedSourceFrameRate = 10`、关键帧间隔 100 帧（除非注明）。

## 1. 分块差分：变化有多大

缩略图 160×90，8×8 一格共 240 格，格内取**最大**灰度差；"变了的格"阈值如下表。同一帧渲染两次的残差是 **0 格 / 最大差 0**（确定性渲染，等价于 ScreenCaptureKit 的精确像素）。

| 变化 | 阈值 6 | 阈值 12 | 阈值 24 | 格内最大差 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 光标闪烁（2×28 px） | 2 | 2 | **0** | 19 | 阈值 24 丢弃 |
| 输入一个字符 | 1 | 1 | 1 | 35 | 保留（churn） |
| 状态栏时钟跳秒 | 1 | 1 | 1 | 117 | 保留（churn，限流） |
| 4pt 小圆点 | 1 | 1 | 1 | 26 | 保留 |
| 滚动 14 px | 122 | 122 | 121 | 131 | 保留（structural） |
| 视频播放 | 71 | 71 | 69 | 143 | 保留（structural，跑满 10 fps） |

96×54 缩略图同一组：光标 1/1/**0** 格、单字符 1/1/**0** 格（阈值 24 会把单字符也丢掉）——所以选 **160×90**，不选更小的。

签名开销（含降采样 + 灰度化 + 分块，M4 单核）：160×90 为 **0.05–0.08 ms/帧**，96×54 为 0.02–0.03 ms/帧。10 fps 下可忽略。

## 2. 体积：CFR vs 帧差 VFR

同一段时间线：`0–2 s` 空闲（光标闪）、`2–30 s` 滚动 + 选区移动、`30–600 s` 空闲（光标闪）。共 600 s。

| 场景 | 帧数 | 字节 | 编码耗时 | 说明 |
| --- | --- | --- | --- | --- |
| CFR 10 fps（基线） | 6000 | 6 054 954 | 26.32 s | 4.4 ms/帧 |
| VFR，光标闪烁按"变了"处理（最坏） | 1424 | 2 130 439 | — | 2.8× 小 |
| **VFR，按阈值 24（光标被丢）** | **281** | **997 756** | **1.28 s** | **6.1× 小** |
| HEVC，同上最坏时间线 | 1424 | 2 677 851 | — | 不比 H.264 小 |

纯静态 600 s：

| 场景 | 帧数 | 字节 | 相对 VFR |
| --- | --- | --- | --- |
| CFR 10 fps，关键帧每 100 帧 | 6000 | 5 343 443 | 91× |
| CFR 10 fps，单关键帧 | 6000 | 3 112 092 | 53× |
| **VFR，两个样本（首帧 + 599.9 s）** | **2** | **58 402** | 1× |

单帧成本（单关键帧序列，100 个后续帧的增量均值）：

| 项 | 字节 | 备注 |
| --- | --- | --- |
| I 帧 | 43 342 | 稀疏合成界面；密集文字界面会更高 |
| P 帧（画面未变） | 933 | 目标码率 800 kbps–3 Mbps 都测过：1029 / 977 / 933 → **不是码率填充**，本机编码器对重复帧就是 ~0.9 KB |
| P 帧（滚动 14 px） | 3102 | |
| P 帧（只有光标翻转） | 976 | 与"未变"同量级 |

体积模型代入：`43 KB + 279×3.1 KB + 1140×1.0 KB = 2.02 MB`，实测 2.13 MB（+5%，差在关键帧与容器）。所以：

> H.264 对静态压缩很好，但"重复编码不动的一帧"仍要 ~0.9 KB。10 分钟纯静态 CFR 是 3.1–5.3 MB，VFR 是 58 KB。收益来自**不编码**，不是压缩率。

胶片条（设计草案阶段 1）的对比（同一帧，CoreGraphics 导出）：1080p PNG **48 197 B**、JPEG q0.8 **275 007 B**（矢量感强的合成界面 PNG 更划算；真实密集文字/图片界面会更大）。所以 300 帧胶片条起步 ~15 MB，比同内容 H.264 视频大一个量级。

## 3. VFR 容器与 seek

四个文件的 mp4 结构（直接解析 box，非 AVFoundation）。下表 `stts` 的 sample_delta 是 **track tick**，不是毫秒；track timescale 为 600，所以 60 tick = 100 ms：

| 文件 | 样本 | `stts` | 时长 | track timescale |
| --- | --- | --- | --- | --- |
| `cfr-10fps-600s.mp4` | 6000 | 1 条 `(6000, 60 tick = 100 ms)` | 600.000 s | 600 |
| `vfr-diff-driven-600s.mp4` | 281 | 2 条 `(1, 1200 tick = 2000 ms)`、`(280, 60 tick = 100 ms)` | 600.000 s | 600 |
| `still-vfr-600s.mp4` | 2 | 1 条 `(2, 359 940 tick = 599 900 ms)` | 600.000 s | 600 |
| `vfr-governed-600s.mp4` | 1424 | 多变长条目 | 600.000 s | 600 |

写入用的是 movie timescale 1000 的毫秒 PTS；落到 track 上会被量化到 1/600 s（≈1.67 ms）的整数格，误差最多半格（≈0.83 ms）。**不要读成"毫秒值是整数倍所以无损"**。

回读（AVFoundation `AVAssetReader`，逐帧比对写入的 PTS）：

| 场景 | `ptsMatch` | 指定时间点可解码出图（tolerance 0） | 探针 |
| --- | --- | --- | --- |
| CFR 600 s | true（6000/6000） | 全部出帧 | 1 s / 20 s / 300 s / 599 s |
| VFR diff-driven | true（281/281） | 全部出帧 | 1 s / 20 s / 300 s / 599 s（最后样本在 29.9 s） |
| VFR 最坏情况 | true（1424/1424） | 全部出帧 | 1 s / 20 s / 60 s / 300 s / 590 s |
| 纯静态 VFR（2 样本） | true（2/2） | 全部出帧 | 0 s / 200 s / 599 s（在 599.9 s 的 hold 里） |

结论：MP4 只用 `stts` 表达变长帧即可，无需 `ctts`（关闭帧重排）；**单帧 hold 近 10 分钟时，指定时间点仍能解出被 hold 的那一帧**，不需要周期性补帧。这只证明解码器行为，浏览器实际 seek 归 HAOC-76。

本单的原生 `--self-test` 进一步把"出图"升级为"出对图"：用两帧内容明显不同的 10 s 片子（第二帧在 9 s 才出现），断言 4.5 s 与 0 s 解出的画面签名**完全一致**，9.5 s 的签名与它明显不同。

## 4. 踩到的坑（写进设计的实现约定）

1. **PTS 必须严格递增且不能用浮点截断**：最初用 `Int64(t * 6 / 1000)` 把 0 ms 与 100 ms 都算成 0 tick，`append` 在第 5 帧报 `-11800/-16364`。改成"1 tick = 1 ms"的整数 PTS 后正常。
2. **`endSession(atSourceTime:)` 要显式给停止时刻**。取"最后一帧 + 一帧时长"时，600 s 的片子被写成 30 s（`durationMs: 30000`）。
3. **首帧一定是 PTS 0**。第一版 VFR 从第一处变化（2 s）才开始写，片子开头就有 2 s 空洞，指定时间点取 1 s 的画面直接失败。
4. **track timescale 与 movie timescale 不同**：本机两者是 600 与 1000。回读比较必须用秒，manifest 里要记录 `timebase.timescale`。
5. **完全相同的一帧也花 ~0.9 KB**，与目标码率无关（800 kbps 时反而 1.03 KB）。

## 5. schema 草案自检

`manifest-video.schema.json` 与 `manifest-filmstrip.schema.json` 用 `design/video/examples/` 下的三个实例做过正反例检查（Draft-07 子集校验器，仅本轮临时脚本，未入库）：

- 接受：`video-complete`、`video-skipped`、`filmstrip-complete`、`filmstrip-skipped`。
- 拒绝：缺 `anchor`；多出未知字段；`status: complete` 又带 `code`；`path` 不在 `media/` 下；`videoStartOffsetMs` 越界；`skipped` 无 `code`；`truncated` 无 `truncatedAtMs`；`maxFps: 60`；开放式的 `code` 字符串；`gaps` 超过 64 条。

正式纳入由 `src/contracts.ts`（TypeBox）完成：`video` 生成 [schemas/video.schema.json](../../../schemas/video.schema.json)，manifest（既有 ZIP 字段 + 可选 `video`）生成 [schemas/manifest.schema.json](../../../schemas/manifest.schema.json)，两者都由 `pnpm build` 的 `schemas.mjs --check` 检查漂移，并由 `test/video.test.mjs` 覆盖 `complete` / `truncated` / `skipped` 的正反例与字节数、SHA-256 校验。
