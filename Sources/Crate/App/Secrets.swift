import CryptoKit
import Foundation
import IOKit
import Security

/// Secrets: the server password, the ListenBrainz token and the Last.fm API key.
///
/// They live in an encrypted file in Application Support rather than the keychain. Crate
/// is ad-hoc signed, and macOS ties keychain items to the exact code hash of the build
/// that created them, so every update would ask again for access to each item. The file
/// is readable only by the user (0600) and encrypted with AES-GCM under a key derived from
/// this Mac's hardware UUID, so a copy in a backup is useless on another machine.
///
/// Secrets saved in the keychain by Crate 1.0 are moved over on first use (macOS asks once
/// per item) and never read from the keychain again.
enum Secrets {
    private static var cache: [String: String]?
    private static let lock = NSLock()

    static func get(_ name: String) -> String? {
        lock.withLock { load()[name] }
    }

    static func set(_ value: String?, for name: String) {
        lock.withLock {
            var all = load()
            if let value, !value.isEmpty { all[name] = value } else { all[name] = nil }
            guard all != cache else { return }
            cache = all
            save(all)
        }
    }

    // MARK: Storage

    private static func load() -> [String: String] {
        if let cache { return cache }
        if let data = try? Data(contentsOf: AppPaths.secrets), let decoded = decrypt(data) {
            cache = decoded
            return decoded
        }
        let migrated = LegacyKeychain.takeAll()
        cache = migrated
        if !migrated.isEmpty { save(migrated) }
        return migrated
    }

    private static func save(_ secrets: [String: String]) {
        guard let plain = try? JSONEncoder().encode(secrets),
              let sealed = try? AES.GCM.seal(plain, using: key).combined else { return }
        let url = AppPaths.secrets
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? sealed.write(to: url, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private static func decrypt(_ data: Data) -> [String: String]? {
        guard let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: plain)
    }

    private static let key: SymmetricKey = {
        let material = Data((hardwareUUID() + "|" + AppPaths.bundleID + "|crate-secrets-v1").utf8)
        return SymmetricKey(data: SHA256.hash(data: material))
    }()

    private static func hardwareUUID() -> String {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0)
        return (value?.takeRetainedValue() as? String) ?? NSUserName()
    }
}

/// Crate 1.0 kept secrets as generic passwords under the bundle id.
private enum LegacyKeychain {
    static func takeAll() -> [String: String] {
        let service = AppPaths.bundleID
        let list: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecReturnAttributes: true, kSecMatchLimit: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(list as CFDictionary, &items) == errSecSuccess else { return [:] }
        var result: [String: String] = [:]
        for attributes in (items as? [[String: Any]]) ?? [] {
            guard let account = attributes[kSecAttrAccount as String] as? String else { continue }
            let query: [CFString: Any] = [
                kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account,
                kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
            ]
            var data: CFTypeRef?
            if SecItemCopyMatching(query as CFDictionary, &data) == errSecSuccess, let data = data as? Data,
               let value = String(data: data, encoding: .utf8) {
                result[account] = value
            }
        }
        return result
    }
}
