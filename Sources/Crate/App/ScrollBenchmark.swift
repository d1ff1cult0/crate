import AppKit
import os

/// Dev-only (`crate-dev://debug/scroll`): scrolls the current page's largest scroll view
/// down and back up and logs frame pacing, to measure scrolling smoothness without a
/// mouse or Instruments. Results go to the log and to
/// `~/Library/Caches/Crate Dev/scroll-benchmark.txt`.
///
/// By default it scrolls the way a person does: trackpad scroll events go through the
/// scroll view while the pointer rests over the list, so rows pass under it and hover
/// states change. `?input=clip` moves the clip view directly instead (no events, no
/// hover), `?input=hover` moves the pointer up and down over the rows without scrolling
/// (the cost of hover itself), `?pointer=0` leaves the pointer out, `?seconds=` and
/// `?speed=` (points per second) tune the run. Frames are counted on the display's refresh, so a frame the main
/// thread misses shows up as a long interval.
@MainActor
enum ScrollBenchmark {
    private static let log = Logger(subsystem: AppPaths.bundleID, category: "benchmark")
    private static var current: Run?

    static func run(query: [String: String] = [:]) {
        guard AppPaths.isDev, current == nil, let window = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible),
              let scrollView = pageScrollView(in: window) else { return }
        let run = Run(
            window: window,
            scrollView: scrollView,
            input: Input(rawValue: query["input"] ?? "") ?? .wheel,
            pointer: query["pointer"] != "0" && query["input"] != "clip",
            seconds: query["seconds"].flatMap(Double.init) ?? 4,
            speed: query["speed"].flatMap(Double.init) ?? 1500
        )
        current = run
        run.start { current = nil }
    }

    enum Input: String {
        case wheel, clip, hover
    }

    @MainActor
    private final class Run: NSObject {
        let window: NSWindow
        let scrollView: NSScrollView
        let input: Input
        let pointer: Bool
        let seconds: Double
        let speed: Double
        private var link: CADisplayLink?
        private var start: CFTimeInterval = 0
        private var last: CFTimeInterval = 0
        private var direction: CGFloat = 1
        private var pointerOffset: CGFloat = 0
        private var frames: [Double] = []
        /// When each long frame ended, in seconds since the start.
        private var hitches: [(at: Double, ms: Double)] = []
        private var period: Double = 1.0 / 60
        private var finished: (() -> Void)?

        init(window: NSWindow, scrollView: NSScrollView, input: Input, pointer: Bool, seconds: Double, speed: Double) {
            self.window = window
            self.scrollView = scrollView
            self.input = input
            self.pointer = pointer
            self.seconds = seconds
            self.speed = speed
        }

        /// A point over the list's rows (left of the rating and heart columns).
        private var pointerLocation: NSPoint {
            let frame = scrollView.convert(scrollView.bounds, to: nil)
            return NSPoint(x: frame.minX + frame.width * 0.35, y: frame.midY + pointerOffset)
        }

        func start(finished: @escaping () -> Void) {
            self.finished = finished
            let link = scrollView.displayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
            if input == .wheel { sendScroll(delta: 0, phase: .began) }
        }

        @objc private func tick(_ link: CADisplayLink) {
            let now = link.timestamp
            if start == 0 {
                start = now
                last = now
                period = max(link.duration, 1.0 / 240)
                return
            }
            let elapsed = now - last
            frames.append(elapsed * 1000)
            if elapsed > period * 1.5 { hitches.append((now - start, elapsed * 1000)) }
            last = now
            let clip = scrollView.contentView
            let maxY = max(0, (scrollView.documentView?.frame.height ?? 0) - clip.bounds.height)
            if input != .hover, clip.bounds.origin.y >= maxY - 1 || now - start > seconds / 2 && direction > 0 { direction = -1 }
            // Distance follows the time since the last frame, like a real scroll: a late
            // frame jumps further instead of slowing the scroll down.
            let delta = CGFloat(speed * elapsed) * direction
            switch input {
            case .wheel:
                if pointer { movePointer() }
                sendScroll(delta: delta, phase: .changed)
            case .clip:
                let y = min(max(0, clip.bounds.origin.y + delta), maxY)
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
                scrollView.reflectScrolledClipView(clip)
            case .hover:
                let half = scrollView.bounds.height * 0.4
                pointerOffset += delta
                if abs(pointerOffset) > half { pointerOffset = half * (pointerOffset > 0 ? 1 : -1) }
                if abs(pointerOffset) >= half { direction = -direction }
                movePointer()
            }
            if now - start > seconds {
                if input == .wheel { sendScroll(delta: 0, phase: .ended) }
                link.invalidate()
                self.link = nil
                report()
                finished?()
            }
        }

        /// The pointer resting over the list: hover follows whatever row is under it.
        private func movePointer() {
            guard let event = NSEvent.mouseEvent(
                with: .mouseMoved, location: pointerLocation, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0
            ) else { return }
            window.sendEvent(event)
        }

        /// A trackpad scroll event (pixel deltas with gesture phases) at the pointer.
        private func sendScroll(delta: CGFloat, phase: CGScrollPhase) {
            guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 0, wheel2: 0, wheel3: 0) else { return }
            cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
            cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: Int64((-delta).rounded()))
            cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(-delta))
            cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(-delta))
            let screenPoint = window.convertPoint(toScreen: pointerLocation)
            let screenHeight = NSScreen.screens.first?.frame.height ?? 0
            cg.location = CGPoint(x: screenPoint.x, y: screenHeight - screenPoint.y)
            cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
            cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
            guard let event = NSEvent(cgEvent: cg) else { return }
            // Real scroll events reach `ScrollActivity` through its event monitor, which
            // events handed straight to the window skip.
            ScrollActivity.shared.noteScroll()
            window.sendEvent(event)
        }

        private func report() {
            let sorted = frames.sorted()
            guard !sorted.isEmpty else { return }
            let budget = period * 1000
            let mean = sorted.reduce(0, +) / Double(sorted.count)
            let p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
            let worst = sorted.last ?? 0
            let missed = frames.reduce(0) { $0 + max(0, Int(($1 / budget).rounded()) - 1) }
            let label = input == .wheel && pointer ? "wheel+pointer" : input.rawValue
            var line = String(format: "%@ @%.0f Hz: frames %d, mean %.1f ms, p95 %.1f ms, worst %.1f ms, missed %d of %d (%.1f%%)",
                              label, 1 / period, sorted.count, mean, p95, worst, missed, sorted.count + missed,
                              Double(missed) / Double(sorted.count + missed) * 100)
            let worstFrames = hitches.sorted { $0.ms > $1.ms }.prefix(6).sorted { $0.at < $1.at }
            if !worstFrames.isEmpty {
                line += " | long frames at " + worstFrames.map { String(format: "%.2fs (%.0f ms)", $0.at, $0.ms) }.joined(separator: ", ")
            }
            ScrollBenchmark.log.info("scroll benchmark: \(line, privacy: .public)")
            let file = AppPaths.caches.appendingPathComponent("scroll-benchmark.txt")
            try? FileManager.default.createDirectory(at: AppPaths.caches, withIntermediateDirectories: true)
            let previous = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
            try? (previous + line + "\n").write(to: file, atomically: true, encoding: .utf8)
        }
    }

    /// The scrollable view under a point in the middle of the page. Hidden sections stay
    /// mounted under detail pages (with SwiftUI opacity 0, which AppKit doesn't see), so
    /// "the largest scroll view" can be one nobody is looking at.
    private static func pageScrollView(in window: NSWindow) -> NSScrollView? {
        guard let content = window.contentView else { return nil }
        let point = NSPoint(x: content.bounds.width * 0.5, y: content.bounds.height * 0.45)
        var view = content.hitTest(point)
        while let v = view {
            if let scroll = v as? NSScrollView, (scroll.documentView?.frame.height ?? 0) > scroll.contentView.bounds.height {
                return scroll
            }
            view = v.superview
        }
        return nil
    }
}
