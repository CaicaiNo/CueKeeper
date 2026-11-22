// Optional session video: window-scoped ScreenCaptureKit capture, frame-diff
// sampling and AVAssetWriter H.264/H.264 VFR encoding.
//
// The helper is deliberately separate from the input recorder: screen recording
// is its own TCC service, so rebuilding one binary must not invalidate the
// other's permission. It never records audio, never captures the whole screen
// and never requests permission on its own:
//
//   cuekeeper-video --preflight          (read-only CGPreflightScreenCaptureAccess)
//   cuekeeper-video --self-test          (offline synthetic frames, no SCK)
//   cuekeeper-video --capture --window-id 42 --out media/session.partial.mp4 ...
//
// `--capture` is closed unless CUEKEEPER_VIDEO_CAPTURE=1: the pre-signing build
// ships only the synthetic self-test. `--preflight` never prompts for access and
// requesting access is left to the user, never to the runner.
//
// Capture writes JSON lines to stdout: ready / sample / gap / paused / resumed /
// finalized. The parent turns those into manifest.video; a `.partial.mp4` is
// only renamed after finishWriting succeeds.

import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

// MARK: - JSON output

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let text = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    print(text)
    fflush(stdout)
}

private let outputLock = NSLock()

func emitError(_ code: String, _ message: String) {
    emit(["error": ["code": code, "message": message]])
}

func flag(_ name: String, _ args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

func intFlag(_ name: String, _ args: [String]) -> Int? {
    guard let raw = flag(name, args) else { return nil }
    return Int(raw)
}

func even(_ value: Int) -> Int {
    let clamped = max(16, min(4096, value))
    return clamped % 2 == 0 ? clamped : clamped - 1
}

// MARK: - Sampling constants (must match src/video-diff.ts)

struct Sampling {
    let thumbnailWidth = 160
    let thumbnailHeight = 90
    let blockSize = 8
    let blockThreshold = 24
    let structuralBlocks = 4
    let maxFps: Int
    let churnMinIntervalMs = 500

    init(maxFps: Int) { self.maxFps = maxFps }
    var intervalMs: Int { max(1, 1000 / maxFps) }
}

// MARK: - Frame helpers

func hostMs() -> Double {
    // Monotonic host clock: NTP jumps must not move video PTS.
    let time = CMClockGetTime(CMClockGetHostTimeClock())
    return CMTimeGetSeconds(time) * 1000
}

func makeGrayThumbnail(_ pixelBuffer: CVPixelBuffer, _ sampling: Sampling) -> [UInt8]? {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    guard let context = CGContext(
        data: base, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    ), let image = context.makeImage() else { return nil }

    let tw = sampling.thumbnailWidth
    let th = sampling.thumbnailHeight
    guard let thumbContext = CGContext(
        data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: tw * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    ) else { return nil }
    thumbContext.interpolationQuality = .high
    thumbContext.draw(image, in: CGRect(x: 0, y: 0, width: tw, height: th))
    guard let thumbData = thumbContext.data else { return nil }
    let bytes = thumbData.assumingMemoryBound(to: UInt8.self)
    var gray = [UInt8](repeating: 0, count: tw * th)
    for index in 0..<(tw * th) {
        let blue = Int(bytes[index * 4])
        let green = Int(bytes[index * 4 + 1])
        let red = Int(bytes[index * 4 + 2])
        gray[index] = UInt8((77 * red + 150 * green + 29 * blue) >> 8)
    }
    return gray
}

func changedBlocks(_ left: [UInt8], _ right: [UInt8], _ sampling: Sampling) -> Int {
    let tw = sampling.thumbnailWidth
    let th = sampling.thumbnailHeight
    let block = sampling.blockSize
    let columns = (tw + block - 1) / block
    let rows = (th + block - 1) / block
    var changed = 0
    for row in 0..<rows {
        for column in 0..<columns {
            var localMax = 0
            let yEnd = min((row + 1) * block, th)
            let xEnd = min((column + 1) * block, tw)
            for y in (row * block)..<yEnd {
                let base = y * tw
                for x in (column * block)..<xEnd {
                    let delta = abs(Int(left[base + x]) - Int(right[base + x]))
                    if delta > localMax { localMax = delta }
                }
            }
            if localMax >= sampling.blockThreshold { changed += 1 }
        }
    }
    return changed
}

func copyPixelBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(source)
    let height = CVPixelBufferGetHeight(source)
    var destination: CVPixelBuffer?
    let attributes: [String: Any] = [
        kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ]
    guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA,
                              attributes as CFDictionary, &destination) == kCVReturnSuccess,
          let copy = destination else { return nil }
    CVPixelBufferLockBaseAddress(source, .readOnly)
    CVPixelBufferLockBaseAddress(copy, [])
    defer {
        CVPixelBufferUnlockBaseAddress(copy, [])
        CVPixelBufferUnlockBaseAddress(source, .readOnly)
    }
    guard let sourceBase = CVPixelBufferGetBaseAddress(source),
          let copyBase = CVPixelBufferGetBaseAddress(copy) else { return nil }
    let sourceRow = CVPixelBufferGetBytesPerRow(source)
    let copyRow = CVPixelBufferGetBytesPerRow(copy)
    let rowBytes = min(sourceRow, copyRow)
    for row in 0..<height {
        memcpy(copyBase.advanced(by: row * copyRow), sourceBase.advanced(by: row * sourceRow), rowBytes)
    }
    return copy
}

func applyMasks(_ pixelBuffer: CVPixelBuffer, _ masks: [CGRect]) {
    guard !masks.isEmpty else { return }
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    for mask in masks {
        let x0 = max(0, Int(mask.origin.x))
        let y0 = max(0, Int(mask.origin.y))
        let x1 = min(width, x0 + Int(mask.width))
        let y1 = min(height, y0 + Int(mask.height))
        guard x1 > x0, y1 > y0 else { continue }
        for row in y0..<y1 {
            memset(base.advanced(by: row * bytesPerRow + x0 * 4), 0, (x1 - x0) * 4)
        }
    }
}

// MARK: - Writer

struct TrackInfo {
    var timescale: Int
    var firstPtsMs: Int
    var durationMs: Int
}

enum WriterError: Error {
    case startFailed(String)
    case appendFailed(String)
    case finishFailed(String)
}

final class VideoWriter {
    let url: URL
    let width: Int
    let height: Int
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private var started = false
    private(set) var frames = 0
    private var firstPtsMs = 0

    init(url: URL, width: Int, height: Int, fps: Int) throws {
        self.url = url
        self.width = width
        self.height = height
        do {
            writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        } catch {
            throw WriterError.startFailed(error.localizedDescription)
        }
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 3_000_000,
                // PTS == DTS keeps seeks simple and avoids reordering latency.
                AVVideoAllowFrameReorderingKey: false,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: 100,
            ],
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
        )
        guard writer.canAdd(input) else { throw WriterError.startFailed("writer rejected the video input") }
        writer.add(input)
    }

    func start() throws {
        guard !started else { return }
        guard writer.startWriting() else {
            throw WriterError.startFailed(writer.error?.localizedDescription ?? "startWriting failed")
        }
        // The first accepted frame defines PTS 0, so the movie starts where the
        // report timeline starts rather than at an arbitrary host clock value.
        writer.startSession(atSourceTime: .zero)
        started = true
    }

    func append(_ buffer: CVPixelBuffer, ptsMs: Int) throws {
        if !started { try start() }
        if frames == 0 { firstPtsMs = ptsMs }
        // The input pulls asynchronously even in realtime mode; appending while
        // it is not ready raises an Objective-C exception rather than failing.
        var waitedMs = 0
        while !input.isReadyForMoreMediaData && waitedMs < 5000 {
            Thread.sleep(forTimeInterval: 0.002)
            waitedMs += 2
        }
        guard input.isReadyForMoreMediaData else {
            throw WriterError.appendFailed("the writer stayed busy for 5 s")
        }
        let time = CMTime(value: CMTimeValue(ptsMs), timescale: 1000)
        guard adaptor.append(buffer, withPresentationTime: time) else {
            throw WriterError.appendFailed(writer.error?.localizedDescription ?? "append failed")
        }
        frames += 1
    }

    /// `stopMs` is the explicit stop time: the last frame is held until then.
    func finish(stopMs: Int) throws -> TrackInfo {
        if !started { try start() }
        input.markAsFinished()
        // Forgetting this writes a movie that ends at the last sample instead of
        // at the real stop time; it is the easiest mistake to make here.
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(max(stopMs, firstPtsMs)), timescale: 1000))
        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting { semaphore.signal() }
        semaphore.wait()
        guard writer.status == .completed else {
            throw WriterError.finishFailed(writer.error?.localizedDescription ?? "finishWriting failed")
        }
        let asset = AVURLAsset(url: url)
        let track = asset.tracks(withMediaType: .video).first
        let timescale = Int(track?.naturalTimeScale ?? 600)
        let durationMs = Int((CMTimeGetSeconds(asset.duration) * 1000).rounded())
        return TrackInfo(timescale: max(1, timescale), firstPtsMs: firstPtsMs, durationMs: max(0, durationMs))
    }
}

// MARK: - Offline self-test

func syntheticFrame(width: Int, height: Int, scroll: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess,
          let pixelBuffer = buffer else { return nil }
    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer),
          let context = CGContext(
            data: base, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
          ) else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(CGColor(red: 0.23, green: 0.23, blue: 0.25, alpha: 1))
    for line in 0..<14 {
        let y = height - 40 - line * 18 - scroll
        context.fill(CGRect(x: 24, y: y, width: width - 80 - (line % 3) * 30, height: 8))
    }
    return pixelBuffer
}

func encodeScenario(url: URL, count: Int, strideMs: Int, stopMs: Int, scrollPerFrame: Bool) throws {
    try? FileManager.default.removeItem(at: url)
    let width = 640
    let height = 360
    let writer = try VideoWriter(url: url, width: width, height: height, fps: 10)
    for index in 0..<count {
        guard let frame = syntheticFrame(width: width, height: height,
                                         scroll: scrollPerFrame ? index * 3 : 0) else {
            throw WriterError.appendFailed("synthetic frame")
        }
        try writer.append(frame, ptsMs: index * strideMs)
    }
    _ = try writer.finish(stopMs: stopMs)
}

func sampleCount(_ url: URL) throws -> Int {
    let asset = AVURLAsset(url: url)
    let reader = try AVAssetReader(asset: asset)
    guard let track = asset.tracks(withMediaType: .video).first else { return 0 }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    reader.startReading()
    var count = 0
    // AVAssetReader also hands back empty boundary buffers (numSamples == 0)
    // around edit lists; only real encoded samples count.
    while let sample = output.copyNextSampleBuffer() {
        if CMSampleBufferGetNumSamples(sample) > 0 { count += 1 }
    }
    return count
}

func assetInspection(_ url: URL) throws -> [String: Any] {
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
        throw WriterError.finishFailed("no video track")
    }
    let durationMs = Int((CMTimeGetSeconds(asset.duration) * 1000).rounded())
    let samples = try sampleCount(url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let seekMs = max(0, durationMs - 500)
    var seeked = false
    do {
        _ = try generator.copyCGImage(at: CMTime(value: CMTimeValue(seekMs), timescale: 1000), actualTime: nil)
        seeked = true
    } catch {
        seeked = false
    }
    return [
        "durationMs": durationMs,
        "samples": samples,
        "timescale": Int(track.naturalTimeScale),
        "seekedNearEnd": seeked,
    ]
}

/// Coarse fingerprint of a decoded frame. Two decodes of the same sample match
/// exactly; content that scrolled by more than a few pixels does not.
func frameSignature(_ image: CGImage) -> Int {
    let size = 16
    let count = size * size * 4
    let data = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
    defer { data.deallocate() }
    data.initialize(repeating: 0, count: count)
    guard let context = CGContext(
        data: data, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
    ) else { return -1 }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
    var sum = 0
    for index in 0..<(size * size) {
        sum += Int(data[index * 4]) + Int(data[index * 4 + 1]) + Int(data[index * 4 + 2])
    }
    return sum
}

func seekSignature(_ url: URL, atMs: Int) throws -> Int {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let image = try generator.copyCGImage(
        at: CMTime(value: CMTimeValue(atMs), timescale: 1000), actualTime: nil)
    return frameSignature(image)
}

/// Two samples nine seconds apart: the first is held across most of the movie,
/// and the two frames carry visibly different content.
func encodeHoldScenario(url: URL, secondPtsMs: Int, stopMs: Int) throws {
    try? FileManager.default.removeItem(at: url)
    let width = 640
    let height = 360
    let writer = try VideoWriter(url: url, width: width, height: height, fps: 10)
    guard let first = syntheticFrame(width: width, height: height, scroll: 0),
          let second = syntheticFrame(width: width, height: height, scroll: 120) else {
        throw WriterError.appendFailed("synthetic frame")
    }
    try writer.append(first, ptsMs: 0)
    try writer.append(second, ptsMs: secondPtsMs)
    _ = try writer.finish(stopMs: stopMs)
}

func selfTest() -> Int32 {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("cuekeeper-video-self-test-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    do {
        // A static ten-second window: two samples, the first held to the stop time.
        let partial = root.appendingPathComponent("session.partial.mp4")
        let staticURL = root.appendingPathComponent("session.mp4")
        try encodeScenario(url: partial, count: 2, strideMs: 9999, stopMs: 10_000, scrollPerFrame: false)
        let staticBytes = (try FileManager.default.attributesOfItem(atPath: partial.path)[.size] as? NSNumber)?.intValue ?? 0
        try FileManager.default.moveItem(at: partial, to: staticURL)
        let staticInfo = try assetInspection(staticURL)

        // The same ten seconds at a fixed 10 fps for the size comparison.
        let cfrURL = root.appendingPathComponent("cfr.mp4")
        try encodeScenario(url: cfrURL, count: 100, strideMs: 100, stopMs: 10_000, scrollPerFrame: true)
        let cfrBytes = (try FileManager.default.attributesOfItem(atPath: cfrURL.path)[.size] as? NSNumber)?.intValue ?? 0
        let cfrInfo = try assetInspection(cfrURL)

        // Seeking inside a long hold must decode the picture that is held there,
        // not merely some frame. The second sample only arrives at 9 s.
        let holdURL = root.appendingPathComponent("hold.mp4")
        try encodeHoldScenario(url: holdURL, secondPtsMs: 9000, stopMs: 10_000)
        let firstSignature = try seekSignature(holdURL, atMs: 0)
        let heldSignature = try seekSignature(holdURL, atMs: 4_500)
        let laterSignature = try seekSignature(holdURL, atMs: 9_500)
        let holdMatched = firstSignature == heldSignature
        let laterDiffers = abs(laterSignature - firstSignature) > 200

        let staticFrames = staticInfo["samples"] as? Int ?? 0
        let staticDuration = staticInfo["durationMs"] as? Int ?? 0
        let ok = staticFrames == 2 && abs(staticDuration - 10_000) <= 200 &&
            staticInfo["seekedNearEnd"] as? Bool == true &&
            cfrInfo["samples"] as? Int == 100 && cfrBytes > 0 && staticBytes < cfrBytes &&
            holdMatched && laterDiffers &&
            FileManager.default.fileExists(atPath: staticURL.path)
        emit([
            "kind": "self-test",
            "ok": ok,
            "static": ["frames": staticFrames, "bytes": staticBytes, "durationMs": staticDuration],
            "cfr": ["frames": cfrInfo["samples"] as? Int ?? 0, "bytes": cfrBytes,
                    "durationMs": cfrInfo["durationMs"] as? Int ?? 0],
            "hold": ["firstSignature": firstSignature, "heldSignature": heldSignature,
                     "laterSignature": laterSignature],
            "checks": [
                "two samples hold to the stop time",
                "static movie is smaller than the CFR baseline",
                "seek inside a long hold returns the held picture",
                "a sample after the hold returns different content",
                "partial file is renamed only after finishWriting",
            ],
        ])
        return ok ? 0 : 1
    } catch {
        emitError("ENCODE_FAILED", "\(error)")
        return 1
    }
}

// MARK: - Capture

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let windowID: CGWindowID
    private let outputURL: URL
    private let finalURL: URL
    private let sampling: Sampling
    private let masks: [CGRect]
    private let state = NSLock()
    private let sampleQueue = DispatchQueue(label: "ai.multica.cuekeeper.video.samples")
    // One paired reading converts the monotonic host clock to wall time. PTS
    // stay on the host clock, so an NTP jump cannot move a sample.
    private let wallOffsetMs = Date().timeIntervalSince1970 * 1000 - hostMs()

    private var writer: VideoWriter?
    private var previous: [UInt8]?
    private var lastEmittedMs: Int?
    private var lastChurnMs: Int?
    private var firstHostMs: Double?
    private var stopHostMs: Double?
    private var frames = 0
    private var paused = false
    private var pauseStartedHost: Double?
    private var pausedAccumMs = 0.0
    private var openGapStartHost: Double?
    private var openGapReason = "unchanged"
    private var gaps: [[String: Any]] = []
    private var stopRequested = false
    private var failureCode: String?

    init(windowID: CGWindowID, outputURL: URL, finalURL: URL, sampling: Sampling, masks: [CGRect]) {
        self.windowID = windowID
        self.outputURL = outputURL
        self.finalURL = finalURL
        self.sampling = sampling
        self.masks = masks
    }

    // MARK: control

    func requestStop() {
        state.lock()
        stopRequested = true
        stopHostMs = hostMs()
        closeGap(atHost: stopHostMs ?? hostMs())
        state.unlock()
    }

    var isStopping: Bool {
        state.lock(); defer { state.unlock() }
        return stopRequested
    }

    func setPaused(_ value: Bool) {
        state.lock()
        defer { state.unlock() }
        guard paused != value else { return }
        let now = hostMs()
        if value {
            paused = true
            pauseStartedHost = now
            emit(["kind": "paused", "atMs": ptsMs(atHost: now)])
        } else {
            paused = false
            if let started = pauseStartedHost {
                pausedAccumMs += now - started
                appendGap(fromHost: started, toHost: now, reason: "paused")
            }
            pauseStartedHost = nil
            emit(["kind": "resumed", "atMs": ptsMs(atHost: now)])
        }
    }

    // MARK: helpers

    private func ptsMs(atHost host: Double) -> Int {
        guard let first = firstHostMs else { return 0 }
        let pause = pausedAccumMs + (pauseStartedHost.map { host - $0 } ?? 0)
        return max(0, Int(((host - first) * 1000 - pause).rounded()))
    }

    private func closeGap(atHost host: Double) {
        guard let start = openGapStartHost else { return }
        appendGap(fromHost: start, toHost: host, reason: openGapReason)
        openGapStartHost = nil
    }

    private func appendGap(fromHost: Double, toHost: Double, reason: String) {
        guard let first = firstHostMs else { return }
        let from = max(0, Int(((fromHost - first) * 1000).rounded()))
        let to = max(from, Int(((toHost - first) * 1000).rounded()))
        guard to - from >= 250, gaps.count < 64 else { return }
        gaps.append(["fromMs": from, "toMs": to, "reason": reason])
        emit(["kind": "gap", "fromMs": from, "toMs": to, "reason": reason])
    }

    private func openGap(atHost host: Double, reason: String) {
        if openGapStartHost == nil {
            openGapStartHost = host
            openGapReason = reason
        }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let status = frameStatus(sampleBuffer)
        let now = hostMs()
        state.lock()
        let isPaused = paused
        state.unlock()
        if isPaused { return }
        switch status {
        case .complete:
            handleComplete(pixelBuffer, atHost: now)
        case .idle:
            state.lock()
            openGap(atHost: now, reason: "unchanged")
            state.unlock()
        case .blank, .suspended, .stopped:
            state.lock()
            openGap(atHost: now, reason: "window_not_drawing")
            state.unlock()
        @unknown default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        state.lock()
        if failureCode == nil { failureCode = "SCREEN_CAPTURE_LOST" }
        stopRequested = true
        stopHostMs = hostMs()
        closeGap(atHost: stopHostMs ?? hostMs())
        state.unlock()
        emitError("SCREEN_CAPTURE_LOST", error.localizedDescription)
    }

    private func frameStatus(_ sampleBuffer: CMSampleBuffer) -> SCFrameStatus {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[SCStreamFrameInfo.status] as? Int,
              let status = SCFrameStatus(rawValue: raw) else {
            return .complete
        }
        return status
    }

    private func handleComplete(_ pixelBuffer: CVPixelBuffer, atHost host: Double) {
        state.lock()
        if stopRequested { state.unlock(); return }
        state.unlock()

        guard let thumbnail = makeGrayThumbnail(pixelBuffer, sampling) else { return }

        state.lock()
        if firstHostMs == nil { firstHostMs = host }
        let pts = ptsMs(atHost: host)
        let previousThumb = previous
        var emitFrame = false
        var changed = 0
        if previousThumb == nil {
            emitFrame = true
        } else if let previousThumb {
            changed = changedBlocks(previousThumb, thumbnail, sampling)
            if changed >= sampling.structuralBlocks {
                if lastEmittedMs == nil || pts - (lastEmittedMs ?? 0) >= sampling.intervalMs {
                    emitFrame = true
                }
            } else if changed > 0 {
                if lastChurnMs == nil || pts - (lastChurnMs ?? 0) >= sampling.churnMinIntervalMs {
                    emitFrame = true
                }
            }
        }
        if emitFrame {
            previous = thumbnail
            lastEmittedMs = pts
            if changed > 0 && changed < sampling.structuralBlocks { lastChurnMs = pts }
            closeGap(atHost: host)
        }
        state.unlock()

        guard emitFrame else { return }
        guard let copy = copyPixelBuffer(pixelBuffer) else { return }
        applyMasks(copy, masks)
        do {
            if writer == nil {
                writer = try VideoWriter(url: outputURL, width: CVPixelBufferGetWidth(copy),
                                          height: CVPixelBufferGetHeight(copy),
                                          fps: sampling.maxFps)
            }
            try writer?.append(copy, ptsMs: pts)
            frames += 1
            emit(["kind": "sample", "ptsMs": pts, "changedBlocks": changed])
        } catch {
            state.lock()
            if failureCode == nil { failureCode = "ENCODE_FAILED" }
            stopRequested = true
            stopHostMs = hostMs()
            state.unlock()
            emitError("ENCODE_FAILED", "\(error)")
        }
    }

    // MARK: run

    func run() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
            emitError("WINDOW_CLOSED", "The target window is no longer available")
            throw WriterError.startFailed("window closed")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        // pointPixelScale arrived in macOS 14; on 13 assume Retina, which is what
        // every supported Apple Silicon Mac reports anyway.
        let scale: CGFloat = {
            if #available(macOS 14.0, *) { return CGFloat(filter.pointPixelScale) }
            return 2
        }()
        let longest = max(window.frame.width, window.frame.height) * scale
        let ratio: CGFloat = longest > 1920 ? 1920 / longest : 1
        let width = even(Int((window.frame.width * scale * ratio).rounded()))
        let height = even(Int((window.frame.height * scale * ratio).rounded()))

        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 3
        configuration.capturesAudio = false
        configuration.showsCursor = false

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        emit(["kind": "ready", "width": width, "height": height])

        while !isStopping {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try? await stream.stopCapture()

        state.lock()
        let stop = stopHostMs ?? hostMs()
        let code = failureCode
        let pausedMs = Int(pausedAccumMs.rounded())
        let stopPtsMs = ptsMs(atHost: stop)
        let firstSampleWallMs = firstHostMs.map { Int((wallOffsetMs + $0).rounded()) }
        state.unlock()

        var payload: [String: Any] = [
            "status": code == nil ? "complete" : "truncated",
            "durationMs": stopPtsMs,
            "frames": frames,
            "width": width,
            "height": height,
            "codec": "h264",
            "pausedMs": pausedMs,
        ]
        // PTS 0 is the first kept sample, so its wall time is the video anchor.
        if let firstSampleWallMs { payload["firstSampleWallMs"] = firstSampleWallMs }
        if let code { payload["code"] = code; payload["truncatedAtMs"] = stopPtsMs }
        do {
            if let writer {
                let track = try writer.finish(stopMs: stopPtsMs)
                payload["timescale"] = track.timescale
                payload["firstPtsMs"] = track.firstPtsMs
                payload["durationMs"] = track.durationMs
                try? FileManager.default.removeItem(at: finalURL)
                try FileManager.default.moveItem(at: outputURL, to: finalURL)
            } else {
                // No frame was ever accepted: nothing to finalize.
                try? FileManager.default.removeItem(at: outputURL)
                payload = ["status": "skipped", "code": code ?? "WINDOW_NOT_DRAWING"]
            }
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            payload = ["status": "skipped", "code": "ENCODE_FAILED"]
        }
        emit(["kind": "finalized", "payload": payload])
    }
}

func readMasks(_ args: [String]) -> [CGRect] {
    var masks: [CGRect] = []
    var index = 0
    while index < args.count {
        if args[index] == "--mask", index + 1 < args.count {
            let parts = args[index + 1].split(separator: ",").compactMap { Int($0) }
            if parts.count == 4 {
                masks.append(CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]))
            }
            index += 2
            continue
        }
        index += 1
    }
    return Array(masks.prefix(16))
}

@main
struct VideoCommand {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else {
            emitError("INPUT_ERROR", "Missing command")
            exit(2)
        }
        switch command {
        case "--preflight":
            // CGPreflightScreenCaptureAccess never shows a TCC prompt.
            emit(["screenRecording": CGPreflightScreenCaptureAccess()])
        case "--self-test":
            exit(selfTest())
        case "--capture":
            // The pre-signing release keeps the real capture entry closed: the
            // signed helper will be the only build that opens it. `--self-test`
            // still works because it never touches ScreenCaptureKit.
            guard ProcessInfo.processInfo.environment["CUEKEEPER_VIDEO_CAPTURE"] == "1" else {
                emitError("CAPTURE_DISABLED", "Window capture is disabled until the helper is signed")
                exit(2)
            }
            guard let windowID = intFlag("--window-id", args), windowID > 0,
                  let out = flag("--out", args) else {
                emitError("INPUT_ERROR", "capture needs --window-id and --out")
                exit(2)
            }
            let outputURL = URL(fileURLWithPath: out)
            let finalURL = URL(fileURLWithPath: out.replacingOccurrences(of: ".partial.mp4", with: ".mp4"))
            let fps = max(1, min(30, intFlag("--max-fps", args) ?? 10))
            let capture = Capture(
                windowID: CGWindowID(windowID), outputURL: outputURL, finalURL: finalURL,
                sampling: Sampling(maxFps: fps), masks: readMasks(args)
            )
            // stdin drives pause/resume/stop; closing stdin also stops.
            DispatchQueue.global().async {
                while let line = readLine(strippingNewline: true) {
                    switch line {
                    case "pause": capture.setPaused(true)
                    case "resume": capture.setPaused(false)
                    case "stop": capture.requestStop(); return
                    default: break
                    }
                }
                capture.requestStop()
            }
            do {
                try await capture.run()
                exit(0)
            } catch {
                emitError("SCREEN_CAPTURE_LOST", "\(error)")
                exit(3)
            }
        default:
            emitError("INPUT_ERROR", "Unknown command")
            exit(2)
        }
    }
}
