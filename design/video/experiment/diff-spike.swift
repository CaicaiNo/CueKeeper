// Offline frame-diff spike for HAOC-91.
//
// Answers "how big is a change, at which thumbnail size, with which threshold" for
// the failure modes that matter (caret blink, one typed character, a clock digit,
// scrolling, video playback). Frames are drawn in memory with CoreGraphics: no
// ScreenCaptureKit, no permission, no window.
//
//   swiftc -O diff-spike.swift -o out/diff-spike && out/diff-spike
//
// Prints one JSON object per line: signature cost, then one row per fixture pair.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let W = 1920
let H = 1080
let SW: CGFloat = 2                  // Retina: 1 pt == 2 px

struct Deterministic {
    var state: UInt64
    mutating func next() -> UInt64 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }
    mutating func int(_ bound: Int) -> Int { bound > 0 ? Int(next() % UInt64(bound)) : 0 }
}

struct Fixture {
    var scroll = 0
    var caret = false
    var extraWord = false
    var clockPhase = 0
    var noise = false
    var tinyDot = false
}

func draw(_ ctx: CGContext, _ f: Fixture) {
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

    if f.noise {
        // Simulates video playback: every pixel changes every frame.
        var rng = Deterministic(state: 0xDEADBEEF &+ UInt64(f.clockPhase))
        let w = 900, h = 500
        let buf = UnsafeMutablePointer<UInt32>.allocate(capacity: w * h)
        for i in 0..<(w * h) {
            let v = UInt32(rng.int(256))
            buf[i] = (255 << 24) | (v << 16) | (v << 8) | v
        }
        let cs = CGColorSpaceCreateDeviceRGB()
        let provider = CGDataProvider(data: Data(bytes: buf, count: w * h * 4) as CFData)!
        let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32,
                            bytesPerRow: w * 4, space: cs,
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        buf.deallocate()
        ctx.draw(image, in: CGRect(x: 300, y: 300, width: 900, height: 500))
    }

    ctx.setFillColor(CGColor(red: 0.93, green: 0.93, blue: 0.94, alpha: 1))
    ctx.fill(CGRect(x: 0, y: H - 56, width: W, height: 56))
    ctx.setFillColor(CGColor(red: 0.2, green: 0.2, blue: 0.22, alpha: 1))
    ctx.fill(CGRect(x: 20, y: H - 38, width: 220, height: 18))

    var rng = Deterministic(state: 0x9E3779B97F4A7C15)
    var y = H - 90 - f.scroll
    var line = 0
    while y > -30 {
        if y < H - 90 && y > 10 {
            var x = 40
            let words = 3 + (line % 5)
            for _ in 0..<words {
                let w = 40 + rng.int(180)
                if x + w > W - 40 { break }
                var mx = x
                while mx < x + w - 3 {
                    let piece = 3 + rng.int(9)
                    if mx + piece > x + w { break }
                    ctx.setFillColor(CGColor(red: 0.25, green: 0.25, blue: 0.27, alpha: 1))
                    ctx.fill(CGRect(x: mx, y: y + 6, width: piece, height: 14))
                    mx += piece + 3
                }
                x += w + 18
            }
            if f.extraWord && line == 3 {
                // One more glyph run: what typing one character looks like at token level.
                ctx.setFillColor(CGColor(red: 0.25, green: 0.25, blue: 0.27, alpha: 1))
                ctx.fill(CGRect(x: 40 + 0, y: y + 6, width: 22, height: 14))
            }
        }
        y -= 30
        line += 1
    }

    if f.caret {
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 620, y: H - 300, width: 2, height: 28))
    }

    if f.clockPhase > 0 {
        // A small status widget, 1 pt tall text: 46x18 px region.
        ctx.setFillColor(CGColor(red: 0.35, green: 0.35, blue: 0.38, alpha: 1))
        let widths = [8, 7, 4, 9]
        var cx = W - 140
        for i in 0..<4 {
            let w = widths[(i + f.clockPhase) % widths.count]
            ctx.fill(CGRect(x: cx, y: 40, width: w, height: 18))
            cx += 12
        }
    }

    if f.tinyDot {
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 1500, y: 900, width: 4 * Int(SW), height: 4 * Int(SW)))
    }
}

// MARK: - thumbnail + block diff

func makeContext(_ w: Int, _ h: Int) -> CGContext {
    CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
              space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)!
}

func thumbnail(_ image: CGImage, width: Int, height: Int) -> [UInt8] {
    let ctx = makeContext(width, height)
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let data = ctx.data!.assumingMemoryBound(to: UInt8.self)
    var gray = [UInt8](repeating: 0, count: width * height)
    for i in 0..<(width * height) {
        let b = Int(data[i * 4])
        let g = Int(data[i * 4 + 1])
        let r = Int(data[i * 4 + 2])
        gray[i] = UInt8((77 * r + 150 * g + 29 * b) >> 8)
    }
    return gray
}

struct BlockDiff {
    var changedBlocks: Int
    var maxBlockDelta: Int
    var meanAbsDiff: Double
    var blocks: Int
}

func blockDiff(_ a: [UInt8], _ b: [UInt8], width: Int, height: Int, threshold: Int, block: Int = 8) -> BlockDiff {
    let bx = (width + block - 1) / block
    let by = (height + block - 1) / block
    var changed = 0
    var maxDelta = 0
    var sum = 0.0
    for row in 0..<by {
        for col in 0..<bx {
            var localMax = 0
            var localSum = 0
            var n = 0
            for y in (row * block)..<min((row + 1) * block, height) {
                for x in (col * block)..<min((col + 1) * block, width) {
                    let i = y * width + x
                    let d = abs(Int(a[i]) - Int(b[i]))
                    if d > localMax { localMax = d }
                    localSum += d
                    n += 1
                    sum += Double(d)
                }
            }
            _ = localSum / max(n, 1)
            if localMax >= threshold { changed += 1 }
            if localMax > maxDelta { maxDelta = localMax }
        }
    }
    return BlockDiff(changedBlocks: changed, maxBlockDelta: maxDelta,
                     meanAbsDiff: sum / Double(width * height), blocks: bx * by)
}

func main() {
    let cs = CGColorSpaceCreateDeviceRGB()
    let full = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                         space: cs,
                         bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)!
    full.interpolationQuality = .none

    func render(_ f: Fixture) -> CGImage {
        draw(full, f)
        return full.makeImage()!
    }

    let base = render(Fixture())

    // ---- cost of one signature at each thumbnail size
    for size in [(160, 90), (128, 72), (96, 54), (64, 36)] {
        let start = Date()
        let iterations = 100
        for _ in 0..<iterations { _ = thumbnail(base, width: size.0, height: size.1) }
        let ms = Date().timeIntervalSince(start) * 1000 / Double(iterations)
        print(String(format: "{\"kind\":\"signature-cost\",\"width\":%d,\"height\":%d,\"msPerFrame\":%.2f,\"bytesPerFrame\":%d}",
                     size.0, size.1, ms, size.0 * size.1))
    }

    let variants: [(String, Fixture)] = [
        ("caret-blink", Fixture(caret: true)),
        ("typed-one-char", Fixture(extraWord: true)),
        ("clock-tick", Fixture(clockPhase: 1)),
        ("scroll-14px", Fixture(scroll: 14)),
        ("tiny-4pt-dot", Fixture(tinyDot: true)),
        ("video-playback", Fixture(clockPhase: 7, noise: true)),
    ]

    for size in [(160, 90), (96, 54)] {
        let tb = thumbnail(base, width: size.0, height: size.1)
        for (name, fixture) in variants {
            let tv = thumbnail(render(fixture), width: size.0, height: size.1)
            for threshold in [6, 12, 24] {
                let d = blockDiff(tb, tv, width: size.0, height: size.1, threshold: threshold)
                print(String(format: "{\"kind\":\"diff\",\"thumb\":\"%dx%d\",\"fixture\":\"%@\",\"threshold\":%d,\"changedBlocks\":%d,\"blocks\":%d,\"maxBlockDelta\":%d,\"meanAbsDiff\":%.2f}",
                             size.0, size.1, name, threshold, d.changedBlocks, d.blocks, d.maxBlockDelta, d.meanAbsDiff))
            }
        }
    }

    // ---- residual noise between two renders of the identical fixture
    let again = render(Fixture())
    for size in [(160, 90), (96, 54)] {
        let a = thumbnail(base, width: size.0, height: size.1)
        let b = thumbnail(again, width: size.0, height: size.1)
        let d = blockDiff(a, b, width: size.0, height: size.1, threshold: 1)
        print(String(format: "{\"kind\":\"self-diff\",\"thumb\":\"%dx%d\",\"changedBlocksAtThreshold1\":%d,\"maxBlockDelta\":%d,\"meanAbsDiff\":%.4f}",
                     size.0, size.1, d.changedBlocks, d.maxBlockDelta, d.meanAbsDiff))
    }

    // ---- stage 1 (change-frame PNG filmstrip) vs stage 2 (one H.264 frame), same pixels
    func encoded(_ image: CGImage, _ type: String, scale: CGFloat = 1, quality: Double = 0.8) -> Int {
        let scaled: CGImage
        if scale == 1 {
            scaled = image
        } else {
            let w = Int(CGFloat(image.width) * scale), h = Int(CGFloat(image.height) * scale)
            let ctx = makeContext(w, h)
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            scaled = ctx.makeImage()!
        }
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, type as CFString, 1, nil)!
        let options: [CFString: Any] = type == "public.jpeg" ? [kCGImageDestinationLossyCompressionQuality: quality] : [:]
        CGImageDestinationAddImage(dest, scaled, options as CFDictionary)
        CGImageDestinationFinalize(dest)
        return data.length
    }
    for (label, scale) in [("full", CGFloat(1)), ("half", CGFloat(0.5)), ("third", CGFloat(1.0 / 3.0))] {
        let png = encoded(base, "public.png", scale: scale)
        let jpeg = encoded(base, "public.jpeg", scale: scale)
        print(String(format: "{\"kind\":\"still-frame-bytes\",\"scale\":\"%@\",\"png\":%d,\"jpeg80\":%d}", label, png, jpeg))
    }
}

main()
