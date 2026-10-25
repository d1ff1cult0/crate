import Foundation

enum Format {
    static func duration(_ seconds: Int) -> String {
        guard seconds > 0 else { return "–:––" }
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        let s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        return duration(max(Int(seconds.rounded(.down)), 0)).replacingOccurrences(of: "–:––", with: "0:00")
    }

    /// "12 h 39 min", "47 min".
    static func longDuration(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 { return m > 0 ? "\(h) h \(m) min" : "\(h) h" }
        return "\(max(m, seconds > 0 ? 1 : 0)) min"
    }

    static func count(_ n: Int, _ singular: String, _ plural: String? = nil) -> String {
        let formatted = n.formatted(.number)
        return "\(formatted) \(n == 1 ? singular : (plural ?? singular + "s"))"
    }

    static func bytes(_ n: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: n, countStyle: .file)
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return "never" }
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let isoLock = NSLock()

    /// Subsonic dates come with anything from 0 to 9 fractional digits; seconds are enough.
    static func parseDate(_ string: String) -> Date? {
        guard !string.isEmpty else { return nil }
        var s = string
        if let dot = s.firstIndex(of: "."), let end = s[dot...].firstIndex(where: { !$0.isNumber && $0 != "." }) {
            s.removeSubrange(dot..<end)
        } else if let dot = s.firstIndex(of: ".") {
            s.removeSubrange(dot..<s.endIndex)
            s += "Z"
        }
        isoLock.lock()
        defer { isoLock.unlock() }
        return isoFormatter.date(from: s)
    }

    static func greeting(for date: Date = Date()) -> String {
        let hour = Calendar.current.component(.hour, from: date)
        switch hour {
        case 5..<12: return "Good morning"
        case 12..<18: return "Good afternoon"
        default: return "Good evening"
        }
    }
}

/// Normalised keys for matching songs across sources (ListenBrainz, Last.fm, octo-fiesta)
/// against the library, where titles differ in "(feat. …)", remaster suffixes and accents.
enum TextKey {
    static func fold(_ s: String) -> String {
        let folded = s.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
        var out = ""
        out.reserveCapacity(folded.count)
        var lastWasSpace = true
        for ch in folded {
            if ch == "'" || ch == "’" || ch == "`" { continue }
            if ch == "&" {
                if !lastWasSpace { out.append(" ") }
                out += "and "
                lastWasSpace = true
                continue
            }
            if ch.isLetter || ch.isNumber {
                out.append(ch)
                lastWasSpace = false
            } else if !lastWasSpace {
                out.append(" ")
                lastWasSpace = true
            }
        }
        if out.hasSuffix(" ") { out.removeLast() }
        return out
    }

    private static let noiseWords = [
        "feat", "ft", "featuring", "with", "remaster", "remastered", "radio edit", "single version",
        "album version", "explicit", "clean", "mono", "stereo", "bonus track", "original mix", "deluxe",
    ]

    /// Title without featured artists, remaster notes or version noise.
    static func title(_ s: String) -> String {
        var t = s
        // Bracketed segments that only carry noise: "(feat. X)", "[Remastered 2011]".
        for (open, close) in [("(", ")"), ("[", "]")] {
            var result = ""
            var depth = 0
            var segment = ""
            for ch in t {
                if String(ch) == open {
                    depth += 1
                    if depth == 1 { segment = ""; continue }
                }
                if String(ch) == close, depth > 0 {
                    depth -= 1
                    if depth == 0 {
                        let lower = segment.lowercased()
                        if !noiseWords.contains(where: { lower.contains($0) }) {
                            result += open + segment + close
                        }
                        continue
                    }
                }
                if depth > 0 { segment.append(ch) } else { result.append(ch) }
            }
            t = result
        }
        // " - 2011 Remaster", " - Radio Edit"
        if let dash = t.range(of: " - ", options: .backwards) {
            let tail = t[dash.upperBound...].lowercased()
            if noiseWords.contains(where: { tail.contains($0) }) {
                t = String(t[..<dash.lowerBound])
            }
        }
        // "Song feat. X" without brackets
        for marker in [" feat. ", " ft. ", " feat ", " featuring "] {
            if let r = t.range(of: marker, options: .caseInsensitive) {
                t = String(t[..<r.lowerBound])
            }
        }
        return fold(t)
    }

    /// Individual artist names from a credit like "A feat. B & C".
    static func artists(_ s: String) -> [String] {
        var parts = [s]
        for separator in [" feat. ", " feat ", " ft. ", " featuring ", " & ", ", ", " x ", " X ", " and ", " with ", "; ", " / ", " vs. "] {
            parts = parts.flatMap { $0.components(separatedBy: separator) }
        }
        return parts.map(fold).filter { !$0.isEmpty }
    }

    /// The first credited artist as written ("Daft Punk" from "Daft Punk feat. Pharrell").
    static func primaryCredit(_ s: String) -> String {
        var first = s
        for separator in [" feat. ", " feat ", " ft. ", " featuring ", " & ", ", ", " x ", " with ", "; ", " / "] {
            if let range = first.range(of: separator, options: .caseInsensitive) {
                first = String(first[..<range.lowerBound])
            }
        }
        return first.trimmingCharacters(in: .whitespaces)
    }

    static func primaryArtist(_ s: String) -> String {
        artists(s).first ?? fold(s)
    }

    /// Whether two artist credits plausibly name the same performer.
    static func artistsOverlap(_ a: String, _ b: String) -> Bool {
        let left = Set(artists(a))
        let right = Set(artists(b))
        if !left.isDisjoint(with: right) { return true }
        let fa = fold(a)
        let fb = fold(b)
        guard !fa.isEmpty, !fb.isEmpty else { return false }
        return fa.contains(fb) || fb.contains(fa)
    }

    /// A key identifying "the same song" regardless of album, used to keep duplicates out
    /// of autoplay and mixes.
    static func songKey(title: String, artist: String) -> String {
        "\(primaryArtist(artist))|\(self.title(title))"
    }
}
