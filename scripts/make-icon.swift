#!/usr/bin/env swift
// Draw the macOS app icon on Apple's 1024pt grid: an 824pt rounded square
// centered with 100pt transparent margins and a 185.4pt corner radius.
// Everything outside the rounded square is transparent, so Finder and the Dock
// do not show a white plate behind the icon.
import AppKit
import CoreGraphics
import Foundation

let side = 1024
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(
    data: nil,
    width: side,
    height: side,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    exit(1)
}
context.clear(CGRect(x: 0, y: 0, width: side, height: side))

let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let bodyPath = CGPath(
    roundedRect: body,
    cornerWidth: 185.4,
    cornerHeight: 185.4,
    transform: nil
)

// A soft shadow lives in the transparent margin, not on a white plate.
context.saveGState()
context.setShadow(
    offset: CGSize(width: 0, height: -14),
    blur: 36,
    color: NSColor.black.withAlphaComponent(0.38).cgColor
)
context.addPath(bodyPath)
context.setFillColor(NSColor(calibratedRed: 0.04, green: 0.07, blue: 0.12, alpha: 1).cgColor)
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(bodyPath)
context.clip()

let background = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        NSColor(calibratedRed: 0.07, green: 0.12, blue: 0.21, alpha: 1).cgColor,
        NSColor(calibratedRed: 0.02, green: 0.035, blue: 0.07, alpha: 1).cgColor,
    ] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    background,
    start: CGPoint(x: 512, y: 924),
    end: CGPoint(x: 512, y: 100),
    options: []
)

let glow = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        NSColor(calibratedRed: 0.13, green: 0.83, blue: 0.93, alpha: 0.24).cgColor,
        NSColor(calibratedRed: 0.13, green: 0.83, blue: 0.93, alpha: 0).cgColor,
    ] as CFArray,
    locations: [0, 1]
)!
context.drawRadialGradient(
    glow,
    startCenter: CGPoint(x: 512, y: 560),
    startRadius: 0,
    endCenter: CGPoint(x: 512, y: 560),
    endRadius: 430,
    options: []
)

let gloss = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        NSColor.white.withAlphaComponent(0.10).cgColor,
        NSColor.white.withAlphaComponent(0).cgColor,
    ] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    gloss,
    start: CGPoint(x: 512, y: 924),
    end: CGPoint(x: 512, y: 620),
    options: []
)
context.restoreGState()

context.addPath(bodyPath)
context.setStrokeColor(NSColor.white.withAlphaComponent(0.13).cgColor)
context.setLineWidth(3)
context.strokePath()

let circle = CGRect(x: 262, y: 262, width: 500, height: 500)
let circlePath = CGPath(ellipseIn: circle, transform: nil)
context.saveGState()
context.addPath(circlePath)
context.clip()
let mark = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        NSColor(calibratedRed: 0.30, green: 0.91, blue: 0.98, alpha: 1).cgColor,
        NSColor(calibratedRed: 0.05, green: 0.45, blue: 0.56, alpha: 1).cgColor,
    ] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    mark,
    start: CGPoint(x: 512, y: 762),
    end: CGPoint(x: 512, y: 262),
    options: []
)
context.restoreGState()

context.addPath(circlePath)
context.setStrokeColor(NSColor.white.withAlphaComponent(0.35).cgColor)
context.setLineWidth(8)
context.strokePath()

let triangle = CGMutablePath()
triangle.move(to: CGPoint(x: 452, y: 382))
triangle.addLine(to: CGPoint(x: 680, y: 512))
triangle.addLine(to: CGPoint(x: 452, y: 642))
triangle.closeSubpath()
context.addPath(triangle)
context.setFillColor(NSColor.white.cgColor)
context.setStrokeColor(NSColor.white.cgColor)
context.setLineWidth(26)
context.setLineJoin(.round)
context.drawPath(using: .fillStroke)

let dot = CGRect(x: 696, y: 686, width: 52, height: 52)
context.setFillColor(NSColor.white.cgColor)
context.fillEllipse(in: dot)
context.setStrokeColor(NSColor(calibratedRed: 0.30, green: 0.91, blue: 0.98, alpha: 1).cgColor)
context.setLineWidth(8)
context.strokeEllipse(in: dot)

guard let image = context.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: image)
guard let data = rep.representation(using: .png, properties: [:]) else { exit(1) }
let path = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("desktop/icons/icon.png")
try data.write(to: path)
print(path.path)
