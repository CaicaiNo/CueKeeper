# 会话视频：帧差采样 + VFR + 时间线对齐

本文设计一次运行的可选会话视频。**设计已落到离线实现**：帧差、编码、manifest 与查看器都有对应代码和测试；真实窗口采集器已实现但按设计只在 HAOC-76 做真机验证。本轮没有启动 GUI，没有抓屏，没有申请屏幕录制权限。文中的体积、帧差与 seek 结论来自 `design/video/experiment/` 下的两个离线程序（合成帧 + 本机 VideoToolbox 编码），实测数字与复现命令见 [实验结果](../design/video/experiment/results.md)。

## 0. 实现落点

| 落点 | 内容 |
| --- | --- |
| `src/video-diff.ts` | 160×90 灰度缩略图、8×8 分块最大差、structural/churn 决策与节流；`test/video-diff.test.mjs` 用 1920×1080 合成帧断言滚动=structural、单字符/小圆点=churn、同帧=0 块 |
| `src/video.ts` | 视频 artifact 的 TypeBox 契约（complete / truncated / skipped 三种封闭形状）、锚点与 seek 换算、gaps 合并 |
| `src/video-capture.ts` | 只读 preflight、独立采集器进程、JSONL 事件、pause/resume/stop、finalize 校验、`.partial.mp4` 清理；权限缺失/非 macOS/编码器崩溃一律 `skipped`，不产生半截文件 |
| `native/video-capture.swift` | 窗口级 `SCContentFilter`、`SCFrameStatus` 过滤、帧差、`AVAssetWriter` VFR、mask、`--self-test` 离线编码自检 |
| `src/report.ts` + `src/viewer.ts` | `media/` 纳入归档、`manifest.video`、体积护栏、`<video>` 播放器与"点步骤 seek"；旧报告不受影响 |
| `src/cli.ts` + `src/run.ts` | `run --video`（默认关闭，要求 `--report`）、`report pack --no-media`；采集失败不改变运行结论 |

## 1. 结论

1. **用户直觉需要修正一半。** H.264 对静态画面确实压缩很高，但**重复编码同一帧并不免费**：本机测得 1080p 同一帧仍约 0.5–0.9 KB/帧，10 分钟 10 fps 纯静态 CFR 是 **3.1–5.3 MB**。帧差 VFR 把同一段压成 2 个样本 **58 KB**（53–91×）。真正的收益不在"压缩率"，而在**不采集、不编码**，以及把长空闲压成一个可 seek 的时间跳点。
2. **screen capture 的粗筛不用我们做。** ScreenCaptureKit 每帧带 `SCFrameStatus`，窗口没有重绘时是 `.idle` 而不是 `.complete`（语义需真机确认，见第 13 节）。像素差只是第二道筛子，用来丢掉"有重绘但人眼无感"的变化（光标闪烁、状态栏时钟）。
3. **实测阈值能把光标闪烁和真实编辑分开。** 160×90 灰度缩略图上按 8×8 分块、块内最大差 ≥ 24 计为"变了的块"：光标闪烁（2 块，最大差 19）被丢；输入一个字符（1 块，35）、时钟跳秒（1 块，117）、4pt 小圆点（1 块，26）、滚动 14px（122 块）都保留。
4. **MP4 + H.264 + VFR 可用。** 容器只用标准 `stts` 表达变长帧（实测一个 600 s 的 VFR 文件 `stts` 只有 2 个条目）；AVFoundation 回读 PTS 完全一致；**在最后样本停在 29.9 s 的片子里，精确 seek 到 599 s 仍返回被 hold 的那一帧**（tolerance 为 0）。
5. **"一个静止帧 + 时间跳点"就是正解，不需要丢帧补丁。** 600 s 只有 2 个样本、单帧被 hold 599.9 s，容器时长与播放器 seek 都正常，所以不需要每 30 s 插空关键帧。
6. **合同上把视频放在 manifest，不放到 `report.json`。** report v1 是 `additionalProperties: false` 且已冻结；视频是可选 artifact，旧报告没有它照样打开。
7. **推荐路径：阶段 1（原生采集 + 帧差 + PNG 关键帧）先落地，阶段 2（同一采集链加 AVAssetWriter VFR MP4）随后；阶段 1 的胶片条长期作为"编码不可用"时的降级产物，而不是独立长期产品面。**

## 2. 采集

**只抓目标窗口**，不是全屏。运行时已经用 `CGWindowID` 绑定窗口（`run` 的窗口 ID 检查），采集直接复用同一个 ID。

| 参数 | 取值 | 理由 |
| --- | --- | --- |
| 目标 | `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)` 里按 `windowID` 精确匹配，`SCContentFilter(desktopIndependentWindow:)` | 只录目标窗口；桌面、其他应用、通知中心都不在画面里 |
| 帧率上限 | `minimumFrameInterval = CMTime(1, timescale: 10)` | 10 fps 足够看状态变化；60 fps 只会放大体积 |
| 分辨率 | 窗口 `contentRect × pointPixelScale`，长边封顶 1920，宽高取偶数 | Retina 2x 的 1512pt 窗口原样是 3024×1964；封顶后文字仍可读，H.264 要求偶数 |
| 像素格式 | `kCVPixelFormatType_32BGRA` | 缩略图与编码器都吃这个格式，少一次转换 |
| 音频 | `capturesAudio = false` | 边界：不做音频 |
| 光标 | `showsCursor = false` | 否则鼠标在窗口上移动会持续产生 `.complete` 帧，10 fps 永远停不下来；点击位置已经在动作时间线里 |
| 队列 | `queueDepth = 3` | 允许丢帧，不允许卡住采集队列 |

**权限**：屏幕录制是**第三个** TCC 服务，和前两个不能混用：

| 服务 | 用途 | 只读预检 |
| --- | --- | --- |
| Accessibility | 读 AX 树、热键 | `AXIsProcessTrusted()` |
| Input Monitoring | CGEventTap 监听 | `CGPreflightListenEventAccess()` |
| **Screen Recording** | ScreenCaptureKit | `CGPreflightScreenCaptureAccess()` |

`CGRequestScreenCaptureAccess()` 会弹系统框，**只允许在用户明确点"开始录制视频"时调用**；`doctor` 只用 preflight，不弹框。权限归属仍是发起请求的二进制，所以**视频采集要放进独立的 `dist/cuekeeper-video`**：单独授权，不会因为录制器重编译而同时丢掉输入监控。ad-hoc 签名每次重编译换 cdhash 就要重新授权——这一条对屏幕录制比前两个更烦（macOS 15 起会周期性提醒），正式签名前默认关闭视频。

**帧状态优先级**：`SCFrameStatus` 为 `.complete` 才进入像素处理；`.idle` 直接丢弃（窗口没有重绘）；`.blank` / `.suspended` / `.stopped` 记一条 gap（窗口最小化、被系统挂起、采集结束）。`.idle` 的语义、以及 macOS 15+ 上 `SCShareableContent` 在未获持久授权时可能只返回被挑选过的窗口（`-3801`），都必须在真机上确认，列入 HAOC-76。

## 3. 帧差

每帧先降采样成 **160×90 灰度缩略图**（BT.601 整数：`(77R + 150G + 29B) >> 8`），分成 **8×8 的块 → 20×12 = 240 格**，与"上一次保留下来的帧"逐格比较，块内取**最大**绝对差。

- 块内用最大值而不是均值：一个字符的笔画在缩略图里只会压到 1–2 个像素，均值会被稀释掉。
- 判"变了"的块阈值 **24**（约 255 的 9.4%）。

| 变化 | 变了的块（阈值 24） | 块内最大差 | 处理 |
| --- | --- | --- | --- |
| 光标闪烁（2×28 px） | 0（阈值 12 时是 2 块） | 19 | 丢弃 |
| 输入一个字符 | 1 | 35 | 保留（churn 通道） |
| 状态栏时钟跳秒 | 1 | 117 | 保留（churn 通道，限流） |
| 4pt 小圆点出现 | 1 | 26 | 保留 |
| 内容滚动 14px | 122 | 131 | 保留（structural 通道，跑满上限） |
| 视频播放 / 动画 | 71 | 143 | 保留（structural 通道） |

**决策**（每帧一次，O(240)）：

```
0 块        → 不产帧（窗口静止，或只有光标闪烁）
≥ 4 块      → structural：产帧，受 maxFps=10 限制
1..3 块     → churn：产帧，但最多每 500 ms 一帧
```

- `maxFps = 10`，`churnMinIntervalMs = 500`，均为可配置项，写进 manifest 以便复现。
- **自比较残差为 0**（同一帧渲染两次，240 格全部 0 差）：ScreenCaptureKit 给的是精确像素、没有编码噪声，所以阈值不是用来抗噪，而是用来**压掉人眼无感的变化**。这条很重要：它意味着阈值可以定得比较高而不会漏掉真实内容变化。
- `0 块` 时**不做任何补帧**。不改"每 30 s 插一帧"：实测单帧 hold 599.9 s 时精确 seek 正常（见第 4 节），补帧只会白花字节。若将来真机上发现某个播放器在超长 hold 上 seek 抖动，再引入 `maxFrameHoldMs = 60000`，代价是每 10 分钟 10 帧、约 10 KB。
- 误判的边界：
  - **单个小控件自更新**（时钟、进度条、转圈）→ churn 通道，最坏 2 帧/秒 ≈ 1.0 KB/帧 ≈ **1.2 MB / 10 分钟**。实测"只录 caret 抖动"就是 1.1 MB；这是"窗口里有个秒表一直动"的成本上限。
  - **滚动条淡出、悬停高亮、tooltip** → 视为真实 UI 状态变化，保留。它们确实是测试者要看到的画面。
  - **窗口整体重排**（缩放、切页）→ structural，跑满 10 fps。
  - **视频播放** → structural，10 fps 上限直接封顶，编码码率由 `AVVideoAverageBitRateKey` 管。
- 缩略图只用于判定，**从不用于断言**。断言继续用 AX 树与截图，见第 12 节。

## 4. 时间轴：VFR / 容器 / 播放器

**可行，实测通过。**

- 时间刻度：PTS 以 1 tick = 1 ms 追加（`movieTimeScale = 1000`），容器里的 **track** 时间刻度由编码器决定（实测 600，即 1.67 ms/格），ms 值是它的整数倍所以不丢精度。PTS 逐个追加、不重排（`AVVideoAllowFrameReorderingKey = false` → PTS == DTS，seek 时不用处理 B 帧重排）。
- 追加的 PTS 就是"这一帧生效的时刻"：空闲段不追加帧，前一帧自然 hold 到下一帧。这既是"静止帧 + 时间跳点"，也是 VFR 的唯一实现方式（没有"空洞帧"概念）。
- **`endSession(atSourceTime:)` 必须显式给到停止时刻**，不能取自"最后一帧 + 一帧时长"。实验里漏掉这一步，600 s 的片子被写成 30 s——这是实现时最容易踩的坑。
- 容器实测（`design/video/experiment/out/*.mp4`）：

| 文件 | 样本数 | `stts` 条目 | 时长 | 含义 |
| --- | --- | --- | --- | --- |
| `cfr-10fps-600s.mp4` | 6000 | 1 条 `(6000, 60ms)` | 600.000 s | 恒定帧率基线 |
| `vfr-diff-driven-600s.mp4` | 281 | 2 条 `(1, 1200ms)`、`(280, 60ms)` | 600.000 s | 首帧 hold 2 s，之后 10 fps |
| `still-vfr-600s.mp4` | 2 | 1 条 `(2, 599.9s)` | 600.000 s | 单帧 hold 599.9 s |

  三个文件的 track timescale 都是 600（movie timescale 是 1000）——**换算 PTS 要用 track 的时间刻度**，manifest 里因此显式记录 `timebase.timescale`。

- **播放器兼容性**：
  - MP4 用 `stts` 表达变长帧是规范内行为（不是 hack），`ctts` 为空。
  - AVFoundation 回读：PTS 与写入值逐帧一致（281/281、2/2）；`AVAssetImageGenerator` 在 tolerance 全 0 下，对 `still-vfr-600s.mp4` 在 0 s / 200 s / 599 s 都能出帧，说明**长 hold 中间任意位置可精确 seek**。
  - Chrome / Safari / Firefox 的 demuxer 都能处理 VFR（Safari 走 AVFoundation，Chrome/Firefox 走 ffmpeg 系）。**本轮没有浏览器实测**（不启动 GUI），列为 HAOC-76 待办。
  - 建议保持 1 个关键帧/100 个**已编码**帧（`AVVideoMaxKeyFrameIntervalKey = 100`）。注意它数的是帧不是秒：稀疏会话里就是"每几分钟一个关键帧"，实测 599 s 的 hold 只有 1 个关键帧也能精确 seek，所以不需要按秒限制。
- **HEVC 不划算**（实测同一时间线 H.264 2.13 MB vs HEVC 2.68 MB，3 Mbps 目标下没有优势），而 H.264 在老机器和 Windows 上无需额外解码器。默认 H.264，HEVC 留作后置选项。

## 5. 与动作时间轴对齐

report 已经有 `startedAt`（wall clock）与每个条目的 `atMs`（相对毫秒）。视频有自己的一根 PTS 轴，需要**一次性锚点**：

```json
"anchor": {
  "reportStartedAt": "2026-11-22T03:12:44.120Z",
  "videoStartOffsetMs": 236,
  "method": "host_clock"
}
```

- 采集子进程启动前，父进程同时取一次 `CMClockGetTime(CMClockGetHostTimeClock())` 与 `Date()`，把"宿主时钟 → wall"的偏差交给子进程；子进程所有 PTS 都由宿主时钟换算，**不用 `Date()` 打时间戳**（NTP 跳变会让整段视频错位）。
- 定义：`videoPtsMs = reportAtMs − videoStartOffsetMs`。`videoStartOffsetMs` 允许负值（采集先于 `startedAt` 起跑），范围 −5000..+60000，超出即视为锚点失效。
- 换算精度：track timescale 600 → 1.67 ms 粒度，10 fps 下无感。
- 查看器：点时间线某一步 →

  ```js
  const t = clamp((entry.atMs - anchor.videoStartOffsetMs) / 1000, 0, video.duration);
  video.currentTime = t;
  ```

  落在 hold 区间内时，浏览器给的是被 hold 的那一帧，正好是"这一步发生时的画面"。
- **"等待 5m12s"** 直接用 report 相邻条目的 `atMs + duration` 差值渲染，不依赖视频；视频只负责让这个区间能点进去看。所以没有视频时这个徽章照样有。

## 6. 体积

模型（1080p、H.264、3 Mbps 目标、`allowFrameReordering=false`、`ExpectedSourceFrameRate=10`）：

```
bytes ≈ I + Σ(structural 帧 × P_active) + Σ(churn 帧 × P_churn) + 关键帧额外开销 + 容器开销
实测常数：I ≈ 43 KB，P_unchanged ≈ 0.5–0.9 KB，P_active(滚动) ≈ 3.1 KB，P_churn(单块) ≈ 1.0 KB，
容器开销 ≈ 1 KB（实测 moov 707 B），关键帧额外 ≈ 38 KB/个
```

用模型算"2 s 空闲 + 28 s 滚动 + 570 s 空闲（光标闪烁）"这段 10 分钟：

| 情形 | 帧数 | 实测字节 | 对比 CFR |
| --- | --- | --- | --- |
| CFR 10 fps（基线） | 6000 | 6.05 MB | 1× |
| VFR，光标闪烁按"变了"处理（最坏情况） | 1424 | 2.13 MB | 2.8× 小 |
| VFR，按第 3 节阈值（光标闪烁被丢） | 281 | 1.00 MB | 6.1× 小 |
| 纯静态 600 s，CFR 10 fps（10 s 关键帧间隔） | 6000 | 5.34 MB | — |
| 纯静态 600 s，CFR 单关键帧 | 6000 | 3.11 MB | — |
| **纯静态 600 s，VFR 两帧** | 2 | **58 KB** | **91× 小** |

- 预测 vs 实测：最坏情况模型 2.02 MB、实测 2.13 MB（+5%），够用来排容量。
- 编码 CPU（M4、1080p、VideoToolbox）：6000 帧 26.3 s（4.4 ms/帧）vs 281 帧 1.28 s（4.6 ms/帧）——**4.4 ms/帧的固定成本，省帧就是省等比例 CPU**，但 10 fps 下只占单核 4%，所以 CPU 不是主要理由，字节和"长空闲不占空间"才是。
- 经验值：连续滚动的 1 小时约 `3.1 KB × 10 × 3600 ≈ 111 MB`（3 Mbps 上限会先到顶），即 **约 1.9 MB/分钟活跃**（`3.1 KB × 10 × 60 ≈ 1.9 MB`）；纯空闲 1 小时按 VFR 只多几十 KB。
- 阶段 1 的 PNG 胶片条更贵：同一帧 1080p PNG 实测 48 KB（合成稀疏画面，真实密集文字界面会更高），300 张约 15 MB 起，比同内容 H.264 视频大一个量级。所以胶片条只做降级产物，默认不上传。

## 7. 契约：视频是可选 artifact

**不动 `report.json`**（v1 schema 是 `additionalProperties: false`，加字段就是破坏性改动）。视频的元数据挂在 `manifest.json` 的可选 `video`（阶段 2）与 `filmstrip`（阶段 1/降级）上：

```json
{
  "version": 1,
  "flowId": "…", "flowSha256": "…", "reportStartedAt": "…",
  "files": {
    "index.html": { "bytes": 48211, "sha256": "…" },
    "media/session.mp4": { "bytes": 997756, "sha256": "…" }
  },
  "assets": [ { "path": "assets/click-body/before.png", "entryId": "click-body", "role": "screenshot-before", "bytes": 40233 } ],
  "video": {
    "kind": "video", "status": "complete",
    "path": "media/session.mp4", "bytes": 997756, "durationMs": 600000, "frames": 281,
    "codec": "h264", "container": "mp4", "width": 1920, "height": 1080,
    "timebase": { "timescale": 600, "firstPtsMs": 0 },
    "anchor": { "reportStartedAt": "…", "videoStartOffsetMs": 236, "method": "host_clock" },
    "sampling": { "thumbnail": "160x90", "blockThreshold": 24, "structuralBlocks": 4,
                  "maxFps": 10, "churnMinIntervalMs": 500 },
    "gaps": [ { "fromMs": 30000, "toMs": 599900, "reason": "unchanged" } ]
  }
}
```

- 字段级约束见 [视频 artifact schema 草案](../design/video/manifest-video.schema.json) 与 [胶片条 schema 草案](../design/video/manifest-filmstrip.schema.json)（Draft-07，`additionalProperties: false`）。运行时契约由 `src/video.ts` 的 TypeBox 定义，`pnpm schemas:write` 生成并随 `pnpm build --check` 校验 [schemas/video.schema.json](../schemas/video.schema.json)。
- `status`：`complete` / `truncated` / `skipped`；`code` 只允许封闭枚举（见第 9 节）。
- `gaps` 上限 64 条，仅用于排错与"等待"提示；超出的省略，不报错。查看器没有 `gaps` 时按 report 的 `atMs` 自己算。
- **旧报告兼容**：没有 `video` 字段 → 查看器显示"本报告未录制会话视频"，其余不动；`report pack` 照旧。`video.status = "skipped"` 时给一句原因，不显示空播放器。
- **打包体积护栏**：`media/` 超过 128 MB 警告，超过 512 MB 拒绝打包（`MEDIA_TOO_LARGE`），`--no-media` 可显式剔除。
- **上传**：现有规则是"上传版 ZIP 默认省略 `assets/`"，`media/` 一并默认省略——视频是**本地产物**，除非项目显式白名单。
- 资产角色新增 `video` / `filmstrip`（`src/assets.ts` 的 `AssetRole`），打包时按 `media/` 目录整体带入。

## 8. 隐私

- **默认关闭**。CLI 要显式 `--video`，工作台运行确认里单独一个默认不勾的复选框，页面写清"会录下目标窗口画面"。
- **只录目标窗口**，不录桌面、不录其他应用、不录通知；`capturesAudio = false`，没有音频轨也就不存在"麦克风"这套授权。
- **暂停**：复用录制侧的暂停热键思路，运行中可暂停/继续；`--video-mask x,y,w,h`（可重复）在编码前把矩形涂黑，用于固定出现在窗口里的账号名、地址栏、内部 ID。
- **含 Shell 秘密引用的流程**：报告侧已经有"只保留元数据"的规则，视频没有等价脱敏能力——建议这类流程默认不录视频，或只在输入秘密的步骤前后暂停；文档要明确"视频可能录到屏幕上的一切，包括键入内容与密码可见的掩码框"。
- **保留与访问**：视频留在运行产物的 `media/` 目录，和截图同级同生命周期；默认不进上传包；分享 ZIP 前 `--no-media` 是推荐动作。ZIP 没有加密，谁拿到 ZIP 谁能看——这一句要写进 `docs/report.md`。
- **视频不是判据**：通过/失败只由断言、结构化结果与截图决定；视频缺失、损坏、被剔除都不改变运行结论。

## 9. 降级

| 情形 | 行为 | manifest |
| --- | --- | --- |
| 未授权屏幕录制（preflight false） | 不启动采集，运行继续；**不弹框** | `status: skipped`, `code: SCREEN_CAPTURE_NOT_AUTHORIZED` |
| 运行中授权被撤销 / `SCStream` 报错 | 立即 finalize 已写入的部分，运行继续 | `status: truncated`, `code: SCREEN_CAPTURE_LOST` |
| 窗口最小化 / 被系统挂起 | 收不到 `.complete` 帧，最后一帧自然 hold；恢复后继续 | 追加 `gaps`, `reason: window_not_drawing` |
| 窗口关闭 / 应用退出 | 停止采集并 finalize | `code: WINDOW_CLOSED`, `truncatedAtMs` |
| 编码器不可用（无硬件编码、VM/CI） | 直接走阶段 1 路径，只写 PNG 关键帧 | `status: skipped`, `code: ENCODE_UNAVAILABLE` |
| 编码中失败（`writer.status == .failed`） | 丢弃 `.partial.mp4`，保留胶片条，不回退重试 | `code: ENCODE_FAILED` |
| 磁盘剩余 < 500 MB | 停止采集并 finalize | `code: DISK_FULL` |
| 运行被中断（Ctrl-C / `INTERRUPTED`） | 正常 finalize，保证文件可播 | `status: complete`（或 `truncated`） |

- 采集永远写信到 `media/session.partial.mp4`，**成功 finalize 后才改名**；崩溃时 manifest 里绝不出现半截文件路径。
- 不做"失败重试"：与现有"执行不自动重试"一致，失败就是一条 `code`。
- 取消/中断路径必须关流、停 writer、等 `finishWriting` 回调，不留常驻线程。

## 10. 分阶段

| | 阶段 1 | 阶段 2 |
| --- | --- | --- |
| 输出 | 变化帧 PNG 胶片条（`media/filmstrip/*.png` + `manifest.filmstrip`） | VFR MP4（`media/session.mp4` + `manifest.video`） |
| 依赖 | ScreenCaptureKit + 帧差 | 再加 AVAssetWriter/VideoToolbox |
| 体积（10 min 混合会话） | 280 张 × ~48 KB ≈ 13 MB 起 | 1.0 MB |
| 查看器改动 | 复用现有图片预览 + 一条缩略图带 | `<video>`、seek、gap 徽章 |
| 主要风险 | TCC 授权、`.idle` 语义、多显示器缩放 | 编码器可用性、finalize/中断、播放器 seek |
| 交付价值 | 能看到"什么时候变了" | 能连续看过程 |

**推荐**：阶段 1 与阶段 2 **共用同一个原生采集模块**，所以阶段 1 是阶段 2 的前置，没法跳过。实施顺序是 阶段 1 → 阶段 2，但**阶段 1 的胶片条不承诺长期做产品面**：阶段 2 上线后它退化为
(a) 编码器不可用时的自动降级，
(b) `--no-media`/超大文件被剔除后仍保留的低成本证据。
这样既先把权限与阈值这两处真风险验证掉，又不必维护第二套查看器形态。

## 11. 实施拆分（文件级）

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `native/video-capture.swift`（新） | `SCShareableContent` 按 `windowID` 找窗口、`SCStream`、帧状态过滤、160×90 缩略图分块差、决策、`AVAssetWriter` 追加、JSONL 事件（`ready`/`sample`/`gap`/`finalized`） | 高：唯一需要真机验证的部分 |
| `scripts/build-recorder.sh` | 多编一个 `dist/cuekeeper-video`；`-target arm64-apple-macos13.0`（窗口级 filter 需要 13+） | 低 |
| `src/video-capture.ts`（新） | preflight、spawn、解析 JSONL、finalize、组装 manifest 对象、超时与退出码映射 | 中 |
| `src/video-diff.ts`（新，纯函数） | 与原生同一套阈值的参考实现，供单测与文档共享；原生侧用它的一致性用例做自检 | 低 |
| `src/assets.ts` | `AssetRole` 加 `video` / `filmstrip`；`.mp4`/`.mov` 与 `media/` 目录纳入 | 低 |
| `src/report.ts` | `files` 允许 `media/*`；体积护栏；manifest 写 `video` / `filmstrip` | 中：打包可复现性（mtime 已固定） |
| `src/cli.ts` | `run --video [--video-max-mb] [--video-mask]`；`doctor` 加只读 `screen recording` 检查 | 低 |
| `src/viewer.ts` | 视频面板、步骤→seek、等待徽章、缺失/降级提示；`index.html` 仍自包含，视频用相对路径 | 中 |
| `src/workbench.ts` + `workbench/*.html` | 运行确认里"录制会话视频"勾选与容量提示 | 低 |
| `docs/report.md` / `docs/architecture.md` | 视频产物、体积、隐私、降级 | 低 |
| `schemas/manifest.schema.json`（新增） | 先只覆盖现有 manifest 字段 + 可选 `video`；`src/contracts.ts` 生成 | 下一单 |

依赖：`ScreenCaptureKit`（macOS 12.3+，窗口级 filter 13+）、`AVFoundation`/`VideoToolbox`。**不引入 ffmpeg 或任何外部二进制**。

## 12. 测试

| 层 | 内容 | 是否需要桌面/权限 |
| --- | --- | --- |
| 单测（Node） | `video-diff` 参考实现：光标闪烁→0 块、单字符→1 块、滚动→≥4 块、小圆点→1 块、阈值边界与偶数尺寸裁剪 | 否 |
| 原生自检 | `cuekeeper-video --self-test`：合成 N 帧写临时 mp4，断言帧数/PTS/时长与"最后一帧 hold 到停止时刻"；再验证 `.partial` 不残留 | 否（不碰 SCK） |
| 离线实验 | 本仓库 `design/video/experiment/encode-spike.swift` 与 `diff-spike.swift`，就是这一套的独立版本 | 否 |
| 集成 | 真实窗口录制、`.idle` 语义、最小化/关闭、多显示器缩放、TCC 撤销 | 是 → **HAOC-76** |

## 13. 未验证项（HAOC-76 清单）

1. `.idle` 帧在目标窗口静止时是否稳定下发（以及 `queueDepth` 对它的影响）。
2. macOS 15+/27 上未获持久授权时 `SCShareableContent` 是否只返回被挑选窗口、`-3801` 的实际触发条件；`SCContentSharingPicker` 是否必须。
3. Retina 2x + 多显示器 + 窗口跨屏时 `contentRect × pointPixelScale` 的实际像素尺寸与封顶后的清晰度。
4. 最小化窗口是否真的停止下发帧；恢复后是否立即有一帧 `.complete`。
5. 浏览器（Chrome/Safari/Firefox）对长 hold 与 VFR 的 seek 行为。
6. 真实密集文字界面下的 I 帧与 P 帧字节（本文件的 43 KB / 3.1 KB 来自稀疏合成画面）。
7. 屏幕录制的 TCC 重授权频率（ad-hoc 每次重编译 vs 正式签名后）。
