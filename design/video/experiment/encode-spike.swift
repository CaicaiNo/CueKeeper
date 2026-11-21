// Offline size / VFR / seek spike for HAOC-91.
//
// Generates synthetic 1920x1080 screen-like frames in memory and encodes them with
// AVAssetWriter + VideoToolbox. It never touches ScreenCaptureKit, never asks for a
// permission, never opens a window: the frames come from CoreGraphics drawing.
//
//   swiftc -O encode-spike.swift -o out/encode-spike && out/encode-spike out/
//
// Outputs one JSON line per scenario on stdout and writes the .mp4 files next to it.

import AVFoundation
import CoreGraphics
import Foundation

let W = 1920
let H = 1080
let TIMESCALE: Int32 = 1000         // 1 tick == 1 ms, so report atMs maps directly
let TICK_PER_FRAME: Int64 = 100      // 10 fps
let BITRATE = 3_000_000             // 3 Mbps cap, a realistic screen-capture setting

func log(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

// MARK: - deterministic synthetic screen

struct Deterministic {
    var state: UInt64
    mutating func next() -> UInt64 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }
    mutating func int(_ bound: Int) -> Int {
        guard bound > 0 else { return 0 }
        return Int(next() % UInt64(bound))
    }
}

/// Draws a window-like screen: title bar, toolbar row, 30 lines of fake glyph runs.
/// `offset` scrolls the body, `caret` toggles a 2x28 caret, `highlight` moves a
/// selection box. All deterministic so every run produces identical pixels.
func drawScreen(_ ctx: CGContext, offset: Int, caret: Bool, highlightRow: Int?) {
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

    // title bar
    ctx.setFillColor(CGColor(red: 0.93, green: 0.93, blue: 0.94, alpha: 1))
    ctx.fill(CGRect(x: 0, y: H - 56, width: W, height: 56))
    ctx.setFillColor(CGColor(red: 0.2, green: 0.2, blue: 0.22, alpha: 1))
    ctx.fill(CGRect(x: 20, y: H - 38, width: 220, height: 18))

    // body: fake text lines, stable per line index
    var rng = Deterministic(state: 0x9E3779B97F4A7C15)
    let lineHeight = 30
    let firstLine = 0
    var y = H - 90 - offset
    var line = firstLine
    while y > -lineHeight {
        if y < H - 90 && y > 10 {
            var x = 40
            let words = 3 + (line % 5)
            for _ in 0..<words {
                let w = 40 + rng.int(180)
                if x + w > W - 40 { break }
                ctx.setFillColor(CGColor(red: 0.25, green: 0.25, blue: 0.27, alpha: 1))
                // a glyph run is not a solid block: split into small marks
                var mx = x
                while mx < x + w - 3 {
                    let piece = 3 + rng.int(9)
                    if mx + piece > x + w { break }
                    ctx.fill(CGRect(x: mx, y: y + 6, width: piece, height: 14))
                    mx += piece + 3
                }
                x += w + 18
            }
        }
        y -= lineHeight
        line += 1
    }

    if let row = highlightRow {
        ctx.setFillColor(CGColor(red: 0.30, green: 0.55, blue: 0.95, alpha: 0.35))
        ctx.fill(CGRect(x: 30, y: H - 92 - row * lineHeight - offset, width: W - 80, height: lineHeight))
    }

    if caret {
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 620, y: H - 300, width: 2, height: 28))
    }
}

// MARK: - encoder

enum EncodeError: Error { case message(String) }

func encode(frames: [(ptsTicks: Int64, image: CGImage)], path: String, codec: AVVideoCodecType, keyFrameInterval: Int = 100, bitrate: Int = BITRATE, endTicks: Int64? = nil) throws -> Int64 {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.removeItem(at: url)

    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    writer.movieTimeScale = TIMESCALE
    writer.shouldOptimizeForNetworkUse = false
    writer.movieFragmentInterval = .invalid

    var compression: [String: Any] = [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: codec == .h264 ? AVVideoProfileLevelH264MainAutoLevel : AVVideoProfileLevelH264MainAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: keyFrameInterval,  // counts *encoded* frames, not seconds
        AVVideoExpectedSourceFrameRateKey: 10,
        AVVideoAllowFrameReorderingKey: false,   // keep PTS == DTS, simpler seeking
    ]
    if codec == .hevc {
        compression = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalKey: keyFrameInterval,
            AVVideoExpectedSourceFrameRateKey: 10,
            AVVideoAllowFrameReorderingKey: false,
        ]
    }

    let settings: [String: Any] = [
        AVVideoCodecKey: codec,
        AVVideoWidthKey: W,
        AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: compression,
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: W,
            kCVPixelBufferHeightKey as String: H,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ])
    writer.add(input)
    guard writer.startWriting() else {
        throw EncodeError.message("startWriting failed: \(String(describing: writer.error))")
    }
    writer.startSession(atSourceTime: .zero)

    guard let pool = adaptor.pixelBufferPool else {
        throw EncodeError.message("no pixel buffer pool")
    }
    let cs = CGColorSpaceCreateDeviceRGB()
    let bitmap = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue

    for frame in frames {
        while !input.isReadyForMoreMediaData {
            usleep(2000)
        }
        var pb: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) == kCVReturnSuccess, let buffer = pb else {
            throw EncodeError.message("pixel buffer allocation failed")
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        guard let base = CVPixelBufferGetBaseAddress(buffer),
              let ctx = CGContext(data: base, width: W, height: H, bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                  space: cs, bitmapInfo: bitmap) else {
            throw EncodeError.message("bitmap context on pixel buffer failed")
        }
        ctx.draw(frame.image, in: CGRect(x: 0, y: 0, width: W, height: H))
        CVPixelBufferUnlockBaseAddress(buffer, [])

        let pts = CMTime(value: frame.ptsTicks, timescale: TIMESCALE)
        if !adaptor.append(buffer, withPresentationTime: pts) {
            throw EncodeError.message("append failed at \(frame.ptsTicks): \(String(describing: writer.error))")
        }
    }

    input.markAsFinished()
    // The last frame is held until the session stops, which for a VFR capture is well
    // after the last appended frame. Ending the session at the last frame silently
    // truncates the movie: the 600 s run below becomes 30 s if this is not set.
    let end = CMTime(value: endTicks ?? (frames.last!.ptsTicks + TICK_PER_FRAME), timescale: TIMESCALE)
    writer.endSession(atSourceTime: end)

    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()

    guard writer.status == .completed else {
        throw EncodeError.message("finishWriting status \(writer.status.rawValue): \(String(describing: writer.error))")
    }
    let attrs = try FileManager.default.attributesOfItem(atPath: path)
    return (attrs[.size] as? NSNumber)?.int64Value ?? 0
}

// MARK: - read back

struct ReadBack {
    var durationMs: Double
    var sampleCount: Int
    var firstPtsMs: Double
    var lastPtsMs: Double
    var seekOk: [String: Bool]
    var ptsMatch: Bool
}

func readBack(path: String, expected: [Int64], probeTimesMs: [Double]) throws -> ReadBack {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = CMTimeGetSeconds(asset.duration) * 1000
    guard let track = asset.tracks(withMediaType: .video).first else {
        throw EncodeError.message("no video track in \(path)")
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ])
    reader.add(output)
    reader.startReading()

    // The mp4 track keeps its own timescale, so compare in milliseconds, not in ticks.
    var ptsMs: [Double] = []
    while let sample = output.copyNextSampleBuffer() {
        ptsMs.append(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000)
    }
    let expectedMs = expected.map { Double($0) * 1000 / Double(TIMESCALE) }
    let ptsMatch = ptsMs.count == expectedMs.count &&
        zip(ptsMs, expectedMs).allSatisfy { abs($0 - $1) <= 1.0 }

    // A player seeking into a long-held frame: exact tolerance, no interpolation.
    let generator = AVAssetImageGenerator(asset: asset)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    generator.appliesPreferredTrackTransform = true
    var seekOk: [String: Bool] = [:]
    for t in probeTimesMs {
        let time = CMTime(value: Int64(t.rounded()), timescale: 1000)
        do {
            let image = try generator.copyCGImage(at: time, actualTime: nil)
            seekOk[String(format: "%.0f", t)] = image.width == W && image.height == H
        } catch {
            seekOk[String(format: "%.0f", t)] = false
        }
    }

    return ReadBack(durationMs: duration, sampleCount: ptsMs.count,
                    firstPtsMs: ptsMs.first ?? 0,
                    lastPtsMs: ptsMs.last ?? 0,
                    seekOk: seekOk, ptsMatch: ptsMatch)
}

// MARK: - scenarios

struct Scenario {
    var name: String
    var path: String
    var frames: [(Int64, CGImage)]
}

/// The proposed sampling governor, evaluated on real frame timestamps.
/// active: content changed structurally (>= 4 blocks); churn: only 1..3 blocks changed.
struct Governor {
    var maxFps = 10
    var churnMinIntervalMs = 500.0
    var maxFrameHoldMs = 30_000.0
    var lastEmitMs = -1.0
    var lastChangeMs = -1.0

    mutating func consider(atMs: Double, active: Bool) -> Bool {
        if lastEmitMs < 0 { lastEmitMs = atMs; lastChangeMs = atMs; return true }
        if active {
            if atMs - lastEmitMs >= 1000.0 / Double(maxFps) - 0.001 {
                lastEmitMs = atMs; lastChangeMs = atMs; return true
            }
            return false
        }
        if atMs - lastEmitMs >= churnMinIntervalMs {
            lastEmitMs = atMs; lastChangeMs = atMs; return true
        }
        return false
    }

    /// Liveness keyframe: keeps the longest frame duration bounded so every player can seek.
    mutating func liveness(atMs: Double) -> Bool {
        if atMs - lastEmitMs >= maxFrameHoldMs {
            lastEmitMs = atMs; return true
        }
        return false
    }
}

func main() throws {
    let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "out"
    try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

    let cs = CGColorSpaceCreateDeviceRGB()
    let bitmap = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                        space: cs, bitmapInfo: bitmap)!
    ctx.interpolationQuality = .none

    func image(offset: Int = 0, caret: Bool = false, highlight: Int? = nil) -> CGImage {
        drawScreen(ctx, offset: offset, caret: caret, highlightRow: highlight)
        return ctx.makeImage()!
    }

    // Content timeline shared by all scenarios: 600 s at 10 Hz.
    //   0.0 -  2.0 s  idle, caret blinking (window focused, user thinking)
    //   2.0 - 30.0 s  activity: scrolling text + moving selection
    //  30.0 - 600.0 s idle, caret blinking
    let totalMs = 600_000.0
    func content(atMs t: Double) -> (active: Bool, key: String) {
        if t >= 2000 && t < 30000 {
            return (true, "scroll-\(Int(t / 100))")
        }
        return (false, "caret-\(Int(t / 530) % 2)")
    }

    // ---- 1. CFR 10 fps over the whole session (the baseline a naive recorder writes)
    var cfr: [(Int64, CGImage)] = []
    var t = 0.0
    while t < totalMs {
        if t >= 2000 && t < 30000 {
            let i = Int((t - 2000) / 100)
            cfr.append((Int64(t.rounded()), image(offset: (i * 14) % 420, caret: false, highlight: (i / 4) % 6)))
        } else {
            cfr.append((Int64(t.rounded()), image(caret: Int(t / 530) % 2 == 0)))
        }
        t += 100
    }
    let cfrStart = Date()
    let cfrBytes = try encode(frames: cfr, path: "\(outDir)/cfr-10fps-600s.mp4", codec: .h264)
    let cfrSeconds = Date().timeIntervalSince(cfrStart)
    let cfrBack = try readBack(path: "\(outDir)/cfr-10fps-600s.mp4", expected: cfr.map { $0.0 },
                               probeTimesMs: [1000, 20_000, 300_000, 599_000])
    log("cfr: \(cfr.count) frames, \(cfrBytes) bytes")
    print("{\"scenario\":\"cfr-10fps-600s\",\"encodeSeconds\":\(String(format: "%.2f", cfrSeconds)),\"frames\":\(cfr.count),\"bytes\":\(cfrBytes),\"durationMs\":\(Int(cfrBack.durationMs)),\"ptsMatch\":\(cfrBack.ptsMatch),\"seek\":\(cfrBack.seekOk)}")

    // ---- 2. VFR with the governor. The pixel work is done by the diff stage in the
    //         real pipeline; here a frame is marked active when the content timeline
    //         says so, churn otherwise. PTS follow the delivered frame timestamps.
    var gov = Governor()
    var vfr: [(Int64, CGImage)] = []
    t = 0.0
    while t < totalMs {
        let c = content(atMs: t)
        if gov.consider(atMs: t, active: c.active) {
            if c.active {
                let i = Int((t - 2000) / 100)
                vfr.append((Int64(t.rounded()), image(offset: (i * 14) % 420, caret: false, highlight: (i / 4) % 6)))
            } else {
                vfr.append((Int64(t.rounded()), image(caret: Int(t / 530) % 2 == 0)))
            }
        }
        t += 100
    }
    let vfrBytes = try encode(frames: vfr, path: "\(outDir)/vfr-governed-600s.mp4", codec: .h264)
    let vfrBack = try readBack(path: "\(outDir)/vfr-governed-600s.mp4", expected: vfr.map { $0.0 },
                               probeTimesMs: [1000, 20_000, 60_000, 300_000, 590_000])
    log("vfr: \(vfr.count) frames, \(vfrBytes) bytes")
    print("{\"scenario\":\"vfr-governed-600s\",\"frames\":\(vfr.count),\"bytes\":\(vfrBytes),\"durationMs\":\(Int(vfrBack.durationMs)),\"ptsMatch\":\(vfrBack.ptsMatch),\"seek\":\(vfrBack.seekOk)}")

    // ---- 3. Same VFR timeline but with a 30 s maximum frame hold (liveness keyframes),
    //         to compare player-seek friendliness against multi-minute holds.
    var gov2 = Governor()
    var vfr2: [(Int64, CGImage)] = []
    t = 0.0
    while t < totalMs {
        let c = content(atMs: t)
        if gov2.consider(atMs: t, active: c.active) || gov2.liveness(atMs: t) {
            if c.active {
                let i = Int((t - 2000) / 100)
                vfr2.append((Int64(t.rounded()), image(offset: (i * 14) % 420, caret: false, highlight: (i / 4) % 6)))
            } else {
                vfr2.append((Int64(t.rounded()), image(caret: Int(t / 530) % 2 == 0)))
            }
        }
        t += 100
    }
    let vfr2Bytes = try encode(frames: vfr2, path: "\(outDir)/vfr-maxhold-600s.mp4", codec: .h264)
    let vfr2Back = try readBack(path: "\(outDir)/vfr-maxhold-600s.mp4", expected: vfr2.map { $0.0 },
                                probeTimesMs: [1000, 20_000, 300_000, 599_000])
    log("vfr-maxhold: \(vfr2.count) frames, \(vfr2Bytes) bytes")
    print("{\"scenario\":\"vfr-maxhold-600s\",\"frames\":\(vfr2.count),\"bytes\":\(vfr2Bytes),\"durationMs\":\(Int(vfr2Back.durationMs)),\"ptsMatch\":\(vfr2Back.ptsMatch),\"seek\":\(vfr2Back.seekOk)}")

    // ---- 4. Perfectly static 600 s: CFR (6000 identical frames) vs 2-sample VFR.
    let still = image()
    var cfrStill: [(Int64, CGImage)] = []
    for i in 0..<6000 { cfrStill.append((Int64(i) * TICK_PER_FRAME, still)) }
    let cfrStillBytes = try encode(frames: cfrStill, path: "\(outDir)/still-cfr-10fps-600s.mp4", codec: .h264)
    log("still-cfr: \(cfrStillBytes) bytes")

    // The same 6000 frames without the forced 10 s keyframe interval: isolates the
    // per-"nothing changed" frame cost from the per-keyframe cost.
    let cfrStillNokfBytes = try encode(frames: cfrStill, path: "\(outDir)/still-cfr-nokf-600s.mp4",
                                       codec: .h264, keyFrameInterval: 6000)
    log("still-cfr-nokf: \(cfrStillNokfBytes) bytes")
    print("{\"scenario\":\"still-cfr-keyframe-effect\",\"withKeyframeEvery100\":\(cfrStillBytes),\"singleKeyframe\":\(cfrStillNokfBytes)}")

    let vfrStill: [(Int64, CGImage)] = [(0, still), (599_900, still)]
    let vfrStillBytes = try encode(frames: vfrStill, path: "\(outDir)/still-vfr-600s.mp4", codec: .h264)
    let vfrStillBack = try readBack(path: "\(outDir)/still-vfr-600s.mp4", expected: [0, 599_900],
                                    probeTimesMs: [0, 200_000, 599_000])
    log("still-vfr: \(vfrStillBytes) bytes")
    print("{\"scenario\":\"still-cfr-vs-vfr-600s\",\"cfrFrames\":6000,\"cfrBytes\":\(cfrStillBytes),\"vfrFrames\":2,\"vfrBytes\":\(vfrStillBytes),\"vfrDurationMs\":\(Int(vfrStillBack.durationMs)),\"vfrSeek\":\(vfrStillBack.seekOk),\"vfrPtsMatch\":\(vfrStillBack.ptsMatch)}")

    // ---- 5. HEVC on the same governed VFR timeline (codec comparison).
    let hevcBytes = try encode(frames: vfr, path: "\(outDir)/vfr-governed-600s-hevc.mp4", codec: .hevc)
    print("{\"scenario\":\"vfr-governed-600s-hevc\",\"frames\":\(vfr.count),\"bytes\":\(hevcBytes)}")
    log("hevc: \(hevcBytes) bytes")

    // ---- 6. Per-frame cost constants used by the volume model. One keyframe only,
    //         so the delta between 1 frame and 101 frames is 100 plain P frames.
    func micro(_ name: String, count: Int, make: (Int) -> CGImage) throws -> Int64 {
        var frames: [(Int64, CGImage)] = []
        for i in 0..<count { frames.append((Int64(i) * TICK_PER_FRAME, make(i))) }
        return try encode(frames: frames, path: "\(outDir)/micro-\(name).mp4", codec: .h264, keyFrameInterval: 100_000)
    }
    func activeImage(_ i: Int) -> CGImage {
        image(offset: (i * 14) % 420, caret: false, highlight: (i / 4) % 6)
    }
    func caretImage(_ i: Int) -> CGImage { image(caret: i % 2 == 0) }

    let iBytes = try micro("i-frame", count: 1) { _ in still }
    let skipBytes = try micro("skip-p", count: 101) { _ in still }
    let activeBytes = try micro("active-p", count: 101) { activeImage($0) }
    let churnBytes = try micro("caret-p", count: 101) { caretImage($0) }
    let pSkip = Double(skipBytes - iBytes) / 100
    let pActive = Double(activeBytes - iBytes) / 100
    let pChurn = Double(churnBytes - iBytes) / 100
    log("micro: I=\(iBytes) skip=\(pSkip) active=\(pActive) caret=\(pChurn)")
    print(String(format: "{\"scenario\":\"per-frame-bytes\",\"iFrame\":%d,\"pSkip\":%.0f,\"pActive\":%.0f,\"pCaretChurn\":%.0f}", iBytes, pSkip, pActive, pChurn))

    // Model check against the measured 600 s governed VFR run.
    let model = Double(iBytes) + 279 * pActive + 1140 * pChurn
    print(String(format: "{\"scenario\":\"volume-model-check\",\"measured\":%d,\"modelled\":%.0f}", vfrBytes, model))

    // ---- 7. What the block threshold of 24 actually does: the caret-blink pair shows
    //        2 changed cells at threshold 12 and 0 at threshold 24, so a diff-driven
    //         sampler emits nothing while a focused window blinks. Re-run the same
    //         session with that decision, and check the bitrate sensitivity of a
    //        "nothing changed" frame.
    var gov3 = Governor()
    var realistic: [(Int64, CGImage)] = []
    t = 0.0
    while t < totalMs {
        let active = t >= 2000 && t < 30000            // scroll region: >= 4 changed blocks
        // The first captured frame is always kept, so the movie starts at PTS 0 and
        // report-relative time maps without a leading gap.
        let changed = active || t == 0                   // caret blink: 0 blocks at threshold 24
        if changed && gov3.consider(atMs: t, active: active) {
            let i = Int((t - 2000) / 100)
            realistic.append((Int64(t.rounded()), image(offset: (i * 14) % 420, caret: false, highlight: (i / 4) % 6)))
        }
        t += 100
    }
    if realistic.isEmpty { realistic.append((0, image())) }
    let realStart = Date()
    let realisticBytes = try encode(frames: realistic, path: "\(outDir)/vfr-diff-driven-600s.mp4", codec: .h264, endTicks: 600_000)
    let realSeconds = Date().timeIntervalSince(realStart)
    let realisticBack = try readBack(path: "\(outDir)/vfr-diff-driven-600s.mp4", expected: realistic.map { $0.0 },
                                     probeTimesMs: [1000, 20_000, 300_000, 599_000])
    log("vfr-diff-driven: \(realistic.count) frames, \(realisticBytes) bytes")
    print("{\"scenario\":\"vfr-diff-driven-600s\",\"encodeSeconds\":\(String(format: "%.2f", realSeconds)),\"frames\":\(realistic.count),\"bytes\":\(realisticBytes),\"durationMs\":\(Int(realisticBack.durationMs)),\"firstPtsMs\":\(realisticBack.firstPtsMs),\"lastPtsMs\":\(realisticBack.lastPtsMs),\"ptsMatch\":\(realisticBack.ptsMatch),\"seek\":\(realisticBack.seekOk)")

    for kbps in [3_000, 1_500, 800] {
        var frames: [(Int64, CGImage)] = []
        for i in 0..<101 { frames.append((Int64(i) * TICK_PER_FRAME, still)) }
        let bytes = try encode(frames: frames, path: "\(outDir)/micro-skip-\(kbps).mp4", codec: .h264,
                               keyFrameInterval: 100_000, bitrate: kbps * 1000)
        let one = try encode(frames: [(0, still)], path: "\(outDir)/micro-one-\(kbps).mp4", codec: .h264,
                             keyFrameInterval: 100_000, bitrate: kbps * 1000)
        print(String(format: "{\"kind\":\"bitrate-sweep\",\"kbps\":%d,\"iFrame\":%d,\"perUnchangedFrame\":%.0f}", kbps, one, Double(bytes - one) / 100))
    }
}

try main()
