import AppKit
import os

/// Dev-only (`crate-dev://debug/scroll`): scrolls the current page's largest scroll view
/// down and back up at 120 Hz and logs frame pacing, to measure scrolling smoothness
/// without a mouse or Instruments. Results go to the log and to
/// `~/Library/Caches/Crate Dev/scroll-benchmark.txt`.
@MainActor
enum ScrollBenchmark {
    private static let log = Logger(subsystem: AppPaths.bundleID, category: "benchmark")

    static func run(seconds: Double = 4, pointsPerFrame: CGFloat = 28) {
        guard AppPaths.isDev, let window = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible),
              let scrollView = largestScrollView(in: window.contentView) else { return }
        let clip = scrollView.contentView
        let maxY = max(0, (scrollView.documentView?.frame.height ?? 0) - clip.bounds.height)
        var y = clip.bounds.origin.y
        var direction: CGFloat = 1
        var last = CACurrentMediaTime()
        let start = last
        var frames: [Double] = []
        Timer.scheduledTimer(withTimeInterval: 1.0 / 120.0, repeats: true) { timer in
            MainActor.assumeIsolated {
                let now = CACurrentMediaTime()
                frames.append((now - last) * 1000)
                last = now
                y += pointsPerFrame * direction
                if y >= maxY || now - start > seconds / 2 && direction > 0 { direction = -1 }
                y = min(max(0, y), maxY)
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
                scrollView.reflectScrolledClipView(clip)
                if now - start > seconds {
                    timer.invalidate()
                    report(frames)
                }
            }
        }
    }

    private static func report(_ frames: [Double]) {
        let sorted = frames.dropFirst().sorted()
        guard !sorted.isEmpty else { return }
        let mean = sorted.reduce(0, +) / Double(sorted.count)
        let p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
        let worst = sorted.last ?? 0
        let dropped = sorted.filter { $0 > 25 }.count
        let line = String(format: "frames %d, mean %.1f ms, p95 %.1f ms, worst %.1f ms, >25 ms: %d", sorted.count, mean, p95, worst, dropped)
        log.info("scroll benchmark: \(line, privacy: .public)")
        let file = AppPaths.caches.appendingPathComponent("scroll-benchmark.txt")
        try? FileManager.default.createDirectory(at: AppPaths.caches, withIntermediateDirectories: true)
        try? (line + "\n").write(to: file, atomically: true, encoding: .utf8)
    }

    private static func largestScrollView(in view: NSView?) -> NSScrollView? {
        guard let view else { return nil }
        var best: NSScrollView?
        func visit(_ v: NSView) {
            if let scroll = v as? NSScrollView, !v.isHidden, v.alphaValue > 0,
               (scroll.documentView?.frame.height ?? 0) > scroll.contentView.bounds.height {
                if best == nil || v.frame.width * v.frame.height > best!.frame.width * best!.frame.height { best = scroll }
            }
            v.subviews.forEach(visit)
        }
        visit(view)
        return best
    }
}
