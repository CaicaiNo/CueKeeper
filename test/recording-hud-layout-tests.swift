import AppKit
import Foundation

/// Offline assertions for the HUD's dot + text placement. The panel itself is
/// AppKit-only and needs a screen, so the placement lives in
/// `IndicatorLayout` and is checked here with the same font the panel uses.
@main
struct RecordingHudLayoutTests {
    static let font = NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
    static let running = "录制中  00:00     ⌃⌥P 暂停   ⌃⌥X 停止"
    static let paused = "已暂停  00:12     ⌃⌥P 继续   ⌃⌥X 停止"
    static let replaying = "回放中  00:03     ⌃⌥X 取消"

    static func main() {
        theGroupIsCentredWhateverThePlateWidth()
        theGapIsFixedAndTheTextNeverTouchesTheDot()
        verticalCentringFollowsTheMeasuredTextHeight()
        theClockKeepsItsWidthSoTheGroupNeverJitters()
        recordingAndReplayShareThePlacement()
        aNarrowPlateClampsInsteadOfOverlapping()
        theGroupFollowsThePlateOrigin()
        print("Recording HUD layout: 7/7 passed")
    }

    static func measure(_ text: String) -> CGSize {
        let size = (text as NSString).size(withAttributes: [.font: font])
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    static func check(_ condition: Bool, _ message: @autoclosure () -> String) {
        precondition(condition, message())
    }

    static func fps(_ rect: CGRect) -> String {
        String(format: "(%.2f, %.2f, %.2f, %.2f)", rect.minX, rect.minY, rect.width, rect.height)
    }

    /// The plate spans 320…520 pt in the field; in every case the middle of
    /// "dot + gap + text" is the middle of the plate.
    static func theGroupIsCentredWhateverThePlateWidth() {
        for width in [CGFloat(380), 320, 520, 240] {
            let hud = CGRect(x: 0, y: 0, width: width, height: 46)
            for text in [running, paused, replaying] {
                let frames = IndicatorLayout.frames(hud: hud, text: measure(text))
                let centre = (frames.dot.minX + frames.label.maxX) / 2
                check(abs(centre - hud.midX) <= 1,
                      "hud w=\(width) text=\(text): group centre \(centre) vs hud centre \(hud.midX)")
                if width >= 380 {
                    check(abs(centre - hud.midX) <= 0.001,
                          "hud w=\(width) text=\(text): expected exact centring, centre \(centre)")
                }
                check(frames.dot.minX >= hud.minX, "hud w=\(width): dot left \(frames.dot.minX) escaped \(fps(hud))")
                check(frames.label.maxX <= hud.maxX, "hud w=\(width): label \(fps(frames.label)) escaped \(fps(hud))")
            }
        }
    }

    /// Dot and text stay a fixed distance apart, at every plate width and for
    /// both labels, and neither ever covers the other.
    static func theGapIsFixedAndTheTextNeverTouchesTheDot() {
        for width in [CGFloat(380), 320, 520, 240] {
            let hud = CGRect(x: 0, y: 0, width: width, height: 46)
            for text in [running, paused, replaying] {
                let frames = IndicatorLayout.frames(hud: hud, text: measure(text))
                check(abs(frames.label.minX - frames.dot.maxX - IndicatorLayout.gap) <= 0.001,
                      "hud w=\(width) text=\(text): gap \(frames.label.minX - frames.dot.maxX)")
                check(frames.label.minX >= frames.dot.maxX, "hud w=\(width) text=\(text): text overlaps dot")
                check(frames.dot.width == IndicatorLayout.dotSize, "hud w=\(width): dot shrank to \(frames.dot.width)")
            }
        }
    }

    /// Vertical placement uses the measured text height, not a fixed offset:
    /// every text height is centred on the plate's midline.
    static func verticalCentringFollowsTheMeasuredTextHeight() {
        let hud = CGRect(x: 0, y: 720, width: 380, height: 46)
        for height in [CGFloat(14), 17, 24, 31] {
            let frames = IndicatorLayout.frames(hud: hud, text: CGSize(width: 200, height: height))
            check(abs(frames.label.midY - hud.midY) <= 0.001,
                  "text h=\(height): label midY \(frames.label.midY) vs hud midY \(hud.midY)")
            check(abs(frames.dot.midY - hud.midY) <= 0.001,
                  "text h=\(height): dot midY \(frames.dot.midY) vs hud midY \(hud.midY)")
            check(abs(frames.label.height - height) <= 0.001, "text h=\(height): label height \(frames.label.height)")
        }
    }

    /// The panel renders the clock with monospaced digits, so 00:00 → 00:01 →
    /// 59:59 must not change the width, and therefore must not move the group.
    static func theClockKeepsItsWidthSoTheGroupNeverJitters() {
        let hud = CGRect(x: 0, y: 0, width: 380, height: 46)
        let samples = [
            "录制中  00:00     ⌃⌥P 暂停   ⌃⌥X 停止",
            "录制中  00:01     ⌃⌥P 暂停   ⌃⌥X 停止",
            "录制中  09:59     ⌃⌥P 暂停   ⌃⌥X 停止",
            "录制中  59:59     ⌃⌥P 暂停   ⌃⌥X 停止",
        ]
        let widths = samples.map { measure($0).width }
        check(Set(widths).count == 1, "clock digits changed width: \(widths)")
        let frames = samples.map { IndicatorLayout.frames(hud: hud, text: measure($0)) }
        for (index, frame) in frames.enumerated().dropFirst() {
            check(frame == frames[0], "\(samples[index]) moved the group: \(fps(frame.label)) vs \(fps(frames[0].label))")
        }
    }

    /// A pause and a replay change the wording and therefore the group width,
    /// yet both stay centred: the group is recentred, not pinned to the dot.
    static func recordingAndReplayShareThePlacement() {
        let hud = CGRect(x: 0, y: 0, width: 380, height: 46)
        let recording = IndicatorLayout.frames(hud: hud, text: measure(running))
        let paused = IndicatorLayout.frames(hud: hud, text: measure(paused))
        let replay = IndicatorLayout.frames(hud: hud, text: measure(replaying))
        for (name, frames) in [("running", recording), ("paused", paused), ("replay", replay)] {
            let centre = (frames.dot.minX + frames.label.maxX) / 2
            check(abs(centre - hud.midX) <= 0.001, "\(name): centre \(centre) vs \(hud.midX)")
            check(abs(frames.dot.midY - hud.midY) <= 0.001, "\(name): dot not vertically centred")
        }
        check(recording.label.width != replay.label.width,
              "fixtures must differ in width to prove recentring, both \(recording.label.width)")
    }

    /// A plate too narrow for the wording loses text width, never the gap or
    /// the centring.
    static func aNarrowPlateClampsInsteadOfOverlapping() {
        let hud = CGRect(x: 0, y: 0, width: 40, height: 46)
        let frames = IndicatorLayout.frames(hud: hud, text: measure(running))
        check(frames.label.minX >= frames.dot.maxX, "narrow plate overlapped: \(fps(frames.dot)) / \(fps(frames.label))")
        check(frames.label.maxX <= hud.maxX, "narrow plate leaked: \(fps(frames.label)) vs \(fps(hud))")
        let centre = (frames.dot.minX + frames.label.maxX) / 2
        check(abs(centre - hud.midX) <= 1, "narrow plate off centre: \(centre) vs \(hud.midX)")
        let zero = IndicatorLayout.frames(hud: CGRect(x: 0, y: 0, width: 10, height: 46), text: measure(running))
        check(zero.label.width == 0 && zero.dot.width <= 10, "tiny plate should clamp, got \(fps(zero.label)) / \(fps(zero.dot))")
    }

    /// The panel places the dot in the plate's own space and the label in the
    /// window view, so the placement must honour a non-zero plate origin.
    static func theGroupFollowsThePlateOrigin() {
        let hud = CGRect(x: 545, y: 720, width: 380, height: 46)
        let frames = IndicatorLayout.frames(hud: hud, text: measure(running))
        let centre = (frames.dot.minX + frames.label.maxX) / 2
        check(abs(centre - hud.midX) <= 0.001, "offset plate centre \(centre) vs \(hud.midX)")
        check(abs(frames.label.midY - hud.midY) <= 0.001, "offset plate label midY \(frames.label.midY) vs \(hud.midY)")
        check(abs(frames.dot.midX - (frames.label.minX - IndicatorLayout.gap - IndicatorLayout.dotSize / 2)) <= 0.001,
              "dot not tied to the label at an offset origin")
    }
}
