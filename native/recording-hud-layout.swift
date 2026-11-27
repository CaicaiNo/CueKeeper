import Foundation

/// Places the recording HUD's status dot and its text as one group inside the
/// plate. Kept free of AppKit so the placement can be asserted offline: the
/// panel only measures the text and hands the numbers in.
///
/// The rule is: the dot and the text are one piece. Their combined width is
/// centred on the plate, the gap between them is fixed, and both are centred
/// vertically on the plate's midline.
enum IndicatorLayout {
    struct Frames: Equatable {
        let dot: CGRect
        let label: CGRect
    }

    /// Diameter of the status dot.
    static let dotSize: CGFloat = 10
    /// Space between the dot and the text.
    static let gap: CGFloat = 10
    /// Smallest distance the group keeps from the plate's left/right edge.
    static let padding: CGFloat = 10

    /// Frames are returned in the same coordinate space as `hud`.
    ///
    /// A text wider than the plate can hold is clamped to the remaining space
    /// instead of overlapping the dot or leaving the plate; the group stays
    /// centred either way. `text` is the measured size of a single line.
    static func frames(hud: CGRect,
                       text: CGSize,
                       dotSize: CGFloat = IndicatorLayout.dotSize,
                       gap: CGFloat = IndicatorLayout.gap,
                       padding: CGFloat = IndicatorLayout.padding) -> Frames {
        let available = max(0, hud.width - 2 * padding)
        let dotWidth = max(0, min(dotSize, available))
        let textWidth = max(0, min(text.width, max(0, available - dotWidth - gap)))
        let textHeight = max(0, text.height)
        let groupWidth = dotWidth + gap + textWidth
        let groupMinX = hud.minX + (hud.width - groupWidth) / 2
        let midY = hud.midY

        return Frames(
            dot: CGRect(x: groupMinX, y: midY - dotWidth / 2, width: dotWidth, height: dotWidth),
            label: CGRect(x: groupMinX + dotWidth + gap, y: midY - textHeight / 2,
                          width: textWidth, height: textHeight)
        )
    }
}
