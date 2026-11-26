import Foundation

/// The recording HUD's wording, kept apart from AppKit so it can be asserted
/// offline. Nothing here may describe a recording that has not begun: the panel
/// is only created at the helper's ready moment, so its first frame already
/// says "录制中" and the tap warm-up never has a label of its own.
enum IndicatorLabel {
    enum Mode {
        case recording
        case replay
    }

    /// `starting` is accepted because the plate still looks freshly started for
    /// its first seconds, but it never changes the words: there is no
    /// "ready"/"preparing" label to show before capture begins.
    static func text(mode: Mode, elapsed: Int, paused: Bool, starting: Bool) -> String {
        let seconds = max(0, elapsed)
        let time = String(format: "%02d:%02d", seconds / 60, seconds % 60)
        switch mode {
        case .replay:
            return "回放中  \(time)     ⌃⌥X 取消"
        case .recording:
            let state = paused ? "已暂停" : "录制中"
            let action = paused ? "继续" : "暂停"
            return "\(state)  \(time)     ⌃⌥P \(action)   ⌃⌥X 停止"
        }
    }
}
