import AppKit
import SwiftUI

// MARK: - Buttons

enum ButtonKind {
    case primary, secondary, ghost, danger
}

enum ControlSize2 {
    case lg, md, sm, xs
    var height: CGFloat {
        switch self {
        case .lg: 40
        case .md: 36
        case .sm: 32
        case .xs: 28
        }
    }

    var text: TextStyle { self == .lg || self == .md ? .bodyStrong : .smallStrong }
    var iconSize: CGFloat { self == .xs ? 12 : (self == .sm ? 13 : 14) }
    var padding: CGFloat { self == .xs ? 8 : (self == .sm ? 10 : 14) }
}

struct CrateButtonStyle: ButtonStyle {
    var kind: ButtonKind = .secondary
    var size: ControlSize2 = .md
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        CrateButtonBody(configuration: configuration, kind: kind, size: size, fullWidth: fullWidth)
    }
}

private struct CrateButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let kind: ButtonKind
    let size: ControlSize2
    let fullWidth: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .textStyle(size.text)
            .labelStyle(CrateLabelStyle(iconSize: size.iconSize))
            .lineLimit(1)
            .padding(.horizontal, size.padding)
            .frame(height: size.height)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay {
                if kind == .secondary {
                    RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Tok.borderStrong, lineWidth: 1)
                }
            }
            .shadow(color: kind == .secondary ? .black.opacity(0.04) : .clear, radius: 1, y: 1)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.45)
            .contentShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .onHover { hovering = $0 }
            .animation(Motion.fast, value: hovering)
    }

    private var foreground: Color {
        switch kind {
        case .primary: Tok.onPrimary
        case .secondary, .ghost: Tok.fg
        case .danger: .white
        }
    }

    private var background: Color {
        switch kind {
        case .primary: hovering && isEnabled ? Tok.primaryHover : Tok.primary
        case .secondary: hovering && isEnabled ? Tok.surfaceHover : Tok.surface
        case .ghost: hovering && isEnabled ? Tok.sidebarHover : .clear
        case .danger: Tok.danger
        }
    }
}

struct CrateLabelStyle: LabelStyle {
    var iconSize: CGFloat = 14
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.font(.system(size: iconSize, weight: .medium))
            configuration.title
        }
    }
}

extension ButtonStyle where Self == CrateButtonStyle {
    static func crate(_ kind: ButtonKind = .secondary, size: ControlSize2 = .md, fullWidth: Bool = false) -> CrateButtonStyle {
        CrateButtonStyle(kind: kind, size: size, fullWidth: fullWidth)
    }
}

/// Square icon-only ghost button (toolbar, rows, player).
struct IconButton: View {
    let symbol: String
    var help: String = ""
    var size: CGFloat = 28
    var iconSize: CGFloat = 14
    var tint: Color = Tok.icon
    var active = false
    var activeTint: Color = Tok.accent
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: iconSize, weight: .medium))
                .foregroundStyle(active ? activeTint : (hovering ? Tok.iconStrong : tint))
                .frame(width: size, height: size)
                .background(hovering ? Tok.sidebarHover : .clear, in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
    }
}

/// The round near-black play button used on cards and heroes.
struct PlayCircleButton: View {
    var size: CGFloat = 40
    var symbol = "play.fill"
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.36, weight: .semibold))
                .foregroundStyle(Tok.onPrimary)
                .offset(x: symbol == "play.fill" ? size * 0.03 : 0)
                .frame(width: size, height: size)
                .background(hovering ? Tok.primaryHover : Tok.primary, in: Circle())
                .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
                .scaleEffect(hovering ? 1.04 : 1)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
    }
}

// MARK: - Inputs

struct CrateTextField: View {
    let placeholder: String
    @Binding var text: String
    var icon: String?
    var secure = false
    var height: CGFloat = 36
    var onSubmit: () -> Void = {}
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Tok.fgPlaceholder)
            }
            Group {
                if secure {
                    SecureField("", text: $text, prompt: Text(placeholder).foregroundStyle(Tok.fgPlaceholder))
                } else {
                    TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Tok.fgPlaceholder))
                }
            }
            .textFieldStyle(.plain)
            .textStyle(.body)
            .foregroundStyle(Tok.fg)
            .focused($focused)
            .onSubmit(onSubmit)
            if !text.isEmpty, !secure, icon == "magnifyingglass" {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Tok.fgDisabled)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 11)
        .frame(height: height)
        .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(focused ? Tok.focus : Tok.borderStrong, lineWidth: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.control + 3, style: .continuous)
                .strokeBorder(Tok.focusHalo, lineWidth: 3)
                .padding(-3)
                .opacity(focused ? 1 : 0)
        )
        .animation(Motion.fast, value: focused)
    }
}

/// Dopl-style segmented control.
struct Segmented<Value: Hashable>: View {
    let options: [(Value, String)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, label in
                Button {
                    selection = value
                } label: {
                    Text(label)
                        .textStyle(.smallStrong)
                        .foregroundStyle(selection == value ? Tok.fg : Tok.fgMuted)
                        .padding(.horizontal, 12)
                        .frame(height: 26)
                        .background {
                            if selection == value {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(Tok.surfaceRaised)
                                    .shadow(color: .black.opacity(0.08), radius: 1.5, y: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(Tok.sidebarActive, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .animation(Motion.fast, value: selection)
    }
}

/// "Sorted by **Name**" chip with a menu (Dopl toolbar).
struct SortChip<Value: Hashable>: View {
    let label: String
    let options: [(Value, String)]
    @Binding var selection: Value

    var body: some View {
        Menu {
            ForEach(options, id: \.0) { value, title in
                Button {
                    selection = value
                } label: {
                    if value == selection {
                        Label(title, systemImage: "checkmark")
                    } else {
                        Text(title)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.arrow.down")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Tok.icon)
                (Text(label + " ").foregroundStyle(Tok.fgMuted) + Text(options.first { $0.0 == selection }?.1 ?? "").foregroundStyle(Tok.fg))
                    .textStyle(.smallStrong)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .hairline(Radius.control, color: Tok.borderStrong)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
    }
}

// MARK: - Display

struct Pill: View {
    let text: String
    var hue: TagHue = .grey
    var symbol: String?

    var body: some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 9, weight: .bold))
            }
            Text(text).textStyle(.captionStrong)
        }
        .foregroundStyle(hue.text)
        .padding(.horizontal, 7)
        .frame(height: 20)
        .background(hue.bg, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(hue.border, lineWidth: 1))
        .fixedSize()
    }
}

/// Marks songs and albums that come from a provider through octo-fiesta.
struct ExternalPill: View {
    let provider: String?
    var body: some View {
        Pill(text: provider ?? "External", hue: .purple, symbol: "arrow.down.forward")
            .help("Not in your library yet. octo-fiesta fetches it from \(provider ?? "the provider") when you play it.")
    }
}

struct Kbd: View {
    let keys: String
    var body: some View {
        Text(keys)
            .textStyle(.micro)
            .foregroundStyle(Tok.fgMuted)
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 18)
            .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Tok.borderStrong, lineWidth: 1))
    }
}

struct SectionTitle: View {
    let title: String
    var count: Int?
    var action: (String, () -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).textStyle(.title).foregroundStyle(Tok.fg)
            if let count {
                Text(count.formatted()).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
            }
            Spacer()
            if let action {
                Button(action: action.1) {
                    HStack(spacing: 3) {
                        Text(action.0)
                        Image(systemName: "arrow.right").font(.system(size: 10, weight: .semibold))
                    }
                    .textStyle(.smallStrong)
                    .foregroundStyle(Tok.fgMuted)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct EmptyState: View {
    let symbol: String
    let title: String
    let message: String
    var action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Tok.accent)
                .frame(width: 48, height: 48)
                .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .hairline(Radius.card)
            Text(title).textStyle(.title).foregroundStyle(Tok.fg)
            Text(message)
                .textStyle(.body)
                .foregroundStyle(Tok.fgMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            if let action {
                Button(action.0, action: action.1)
                    .buttonStyle(.crate(.primary, size: .sm))
                    .padding(.top, 4)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity)
    }
}

struct Callout: View {
    enum Kind { case info, warning, danger, success }
    let kind: Kind
    let message: String
    var symbol: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol ?? defaultSymbol)
                .font(.system(size: 13, weight: .semibold))
                .padding(.top, 1)
            Text(message).textStyle(.small).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(fg)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(bg, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(border, lineWidth: 1))
    }

    private var defaultSymbol: String {
        switch kind {
        case .info: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .danger: "xmark.octagon"
        case .success: "checkmark.circle"
        }
    }

    private var fg: Color {
        switch kind {
        case .info: Tok.infoText
        case .warning: Tok.warningText
        case .danger: Tok.dangerText
        case .success: Tok.successText
        }
    }

    private var bg: Color {
        switch kind {
        case .info: Tok.infoBg
        case .warning: Tok.warningBg
        case .danger: Tok.dangerBg
        case .success: Tok.successBg
        }
    }

    private var border: Color {
        switch kind {
        case .info: Tok.infoBorder
        case .warning: Tok.warningBorder
        case .danger: Tok.dangerBorder
        case .success: Tok.successText.opacity(0.3)
        }
    }
}

struct Skeleton: View {
    var width: CGFloat?
    var height: CGFloat = 12
    var radius: CGFloat = 6
    @State private var phase: CGFloat = -1

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(Tok.skeleton)
            .overlay(
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, Tok.skeletonHighlight, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.6)
                        .offset(x: phase * geo.size.width * 1.6)
                }
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            )
            .frame(width: width, height: height)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}

struct Hairline: View {
    var vertical = false
    var body: some View {
        Rectangle()
            .fill(Tok.border)
            .frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
    }
}

// MARK: - Artwork

struct Artwork: View {
    let coverArt: String?
    var url: URL?
    let size: CGFloat
    var radius: CGFloat = 8
    var circle = false
    var placeholderSymbol = "music.note"
    var placeholderName: String?
    @State private var image: NSImage?
    /// The cover the current image belongs to; the view is reused when its cover changes
    /// (the player bar moving to the next song), so a stale image must never linger.
    @State private var imageKey: String

    init(coverArt: String?, url: URL? = nil, size: CGFloat, radius: CGFloat = 8, circle: Bool = false,
         placeholderSymbol: String = "music.note", placeholderName: String? = nil) {
        self.coverArt = coverArt
        self.url = url
        self.size = size
        self.radius = radius
        self.circle = circle
        self.placeholderSymbol = placeholderSymbol
        self.placeholderName = placeholderName
        _image = State(initialValue: Self.immediate(coverArt: coverArt, url: url, size: size))
        _imageKey = State(initialValue: Self.key(coverArt: coverArt, url: url, size: size))
    }

    private static func key(coverArt: String?, url: URL?, size: CGFloat) -> String {
        (coverArt ?? "") + "|" + (url?.absoluteString ?? "") + "|\(Int(size))"
    }

    private static func immediate(coverArt: String?, url: URL?, size: CGFloat) -> NSImage? {
        ImageCache.shared.memoryImage(coverArt: coverArt, url: url, points: size)
            ?? ImageCache.shared.diskImageSync(coverArt: coverArt, url: url, points: size)
    }

    var body: some View {
        ZStack {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            } else if let placeholderName, circle {
                let hue = TagHue.forName(placeholderName)
                hue.bg
                Text(Self.initials(placeholderName))
                    .font(CrateFonts.font(size: size * 0.32, weight: .semibold))
                    .foregroundStyle(hue.text)
            } else {
                Tok.surfaceMuted
                Image(systemName: placeholderSymbol)
                    .font(.system(size: max(10, size * 0.26), weight: .regular))
                    .foregroundStyle(Tok.fgDisabled)
            }
        }
        .frame(width: size, height: size)
        .clipShape(circle ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous)))
        .overlay {
            if circle {
                Circle().strokeBorder(Tok.border.opacity(0.8), lineWidth: 1)
            } else {
                RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Tok.border.opacity(0.8), lineWidth: 1)
            }
        }
        .task(id: Self.key(coverArt: coverArt, url: url, size: size)) {
            let key = Self.key(coverArt: coverArt, url: url, size: size)
            if imageKey != key {
                imageKey = key
                image = Self.immediate(coverArt: coverArt, url: url, size: size)
            }
            guard image == nil else { return }
            let loaded = await ImageCache.shared.image(coverArt: coverArt, url: url, points: size)
            if let loaded, imageKey == key {
                withAnimation(.easeOut(duration: 0.14)) { image = loaded }
            }
        }
    }

    static func initials(_ name: String) -> String {
        let words = name.split(separator: " ").filter { $0.first?.isLetter == true || $0.first?.isNumber == true }
        let letters = words.prefix(2).compactMap(\.first).map(String.init)
        return letters.joined().uppercased().isEmpty ? "?" : letters.joined().uppercased()
    }
}

/// Generated cover for mixes and genres: a tag-palette tile with a symbol, never the
/// brand gradient (that's kept for the logo).
struct GeneratedCover: View {
    let title: String
    let symbol: String
    let hue: TagHue
    var size: CGFloat
    var radius: CGFloat = 12
    var showTitle = true

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            hue.bg
            Image(systemName: symbol)
                .font(.system(size: size * 0.42, weight: .light))
                .foregroundStyle(hue.solid.opacity(0.22))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(size * 0.08)
            if showTitle {
                Text(title)
                    .font(CrateFonts.font(size: max(11, size * 0.11), weight: .semibold))
                    .foregroundStyle(hue.text)
                    .lineLimit(2)
                    .padding(size * 0.08)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(hue.border, lineWidth: 1))
    }
}

// MARK: - Rating, favourite, now playing

struct StarRating: View {
    let rating: Int
    var size: CGFloat = 11
    var spacing: CGFloat = 1
    var showEmpty = true
    let onSet: (Int) -> Void
    @State private var hoverValue: Int?

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(1...5, id: \.self) { value in
                let filled = value <= (hoverValue ?? rating)
                Image(systemName: filled ? "star.fill" : "star")
                    .font(.system(size: size, weight: .medium))
                    .foregroundStyle(filled ? Tok.star : Tok.starEmpty)
                    .opacity(showEmpty || filled || hoverValue != nil ? 1 : 0)
                    .frame(width: size + 3, height: size + 6)
                    .contentShape(Rectangle())
                    .onHover { inside in
                        if inside { hoverValue = value } else if hoverValue == value { hoverValue = nil }
                    }
                    .onTapGesture {
                        // Clicking the current rating clears it.
                        onSet(value == rating ? 0 : value)
                    }
            }
        }
        .help(rating > 0 ? "Rated \(rating) of 5" : "Rate this song")
    }
}

struct HeartButton: View {
    let isOn: Bool
    var size: CGFloat = 13
    var visibleWhenOff = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: isOn ? "heart.fill" : "heart")
                .font(.system(size: size, weight: .medium))
                .foregroundStyle(isOn ? Tok.heart : (hovering ? Tok.iconStrong : Tok.icon))
                .opacity(isOn || visibleWhenOff || hovering ? 1 : 0)
                .frame(width: size + 14, height: size + 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isOn ? "Remove from favourites" : "Add to favourites")
        .onHover { hovering = $0 }
    }
}

/// Three bars that move while a song plays (static when paused).
struct NowPlayingBars: View {
    var animating: Bool
    var color: Color = Tok.accent
    var height: CGFloat = 12

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 24, paused: !animating)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(0..<3, id: \.self) { i in
                    let phase = t * (3.2 + Double(i) * 1.1) + Double(i) * 1.7
                    let level = animating ? 0.35 + 0.65 * abs(sin(phase)) : [0.5, 0.8, 0.4][i]
                    RoundedRectangle(cornerRadius: 1)
                        .fill(color)
                        .frame(width: 2.5, height: max(2, height * level))
                }
            }
            .frame(height: height, alignment: .bottom)
        }
    }
}

// MARK: - Brand

/// The Crate mark: two records standing in a crate. The records carry the brand
/// gradient; the crate is the primary colour, so it flips with the appearance.
/// Mirrors scripts/make-icon.swift.
struct CrateMark: View {
    var size: CGFloat = 28
    var cutout: Color = Tok.canvas

    var body: some View {
        let s = size
        ZStack {
            record(diameter: s * 0.5)
                .opacity(0.45)
                .position(x: s * 0.33, y: s * 0.38)
            record(diameter: s * 0.64)
                .position(x: s * 0.56, y: s * 0.42)
            crate
                .frame(width: s * 0.84, height: s * 0.42)
                .position(x: s * 0.5, y: s * 0.73)
        }
        .frame(width: s, height: s)
    }

    private func record(diameter d: CGFloat) -> some View {
        ZStack {
            Circle().fill(Palette.brandGradient)
            Circle()
                .strokeBorder(Color.white.opacity(0.36), lineWidth: max(0.75, size * 0.02))
                .padding(d * 0.17)
            Circle().fill(cutout).frame(width: d * 0.15, height: d * 0.15)
        }
        .frame(width: d, height: d)
    }

    private var crate: some View {
        let s = size
        let gap = max(1.2, s * 0.035)
        let post = s * 0.08
        return GeometryReader { geo in
            let plank = (geo.size.height - gap * 2) / 3
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: s * 0.035, style: .continuous)
                    .frame(width: post, height: geo.size.height)
                RoundedRectangle(cornerRadius: s * 0.035, style: .continuous)
                    .frame(width: post, height: geo.size.height)
                    .offset(x: geo.size.width - post)
                ForEach(0..<3, id: \.self) { i in
                    RoundedRectangle(cornerRadius: s * 0.03, style: .continuous)
                        .frame(width: geo.size.width - post, height: plank)
                        .offset(x: post * 0.5, y: CGFloat(i) * (plank + gap))
                }
            }
            .foregroundStyle(Tok.primary)
        }
    }
}

struct Wordmark: View {
    var size: CGFloat = 22
    var body: some View {
        Text("Crate")
            .font(CrateFonts.wordmark(size: size))
            .tracking(-0.015 * size)
            .foregroundStyle(Tok.fg)
    }
}

// MARK: - Hover helpers

struct HoverBackground: ViewModifier {
    var radius: CGFloat = Radius.control
    var color: Color = Tok.surfaceHover
    var selected = false
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(selected ? Tok.surfaceSelected : (hovering ? color : .clear))
            )
            .onHover { hovering = $0 }
    }
}

extension View {
    func hoverBackground(radius: CGFloat = Radius.control, color: Color = Tok.surfaceHover, selected: Bool = false) -> some View {
        modifier(HoverBackground(radius: radius, color: color, selected: selected))
    }

    /// Dopl's fade at the bottom edge of scroll areas.
    func fadeBottom(_ height: CGFloat = 40) -> some View {
        mask(
            VStack(spacing: 0) {
                Rectangle()
                LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: height)
            }
        )
    }
}
