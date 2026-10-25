import AppKit
import SwiftUI

// Crate design tokens. They follow Dopl's design system (docs/DESIGN_SYSTEM.md in the
// Dopl repo): a light-grey canvas, one white working panel, hairline borders, near-black
// primary actions and the lavender→sky brand used as an accent only. Dark mode redefines
// the semantic layer; components never use raw hex values.

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(nsColor: NSColor(hex: hex, alpha: alpha))
    }

    /// A colour that follows the window's effective appearance.
    init(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(hex: dark, alpha: darkAlpha)
                : NSColor(hex: light, alpha: lightAlpha)
        })
    }
}

enum Palette {
    // Brand (never for text)
    static let brandLavender = Color(hex: 0xADA8FF)
    static let brandSky = Color(hex: 0x42B0FF)
    static let brandMid = Color(hex: 0x7CACFF)
    static let brandGradient = LinearGradient(
        colors: [brandLavender, brandSky], startPoint: .topLeading, endPoint: .bottomTrailing
    )

    static let sky50 = 0xF0F8FF as UInt32
    static let sky100 = 0xDEEFFF as UInt32
    static let sky200 = 0xBEE1FF as UInt32
    static let sky300 = 0x88C9FE as UInt32
    static let sky400 = 0x42B0FF as UInt32
    static let sky500 = 0x3199E8 as UInt32
    static let sky600 = 0x1F82D1 as UInt32
    static let sky700 = 0x0A6CBA as UInt32
    static let lavender50 = 0xF6F6FF as UInt32
    static let lavender200 = 0xD9D8FE as UInt32
    static let lavender300 = 0xADA8FF as UInt32
    static let lavender500 = 0x837DED as UInt32
    static let lavender700 = 0x5B4FD9 as UInt32
}

/// Semantic colours. Light values are Dopl's; dark values keep the same hierarchy on a
/// near-black canvas.
enum Tok {
    static let canvas = Color(light: 0xF5F5F6, dark: 0x0E0E11)
    static let surface = Color(light: 0xFFFFFF, dark: 0x17171B)
    static let surfaceMuted = Color(light: 0xFAFAFA, dark: 0x1B1B20)
    static let surfaceHover = Color(light: 0xF7F7F8, dark: 0x1F1F25)
    static let surfaceSelected = Color(light: 0xF0F8FF, dark: 0x13263A)
    static let surfaceRaised = Color(light: 0xFFFFFF, dark: 0x1E1E23)
    static let sidebarHover = Color(light: 0xF0F0F2, dark: 0x18181C)
    static let sidebarActive = Color(light: 0xEBEBED, dark: 0x222228)
    static let border = Color(light: 0xECECEE, dark: 0x26262C)
    static let borderStrong = Color(light: 0xE2E2E5, dark: 0x303037)
    static let divider = Color(light: 0xD4D4D8, dark: 0x3A3A42)

    static let fg = Color(light: 0x18181B, dark: 0xEDEDF0)
    static let fgSecondary = Color(light: 0x52525B, dark: 0xC4C4CC)
    static let fgMuted = Color(light: 0x6B6B73, dark: 0x9A9AA4)
    static let fgPlaceholder = Color(light: 0x8B8B93, dark: 0x70707A)
    static let fgDisabled = Color(light: 0xA1A1AA, dark: 0x55555E)
    static let fgNav = Color(light: 0x3F3F46, dark: 0xD4D4DA)
    static let icon = Color(light: 0x6B6B73, dark: 0x9A9AA4)
    static let iconStrong = Color(light: 0x3F3F46, dark: 0xD4D4DA)
    static let link = Color(light: Palette.sky700, dark: Palette.sky300)

    // Primary actions are near-black on light and near-white on dark.
    static let primary = Color(light: 0x16161A, dark: 0xF4F4F5)
    static let primaryHover = Color(light: 0x2A2A30, dark: 0xFFFFFF)
    static let onPrimary = Color(light: 0xFFFFFF, dark: 0x16161A)

    static let accent = Color(light: Palette.sky600, dark: Palette.sky400)
    static let accentText = Color(light: Palette.sky700, dark: Palette.sky300)
    static let focus = Color(light: Palette.sky600, dark: Palette.sky500)
    static let focusHalo = Color(light: Palette.sky400, dark: Palette.sky400, lightAlpha: 0.28, darkAlpha: 0.32)
    static let selectionTint = Color(light: Palette.sky100, dark: 0x173452)

    static let danger = Color(light: 0xDC2626, dark: 0xF05252)
    static let dangerText = Color(light: 0xB91C1C, dark: 0xFCA5A5)
    static let dangerBg = Color(light: 0xFEF2F2, dark: 0x2A1416)
    static let dangerBorder = Color(light: 0xFECACA, dark: 0x5B2427)
    static let warningText = Color(light: 0xB45309, dark: 0xFCD34D)
    static let warningBg = Color(light: 0xFFFBEB, dark: 0x2A2010)
    static let warningBorder = Color(light: 0xFDE68A, dark: 0x5C4515)
    static let successText = Color(light: 0x15803D, dark: 0x86EFAC)
    static let successBg = Color(light: 0xF0FDF4, dark: 0x0F2417)
    static let success = Color(light: 0x16A34A, dark: 0x22C55E)
    static let infoText = Color(light: Palette.sky700, dark: Palette.sky300)
    static let infoBg = Color(light: Palette.sky50, dark: 0x10202F)
    static let infoBorder = Color(light: Palette.sky200, dark: 0x1D3A55)

    static let star = Color(light: 0xF59E0B, dark: 0xFBBF24)
    static let starEmpty = Color(light: 0xD4D4D8, dark: 0x45454D)
    static let heart = Color(light: 0xEC4899, dark: 0xF472B6)

    static let overlay = Color(light: 0x101014, dark: 0x000000, lightAlpha: 0.24, darkAlpha: 0.5)
    static let skeleton = Color(light: 0xF0F0F2, dark: 0x222228)
    static let skeletonHighlight = Color(light: 0xF8F8F9, dark: 0x2A2A31)
}

/// Dopl's tag palette: bg-50 / border-200 / text-700, with dark equivalents. Genres and
/// generated mix covers pick a hue by hashing their name, so colour follows the entity.
enum TagHue: String, CaseIterable, Sendable {
    case purple, red, green, lime, blue, amber, pink, teal, orange, grey

    var bg: Color {
        switch self {
        case .purple: Color(light: 0xFAF5FF, dark: 0x22172F)
        case .red: Color(light: 0xFEF2F2, dark: 0x2A1416)
        case .green: Color(light: 0xF0FDF4, dark: 0x0F2417)
        case .lime: Color(light: 0xF7FEE7, dark: 0x1A2410)
        case .blue: Color(light: 0xEFF6FF, dark: 0x111C33)
        case .amber: Color(light: 0xFFFBEB, dark: 0x2A2010)
        case .pink: Color(light: 0xFDF2F8, dark: 0x2A1222)
        case .teal: Color(light: 0xF0FDFA, dark: 0x0E2422)
        case .orange: Color(light: 0xFFF7ED, dark: 0x2A1A0E)
        case .grey: Color(light: 0xF4F4F5, dark: 0x202024)
        }
    }

    var border: Color {
        switch self {
        case .purple: Color(light: 0xE9D5FF, dark: 0x4A2F66)
        case .red: Color(light: 0xFECACA, dark: 0x5B2427)
        case .green: Color(light: 0xBBF7D0, dark: 0x1E4D2E)
        case .lime: Color(light: 0xD9F99D, dark: 0x3A5216)
        case .blue: Color(light: 0xBFDBFE, dark: 0x22386A)
        case .amber: Color(light: 0xFDE68A, dark: 0x5C4515)
        case .pink: Color(light: 0xFBCFE8, dark: 0x5A2448)
        case .teal: Color(light: 0x99F6E4, dark: 0x1D4D47)
        case .orange: Color(light: 0xFED7AA, dark: 0x5C3516)
        case .grey: Color(light: 0xE4E4E7, dark: 0x3A3A42)
        }
    }

    var text: Color {
        switch self {
        case .purple: Color(light: 0x7E22CE, dark: 0xD8B4FE)
        case .red: Color(light: 0xB91C1C, dark: 0xFCA5A5)
        case .green: Color(light: 0x15803D, dark: 0x86EFAC)
        case .lime: Color(light: 0x4D7C0F, dark: 0xBEF264)
        case .blue: Color(light: 0x1D4ED8, dark: 0x93C5FD)
        case .amber: Color(light: 0xB45309, dark: 0xFCD34D)
        case .pink: Color(light: 0xBE185D, dark: 0xF9A8D4)
        case .teal: Color(light: 0x0F766E, dark: 0x5EEAD4)
        case .orange: Color(light: 0xC2410C, dark: 0xFDBA74)
        case .grey: Color(light: 0x52525B, dark: 0xC4C4CC)
        }
    }

    var solid: Color {
        switch self {
        case .purple: Color(hex: 0xA855F7)
        case .red: Color(hex: 0xEF4444)
        case .green: Color(hex: 0x22C55E)
        case .lime: Color(hex: 0x84CC16)
        case .blue: Color(hex: 0x3B82F6)
        case .amber: Color(hex: 0xF59E0B)
        case .pink: Color(hex: 0xEC4899)
        case .teal: Color(hex: 0x14B8A6)
        case .orange: Color(hex: 0xF97316)
        case .grey: Color(hex: 0xA1A1AA)
        }
    }

    /// Stable hue for a name (FNV-1a, so it doesn't change between launches like `hashValue`).
    static func forName(_ name: String) -> TagHue {
        var hash: UInt32 = 2_166_136_261
        for byte in name.lowercased().utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        let hues = TagHue.allCases.filter { $0 != .grey }
        return hues[Int(hash % UInt32(hues.count))]
    }
}

enum Radius {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 6
    static let chip: CGFloat = 8
    static let control: CGFloat = 10
    static let card: CGFloat = 12
    static let panel: CGFloat = 16
}

enum Metrics {
    static let sidebarWidth: CGFloat = 248
    static let panelInset: CGFloat = 8
    static let headerHeight: CGFloat = 52
    static let toolbarHeight: CGFloat = 48
    static let playerHeight: CGFloat = 76
    static let rowHeight: CGFloat = 52
    static let compactRowHeight: CGFloat = 40
    static let queueWidth: CGFloat = 360
    static let contentGutter: CGFloat = 24
}

enum Motion {
    static let fast = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.12)
    static let base = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.16)
    static let slow = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.2)
}

extension View {
    /// Dopl's floating-layer shadow (popovers, menus, toasts).
    func popoverShadow() -> some View {
        shadow(color: .black.opacity(0.10), radius: 12, x: 0, y: 8)
            .shadow(color: .black.opacity(0.05), radius: 3, x: 0, y: 2)
    }

    func dialogShadow() -> some View {
        shadow(color: .black.opacity(0.18), radius: 32, x: 0, y: 24)
            .shadow(color: .black.opacity(0.06), radius: 6, x: 0, y: 4)
    }

    func hairline(_ radius: CGFloat, color: Color = Tok.border) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(color, lineWidth: 1))
    }
}
