// Draws the DMG window background (660×400 pt, @2x) in Crate's canvas colours.
// Usage: swift scripts/make-dmg-background.swift <output.png>

import AppKit

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "background.png"
let width = 660, height = 400, scale = 2
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

NSColor(srgbRed: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF6 / 255, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

// Arrow between the two icons (icons sit at y = 190 from the top).
let arrow = NSBezierPath()
let y = CGFloat(height - 190)
arrow.move(to: NSPoint(x: 262, y: y))
arrow.line(to: NSPoint(x: 392, y: y))
arrow.move(to: NSPoint(x: 380, y: y + 10))
arrow.line(to: NSPoint(x: 394, y: y))
arrow.line(to: NSPoint(x: 380, y: y - 10))
arrow.lineWidth = 3
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
NSColor(srgbRed: 0x6B / 255, green: 0x6B / 255, blue: 0x73 / 255, alpha: 0.55).setStroke()
arrow.stroke()

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center
let title: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
    .foregroundColor: NSColor(srgbRed: 0x18 / 255, green: 0x18 / 255, blue: 0x1B / 255, alpha: 1),
    .paragraphStyle: paragraph,
]
let caption: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 12, weight: .regular),
    .foregroundColor: NSColor(srgbRed: 0x6B / 255, green: 0x6B / 255, blue: 0x73 / 255, alpha: 1),
    .paragraphStyle: paragraph,
]
NSAttributedString(string: "Drag Crate to Applications", attributes: title).draw(in: NSRect(x: 0, y: 72, width: width, height: 22))
NSAttributedString(string: "A music player for Navidrome", attributes: caption).draw(in: NSRect(x: 0, y: 52, width: width, height: 18))

NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
print("Wrote \(output)")
