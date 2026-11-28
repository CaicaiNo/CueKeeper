// Draw CueKeeper's macOS app icon with Apple's 1024 pt app-icon grid:
// an 824 pt rounded square centred on a transparent 1024 pt canvas, with the
// 100 pt transparent margin used by Apple's macOS icon template.
//
//   swift desktop/icons/make-icon.swift desktop/icons/icon.png
import AppKit
import Foundation

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let canvas = 1024
let margin = 100
let side = canvas - margin * 2
let radius = 185.4

guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: canvas,
  pixelsHigh: canvas,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  FileHandle.standardError.write("cannot create the icon bitmap\n".data(using: .utf8)!)
  exit(1)
}
bitmap.size = NSSize(width: canvas, height: canvas)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: canvas, height: canvas)).fill()

// Apple's macOS icon template: 824 pt square, 100 pt transparent margin.
let outerRect = NSRect(x: margin, y: margin, width: side, height: side)
let outer = NSBezierPath(roundedRect: outerRect, xRadius: radius, yRadius: radius)
let background = NSGradient(
  colors: [
    NSColor(srgbRed: 0.286, green: 0.902, blue: 0.808, alpha: 1),
    NSColor(srgbRed: 0.133, green: 0.667, blue: 0.780, alpha: 1),
    NSColor(srgbRed: 0.055, green: 0.451, blue: 0.561, alpha: 1),
  ],
  atLocations: [0, 0.52, 1],
  colorSpace: .sRGB
)!
background.draw(in: outer, angle: -55)

// A soft top light inside the shape; no outline on the transparent edge.
NSGraphicsContext.saveGraphicsState()
outer.addClip()
let light = NSGradient(colors: [
  NSColor.white.withAlphaComponent(0.16),
  NSColor.white.withAlphaComponent(0.0),
])!
light.draw(in: NSRect(x: margin, y: margin + side / 2, width: side, height: side / 2), angle: 90)
NSGraphicsContext.restoreGraphicsState()

// A single, readable cue mark: a dark play triangle with an Apple-style
// recording dot. No nested square, so the icon stays legible at 16 pt.
let play = NSBezierPath()
play.move(to: NSPoint(x: 424, y: 356))
play.line(to: NSPoint(x: 720, y: 512))
play.line(to: NSPoint(x: 424, y: 668))
play.close()

NSGraphicsContext.saveGraphicsState()
let playShadow = NSShadow()
playShadow.shadowColor = NSColor.black.withAlphaComponent(0.20)
playShadow.shadowBlurRadius = 22
playShadow.shadowOffset = NSSize(width: 0, height: -10)
playShadow.set()
NSColor(srgbRed: 0.027, green: 0.067, blue: 0.118, alpha: 1).setFill()
play.fill()
NSGraphicsContext.restoreGraphicsState()

let dot = NSBezierPath(ovalIn: NSRect(x: 740, y: 740, width: 62, height: 62))
NSColor(srgbRed: 0.980, green: 0.992, blue: 0.996, alpha: 0.96).setFill()
dot.fill()
NSColor(srgbRed: 0.031, green: 0.102, blue: 0.157, alpha: 0.55).setStroke()
dot.lineWidth = 7
dot.stroke()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  FileHandle.standardError.write("cannot encode the icon\n".data(using: .utf8)!)
  exit(1)
}
try png.write(to: URL(fileURLWithPath: output))
