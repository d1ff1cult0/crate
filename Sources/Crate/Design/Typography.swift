import AppKit
import CoreText
import SwiftUI

/// Registers the bundled fonts (Inter for UI text, Outfit for the wordmark) and builds
/// fonts with Dopl's OpenType features: `cv11` + `ss01` everywhere, `tnum` for numbers.
enum CrateFonts {
    private static var registered = false
    private(set) static var interAvailable = false
    private(set) static var outfitAvailable = false

    static func register() {
        guard !registered else { return }
        registered = true
        var urls: [URL] = []
        if let dir = Bundle.main.resourceURL?.appendingPathComponent("Fonts") {
            urls += (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        }
        // `swift run` from the repo: fall back to Resources/Fonts next to the package.
        if urls.isEmpty {
            let repoFonts = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Resources/Fonts")
            urls += (try? FileManager.default.contentsOfDirectory(at: repoFonts, includingPropertiesForKeys: nil)) ?? []
        }
        for url in urls where url.pathExtension.lowercased() == "ttf" {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        interAvailable = NSFont(name: "Inter-Regular", size: 12) != nil
        outfitAvailable = NSFont(name: "Outfit-SemiBold", size: 12) != nil
    }

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: [String: NSFont] = [:]

    static func nsFont(size: CGFloat, weight: Font.Weight, tabular: Bool = false) -> NSFont {
        let key = "\(size)-\(weight.key)-\(tabular)"
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let font = cache[key] { return font }

        let base: NSFont
        if interAvailable, let inter = NSFont(name: weight.interName, size: size) {
            base = inter
        } else {
            base = NSFont.systemFont(ofSize: size, weight: weight.nsWeight)
        }
        var features: [[NSFontDescriptor.FeatureKey: Any]] = []
        if interAvailable {
            features.append(openType("cv11"))
            features.append(openType("ss01"))
        }
        if tabular {
            features.append(openType("tnum"))
        }
        let descriptor = base.fontDescriptor.addingAttributes([.featureSettings: features])
        let font = NSFont(descriptor: descriptor, size: size) ?? base
        cache[key] = font
        return font
    }

    static func font(size: CGFloat, weight: Font.Weight, tabular: Bool = false) -> Font {
        Font(nsFont(size: size, weight: weight, tabular: tabular) as CTFont)
    }

    static func wordmark(size: CGFloat) -> Font {
        if outfitAvailable, let outfit = NSFont(name: "Outfit-SemiBold", size: size) {
            return Font(outfit as CTFont)
        }
        return font(size: size, weight: .semibold)
    }

    private static func openType(_ tag: String) -> [NSFontDescriptor.FeatureKey: Any] {
        [
            NSFontDescriptor.FeatureKey(rawValue: kCTFontOpenTypeFeatureTag as String): tag,
            NSFontDescriptor.FeatureKey(rawValue: kCTFontOpenTypeFeatureValue as String): 1,
        ]
    }
}

private extension Font.Weight {
    var key: String {
        switch self {
        case .medium: "m"
        case .semibold: "s"
        case .bold, .heavy, .black: "b"
        default: "r"
        }
    }

    var interName: String {
        switch self {
        case .medium: "Inter-Medium"
        case .semibold: "Inter-SemiBold"
        case .bold, .heavy, .black: "Inter-Bold"
        default: "Inter-Regular"
        }
    }

    var nsWeight: NSFont.Weight {
        switch self {
        case .medium: .medium
        case .semibold: .semibold
        case .bold, .heavy, .black: .bold
        default: .regular
        }
    }
}

/// Dopl's type scale (§3.7), plus a `hero` size for album and playlist headers.
enum TextStyle {
    case hero, display, titleLarge, title, nav, body, bodyStrong, small, smallStrong, caption, captionStrong, micro

    var size: CGFloat {
        switch self {
        case .hero: 28
        case .display: 24
        case .titleLarge: 20
        case .title: 16
        case .nav: 15
        case .body, .bodyStrong: 14
        case .small, .smallStrong: 13
        case .caption, .captionStrong: 12
        case .micro: 11
        }
    }

    var weight: Font.Weight {
        switch self {
        case .hero, .display, .titleLarge, .title: .semibold
        case .nav, .bodyStrong, .smallStrong, .captionStrong: .medium
        case .micro: .semibold
        default: .regular
        }
    }

    var tracking: CGFloat {
        switch self {
        case .hero, .display: -0.015 * size
        case .titleLarge: -0.012 * size
        case .title, .nav: -0.006 * size
        case .body, .bodyStrong: -0.003 * size
        case .micro: 0.01 * size
        default: 0
        }
    }
}

extension View {
    func textStyle(_ style: TextStyle, tabular: Bool = false) -> some View {
        font(CrateFonts.font(size: style.size, weight: style.weight, tabular: tabular))
            .tracking(style.tracking)
    }
}

extension Text {
    func style(_ style: TextStyle, tabular: Bool = false) -> Text {
        font(CrateFonts.font(size: style.size, weight: style.weight, tabular: tabular))
            .tracking(style.tracking)
    }
}
