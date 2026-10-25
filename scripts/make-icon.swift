// Draws the Crate app icon and writes an .icns file.
// Usage: swift scripts/make-icon.swift <output.icns>
//
// The mark matches CrateMark in Sources/Crate/Design/Components.swift: a record with the
// lavender→sky brand gradient rising out of a near-black crate, on a white macOS tile.

import AppKit

let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Resources/AppIcon.icns"

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

func drawIcon(size: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    let scale = CGFloat(size) / 1024
    cg.scaleBy(x: scale, y: scale)
    // Work in a top-left coordinate space like the SwiftUI mark.
    cg.translateBy(x: 0, y: 1024)
    cg.scaleBy(x: 1, y: -1)

    // Tile (macOS icon grid: 824 pt body, continuous corners) with a soft shadow.
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let tile = CGPath(roundedRect: body, cornerWidth: 186, cornerHeight: 186, transform: nil)
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0x000000, 0.2))
    cg.addPath(tile)
    cg.setFillColor(color(0xFFFFFF))
    cg.fillPath()
    cg.restoreGState()
    cg.saveGState()
    cg.addPath(tile)
    cg.clip()
    let bg = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0xFFFFFF), color(0xF1F1F4)] as CFArray, locations: [0, 1])!
    cg.drawLinearGradient(bg, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    cg.restoreGState()
    cg.addPath(tile)
    cg.setStrokeColor(color(0x000000, 0.06))
    cg.setLineWidth(2)
    cg.strokePath()

    // Mark, sized like CrateMark(size: s).
    let s: CGFloat = 620
    let cx: CGFloat = 512
    let cy: CGFloat = 512
    let brand = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [color(0xADA8FF), color(0x42B0FF)] as CFArray, locations: [0, 1])!

    func record(center: CGPoint, diameter d: CGFloat, alpha: CGFloat) {
        let rect = CGRect(x: center.x - d / 2, y: center.y - d / 2, width: d, height: d)
        cg.saveGState()
        cg.setAlpha(alpha)
        cg.addEllipse(in: rect)
        cg.clip()
        cg.drawLinearGradient(brand, start: CGPoint(x: rect.minX, y: rect.minY), end: CGPoint(x: rect.maxX, y: rect.maxY), options: [])
        cg.restoreGState()
        cg.setStrokeColor(color(0xFFFFFF, 0.36 * alpha))
        cg.setLineWidth(s * 0.02)
        cg.strokeEllipse(in: rect.insetBy(dx: d * 0.17, dy: d * 0.17))
        let hole = d * 0.15
        cg.setFillColor(color(0xFCFCFD))
        cg.fillEllipse(in: CGRect(x: center.x - hole / 2, y: center.y - hole / 2, width: hole, height: hole))
    }

    // Two records standing in the crate, the back one smaller and lighter.
    record(center: CGPoint(x: cx - s * 0.17, y: cy - s * 0.12), diameter: s * 0.5, alpha: 0.45)
    record(center: CGPoint(x: cx + s * 0.06, y: cy - s * 0.08), diameter: s * 0.64, alpha: 1)

    // Crate: two side posts and three planks with gaps the records show through.
    let crate = CGRect(x: cx - s * 0.42, y: cy + s * 0.02, width: s * 0.84, height: s * 0.42)
    let gap = s * 0.03
    let post = s * 0.08
    let plankH = (crate.height - gap * 2) / 3
    let shape = CGMutablePath()
    shape.addRoundedRect(in: CGRect(x: crate.minX, y: crate.minY, width: post, height: crate.height), cornerWidth: s * 0.035, cornerHeight: s * 0.035)
    shape.addRoundedRect(in: CGRect(x: crate.maxX - post, y: crate.minY, width: post, height: crate.height), cornerWidth: s * 0.035, cornerHeight: s * 0.035)
    for i in 0..<3 {
        let y = crate.minY + CGFloat(i) * (plankH + gap)
        shape.addRoundedRect(in: CGRect(x: crate.minX + post * 0.5, y: y, width: crate.width - post, height: plankH), cornerWidth: s * 0.03, cornerHeight: s * 0.03)
    }
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -8), blur: 20, color: color(0x000000, 0.16))
    cg.addPath(shape)
    cg.setFillColor(color(0x16161A))
    cg.fillPath()
    cg.restoreGState()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let fm = FileManager.default
let iconset = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("Crate-\(UUID().uuidString).iconset")
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
let entries: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for (name, px) in entries {
    let data = drawIcon(size: px).representation(using: .png, properties: [:])!
    try data.write(to: iconset.appendingPathComponent("\(name).png"))
}
// Also keep a PNG for the README.
let preview = URL(fileURLWithPath: output).deletingLastPathComponent().appendingPathComponent("AppIcon.png")
try drawIcon(size: 512).representation(using: .png, properties: [:])!.write(to: preview)

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", output]
try task.run()
task.waitUntilExit()
try? fm.removeItem(at: iconset)
print(task.terminationStatus == 0 ? "Wrote \(output)" : "iconutil failed")
