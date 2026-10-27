import AppKit
import SwiftUI

@main
struct CrateApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var app: AppModel

    init() {
        CrateFonts.register()
        let model = AppModel()
        _app = State(initialValue: model)
        AppDelegate.model = model
    }

    var body: some Scene {
        Window("Crate", id: "main") {
            RootView()
                .environment(app)
                .background(WindowConfigurator())
                .modifier(Dialogs())
                .environment(app)
                .tint(Tok.accent)
                .task { app.launch() }
                .onOpenURL { app.handle($0) }
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1340, height: 860)
        .commands { CrateCommands(app: app) }
    }
}

struct CrateCommands: Commands {
    let app: AppModel

    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { app.nav.go(.settings) }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(replacing: .newItem) {
            Button("New playlist…") { app.playlistPrompt = PlaylistPrompt(tracks: []) }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(after: .sidebar) {
            Button("Go to…") {
                app.paletteQuery = ""
                app.showPalette = true
            }
            .keyboardShortcut("k", modifiers: .command)
            Button("Search everywhere") { app.nav.go(.search("")) }
                .keyboardShortcut("f", modifiers: [.command, .shift])
            Button(app.showQueue ? "Hide queue" : "Show queue") { app.showQueue.toggle() }
                .keyboardShortcut("u", modifiers: .command)
            Button(app.showLyrics ? "Hide lyrics" : "Show lyrics") { app.showLyrics.toggle() }
                .keyboardShortcut("l", modifiers: [.command, .option])
            Divider()
            Button("Back") { app.nav.back() }
                .keyboardShortcut("[", modifiers: .command)
            Button("Forward") { app.nav.forward() }
                .keyboardShortcut("]", modifiers: .command)
            Divider()
            Button("Home") { app.nav.go(.home) }.keyboardShortcut("1", modifiers: [.command, .option])
            Button("Discover") { app.nav.go(.discover) }.keyboardShortcut("2", modifiers: [.command, .option])
            Button("Playlists") { app.nav.go(.playlists) }.keyboardShortcut("3", modifiers: [.command, .option])
            Button("Favourites") { app.nav.go(.favourites) }.keyboardShortcut("4", modifiers: [.command, .option])
        }
        CommandMenu("Controls") {
            Button(app.player.isPlaying ? "Pause" : "Play") { app.player.togglePlayPause() }
            Button("Next") { app.player.next() }
            Button("Previous") { app.player.previous() }
            Divider()
            Button(app.player.shuffle ? "Turn shuffle off" : "Shuffle") { app.player.toggleShuffle() }
                .keyboardShortcut("s", modifiers: .command)
            Button("Repeat: \(app.player.repeatMode.rawValue.capitalized)") { app.player.cycleRepeat() }
                .keyboardShortcut("r", modifiers: .command)
            Toggle("Autoplay", isOn: Binding(get: { app.settings.autoplay }, set: { app.settings.autoplay = $0 }))
            Divider()
            Button("Favourite current song") {
                if let track = app.player.current?.track { app.library.toggleStar(track) }
            }
            .keyboardShortcut("l", modifiers: .command)
            Menu("Rate current song") {
                ForEach((0...5).reversed(), id: \.self) { value in
                    Button(value == 0 ? "No rating" : String(repeating: "★", count: value)) {
                        if let track = app.player.current?.track { app.library.setRating(track, value) }
                    }
                    .keyboardShortcut(KeyEquivalent(Character(String(value))), modifiers: .command)
                }
            }
            Button("Start radio from current song") {
                if let track = app.player.current?.track {
                    app.player.startRadio(.track(track), name: track.title, leading: [track])
                }
            }
            Divider()
            Button("Go to current album") { app.openAlbum(app.player.current?.track.albumId) }
                .keyboardShortcut("j", modifiers: .command)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static var model: AppModel?
    private var keyMonitor: Any?
    private var clickMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        ScrollActivity.shared.start()
        // Space and ⌘-arrows control playback unless a text field is being edited. These
        // aren't menu shortcuts because those would steal the keys from text fields.
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let handled = MainActor.assumeIsolated { AppDelegate.handleKey(event) }
            return handled ? nil : event
        }
        // A text field keeps the keyboard until something else takes it, and the rows and
        // buttons here never do, so after typing in a filter Space kept typing spaces into
        // it. A click anywhere outside a text field ends the editing, like in a browser.
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
            MainActor.assumeIsolated { AppDelegate.endTextEditing(unlessClickIsIn: event) }
            return event
        }
    }

    private static var isEditingText: Bool {
        NSApp.keyWindow?.firstResponder is NSText
    }

    private static func endTextEditing(unlessClickIsIn event: NSEvent) {
        guard let window = event.window, window.firstResponder is NSText, model?.showPalette != true,
              let content = window.contentView else { return }
        var view = content.hitTest(event.locationInWindow)
        while let current = view {
            if current is NSTextField || current is NSText { return }
            view = current.superview
        }
        window.makeFirstResponder(nil)
    }

    /// Returns true when the key press was handled here.
    private static func handleKey(_ event: NSEvent) -> Bool {
        // Sheets (the playlist name prompt) keep their own keys, Esc included.
        guard let model = AppDelegate.model, model.phase == .ready, NSApp.keyWindow?.sheetParent == nil else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.numericPad, .function, .capsLock])
        // Ctrl-K opens the palette like ⌘K (the menu item can only carry one shortcut).
        if flags == [.control], event.charactersIgnoringModifiers?.lowercased() == "k" {
            model.paletteQuery = ""
            model.showPalette = true
            return true
        }
        if isEditingText {
            // Esc leaves a text field (the palette handles its own).
            guard event.keyCode == 53, flags.isEmpty, !model.showPalette else { return false }
            NSApp.keyWindow?.makeFirstResponder(nil)
            return true
        }
        switch (event.keyCode, flags) {
        case (49, []):
            if model.showPalette { return false }
            model.player.togglePlayPause()
        case (124, [.command]):
            model.player.next()
        case (123, [.command]):
            model.player.previous()
        case (126, [.command]):
            model.player.volume = min(1, model.player.volume + 0.08)
        case (125, [.command]):
            model.player.volume = max(0, model.player.volume - 0.08)
        case (53, []):
            guard model.showPalette else { return false }
            model.showPalette = false
        default:
            return false
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppDelegate.model?.player.persistNow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            for window in sender.windows where window.canBecomeMain {
                window.makeKeyAndOrderFront(nil)
                return false
            }
        }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        do {
            guard let model = AppDelegate.model else { return nil }
            let menu = NSMenu()
            if let track = model.player.current?.track {
                let title = NSMenuItem(title: "\(track.title) — \(track.artist)", action: nil, keyEquivalent: "")
                title.isEnabled = false
                menu.addItem(title)
                menu.addItem(.separator())
            }
            menu.addItem(DockItem(model.player.isPlaying ? "Pause" : "Play") { model.player.togglePlayPause() })
            menu.addItem(DockItem("Next") { model.player.next() })
            menu.addItem(DockItem("Previous") { model.player.previous() })
            if let track = model.player.current?.track {
                menu.addItem(.separator())
                menu.addItem(DockItem(model.library.isStarred(track) ? "Remove from favourites" : "Add to favourites") { model.library.toggleStar(track) })
            }
            return menu
        }
    }
}

private final class DockItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: "")
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError() }

    @objc private func run() {
        MainActor.assumeIsolated { handler() }
    }
}

/// Window chrome: transparent title bar over the canvas, draggable from the background.
struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            guard let window = view.window else { return }
            window.titlebarAppearsTransparent = true
            window.isMovableByWindowBackground = false
            window.backgroundColor = NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0x0E0E11) : NSColor(hex: 0xF5F5F6)
            }
            window.setFrameAutosaveName("CrateMainWindow")
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Moves the window from custom title areas (the title bar is hidden). Double-click zooms,
/// like a real title bar. With `onClick`, a click that doesn't move runs it instead (the
/// logo goes home) and dragging still moves the window.
struct WindowDragArea: NSViewRepresentable {
    var onClick: (() -> Void)?

    final class DragView: NSView {
        var onClick: (() -> Void)?

        override var mouseDownCanMoveWindow: Bool { true }

        /// Like a title bar: works on the first click, even while the window is inactive.
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if let onClick {
                // Wait for the mouse to either move (a drag) or come up (a click).
                let start = event.locationInWindow
                while let next = window.nextEvent(matching: [.leftMouseUp, .leftMouseDragged]) {
                    if next.type == .leftMouseUp {
                        onClick()
                        return
                    }
                    if hypot(next.locationInWindow.x - start.x, next.locationInWindow.y - start.y) > 3 {
                        window.performDrag(with: event)
                        return
                    }
                }
            } else if event.clickCount == 2 {
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" { window.performMiniaturize(nil) } else if action != "None" { window.performZoom(nil) }
            } else {
                window.performDrag(with: event)
            }
        }
    }

    func makeNSView(context: Context) -> DragView {
        let view = DragView()
        view.onClick = onClick
        return view
    }

    func updateNSView(_ nsView: DragView, context: Context) {
        nsView.onClick = onClick
    }
}

/// A column edge you can drag to resize; double-click restores the default width.
struct ResizeHandle: View {
    @Binding var width: Double
    let range: ClosedRange<Double>
    let defaultWidth: Double
    /// Which edge of the resized column the handle sits on.
    let edge: HorizontalEdge
    @State private var startWidth: Double?
    @State private var hovering = false
    @State private var cursorPushed = false

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 10)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .overlay {
                Capsule()
                    .fill(Tok.accent)
                    .frame(width: 2)
                    .padding(.vertical, 12)
                    .opacity(hovering || startWidth != nil ? 1 : 0)
                    .animation(Motion.fast, value: hovering || startWidth != nil)
            }
            .onHover { inside in
                hovering = inside
                updateCursor()
            }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { drag in
                        if startWidth == nil { startWidth = width }
                        let delta = edge == .trailing ? drag.translation.width : -drag.translation.width
                        width = min(max((startWidth ?? width) + delta, range.lowerBound), range.upperBound).rounded()
                        updateCursor()
                    }
                    .onEnded { _ in
                        startWidth = nil
                        updateCursor()
                    }
            )
            .onTapGesture(count: 2) {
                withAnimation(Motion.slow) { width = defaultWidth }
            }
            .help("Drag to resize, double-click to reset")
    }

    private func updateCursor() {
        let wants = hovering || startWidth != nil
        if wants, !cursorPushed {
            NSCursor.resizeLeftRight.push()
            cursorPushed = true
        } else if !wants, cursorPushed {
            NSCursor.pop()
            cursorPushed = false
        }
    }
}

/// App-wide dialogs: playlist name prompt and destructive confirmations.
struct Dialogs: ViewModifier {
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        @Bindable var app = app
        content
            .sheet(item: $app.playlistPrompt) { prompt in
                PlaylistNameSheet(prompt: prompt)
                    .environment(app)
            }
            .alert("Delete “\(app.confirmDelete?.displayName ?? "")”?", isPresented: Binding(
                get: { app.confirmDelete != nil }, set: { if !$0 { app.confirmDelete = nil } }
            )) {
                Button("Delete", role: .destructive) {
                    if let playlist = app.confirmDelete {
                        Task { await app.library.delete(playlistId: playlist.id) }
                        if case .playlist(playlist.id) = app.nav.current { app.nav.back() }
                    }
                    app.confirmDelete = nil
                }
                Button("Cancel", role: .cancel) { app.confirmDelete = nil }
            } message: {
                Text("The playlist is removed from Navidrome. The songs stay in your library.")
            }
            .alert("Remove all downloads?", isPresented: $app.confirmRemoveDownloads) {
                Button("Remove", role: .destructive) { app.downloads.removeAll() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Downloaded songs are deleted from this Mac. You can download them again any time.")
            }
    }
}

struct PlaylistNameSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let prompt: PlaylistPrompt
    @State private var name = ""
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(prompt.renaming == nil ? "New playlist" : "Rename playlist").textStyle(.title).foregroundStyle(Tok.fg)
            if prompt.renaming == nil, !prompt.tracks.isEmpty {
                Text("With \(Format.count(prompt.tracks.count, "song")).").textStyle(.small).foregroundStyle(Tok.fgMuted)
            }
            CrateTextField(placeholder: "Playlist name", text: $name) { submit() }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .buttonStyle(.crate(.secondary, size: .sm))
                    .keyboardShortcut(.cancelAction)
                Button(prompt.renaming == nil ? "Create" : "Rename") { submit() }
                    .buttonStyle(.crate(.primary, size: .sm))
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || working)
            }
        }
        .padding(24)
        .frame(width: 420)
        .background(Tok.surface)
        .onAppear { name = prompt.renaming?.displayName ?? "" }
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !working else { return }
        working = true
        Task {
            if let playlist = prompt.renaming {
                await app.library.rename(playlistId: playlist.id, to: trimmed)
            } else if let created = await app.library.createPlaylist(name: trimmed, tracks: prompt.tracks) {
                app.toasts.show("Created “\(created.displayName)”.")
            }
            working = false
            dismiss()
        }
    }
}
