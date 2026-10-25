import AppKit
import CryptoKit
import ImageIO
import Observation

/// Artwork cache: memory → disk → network. Covers are kept on disk per size bucket, and
/// after a sync every album and artist cover is fetched in the background (see
/// `ArtworkPrefetcher`), so the library renders from disk instead of the network.
/// Navidrome cover art ids carry a change timestamp (`al-…_6a58f350`), which keeps the
/// cache honest when artwork changes.
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    static let buckets = [96, 160, 400, 800]
    /// The size the prefetcher stores; every smaller view can be served from it.
    static let prefetchSize = 400

    private let memory = NSCache<NSString, NSImage>()
    private let lock = NSLock()
    private var inFlight: [String: Task<NSImage?, Never>] = [:]
    private var client: SubsonicClient?
    private var directoryStorage: URL
    private let session: URLSession

    var directory: URL { lock.withLock { directoryStorage } }

    private init() {
        memory.totalCostLimit = 384 * 1024 * 1024
        directoryStorage = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Crate/Artwork", isDirectory: true)
        let config = URLSessionConfiguration.default
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        config.httpMaximumConnectionsPerHost = 6
        session = URLSession(configuration: config)
        try? FileManager.default.createDirectory(at: directoryStorage, withIntermediateDirectories: true)
    }

    func configure(client: SubsonicClient?) {
        lock.withLock {
            self.client = client
            if let client {
                directoryStorage = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("Crate/Artwork/\(client.account.key)", isDirectory: true)
                try? FileManager.default.createDirectory(at: directoryStorage, withIntermediateDirectories: true)
            }
        }
    }

    /// Pixel size requested from the server for a given point size (2× for Retina,
    /// rounded to a few buckets so different views share files).
    static func bucket(for points: CGFloat) -> Int {
        let pixels = points * 2
        return buckets.first { CGFloat($0) >= pixels } ?? 800
    }

    private func key(coverArt: String, size: Int) -> String { "\(coverArt)@\(size)" }

    private func key(url: URL, size: Int) -> String {
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return "u-\(digest)@\(size)"
    }

    private func keyBuilder(coverArt: String?, url: URL?) -> ((Int) -> String)? {
        if let coverArt, !coverArt.isEmpty { return { self.key(coverArt: coverArt, size: $0) } }
        if let url { return { self.key(url: url, size: $0) } }
        return nil
    }

    private func fileURL(for key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "@" ? $0 : "_" }
        return directory.appendingPathComponent(String(safe) + ".img")
    }

    // MARK: Lookups

    func memoryImage(coverArt: String?, url: URL?, points: CGFloat) -> NSImage? {
        guard let keyFor = keyBuilder(coverArt: coverArt, url: url) else { return nil }
        return memory.object(forKey: keyFor(Self.bucket(for: points)) as NSString)
    }

    /// Thumbnails are a few KB and decode in well under a millisecond, so rows read them
    /// from disk synchronously and never flash a placeholder.
    func diskImageSync(coverArt: String?, url: URL?, points: CGFloat) -> NSImage? {
        let size = Self.bucket(for: points)
        guard size <= 160, let keyFor = keyBuilder(coverArt: coverArt, url: url) else { return nil }
        guard let image = loadFromDisk(keyFor: keyFor, size: size) else { return nil }
        memory.setObject(image, forKey: keyFor(size) as NSString, cost: size * size * 4)
        return image
    }

    /// The exact bucket, or any larger one already on disk (scaled down on decode).
    private func loadFromDisk(keyFor: (Int) -> String, size: Int) -> NSImage? {
        for bucket in [size] + Self.buckets.filter({ $0 > size }) {
            let file = fileURL(for: keyFor(bucket))
            if let data = try? Data(contentsOf: file), let image = Self.decode(data, maxPixels: size) {
                return image
            }
        }
        return nil
    }

    func image(coverArt: String?, url: URL?, points: CGFloat) async -> NSImage? {
        let size = Self.bucket(for: points)
        guard let keyFor = keyBuilder(coverArt: coverArt, url: url) else { return nil }
        let cacheKey = keyFor(size)
        if let hit = memory.object(forKey: cacheKey as NSString) { return hit }
        let remote: URL? = if let coverArt, !coverArt.isEmpty {
            lock.withLock { client?.coverArtURL(id: coverArt, size: size) }
        } else {
            url
        }
        let file = fileURL(for: cacheKey)
        let session = self.session
        let task: Task<NSImage?, Never> = lock.withLock {
            if let existing = inFlight[cacheKey] { return existing }
            let task = Task.detached(priority: .userInitiated) { [self] () -> NSImage? in
                if let image = loadFromDisk(keyFor: keyFor, size: size) { return image }
                guard let remote, let data = await Self.download(remote, session: session),
                      let image = Self.decode(data, maxPixels: size) else { return nil }
                try? data.write(to: file, options: .atomic)
                return image
            }
            inFlight[cacheKey] = task
            return task
        }
        let image = await task.value
        lock.withLock { inFlight[cacheKey] = nil }
        if let image {
            memory.setObject(image, forKey: cacheKey as NSString, cost: size * size * 4)
        }
        return image
    }

    // MARK: Prefetching

    func isOnDisk(coverArt: String, size: Int = ImageCache.prefetchSize) -> Bool {
        Self.buckets.filter { $0 >= size }.contains { FileManager.default.fileExists(atPath: fileURL(for: key(coverArt: coverArt, size: $0)).path) }
    }

    /// Downloads a cover to disk without decoding it. Returns false on failure.
    func prefetch(coverArt: String, size: Int = ImageCache.prefetchSize) async -> Bool {
        if isOnDisk(coverArt: coverArt, size: size) { return true }
        guard let remote = lock.withLock({ client?.coverArtURL(id: coverArt, size: size) }),
              let data = await Self.download(remote, session: session) else { return false }
        return (try? data.write(to: fileURL(for: key(coverArt: coverArt, size: size)), options: .atomic)) != nil
    }

    private static func download(_ url: URL, session: URLSession) async -> Data? {
        guard let (data, response) = try? await session.data(from: url),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let mime = http.value(forHTTPHeaderField: "Content-Type"), mime.hasPrefix("image") else { return nil }
        return data
    }

    private static func decode(_ data: Data, maxPixels: Int) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    // MARK: Housekeeping

    var diskUsage: Int64 {
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Crate/Artwork")
        return Self.directorySize(root)
    }

    var fileCount: Int {
        (try? FileManager.default.contentsOfDirectory(atPath: directory.path).count) ?? 0
    }

    func clear() {
        memory.removeAllObjects()
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Crate/Artwork")
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    static func directorySize(_ url: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in enumerator {
            total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }
}

/// Fetches every album and artist cover after a sync, a few at a time, skipping covers
/// already on disk. After the first run only new albums cost a request.
@MainActor
@Observable
final class ArtworkPrefetcher {
    private(set) var total = 0
    private(set) var done = 0
    private(set) var isRunning = false
    @ObservationIgnored private var task: Task<Void, Never>?

    func start(coverArts: [String]) {
        task?.cancel()
        let unique = Array(NSOrderedSet(array: coverArts.filter { !$0.isEmpty })) as? [String] ?? []
        task = Task {
            isRunning = true
            defer { isRunning = false }
            let missing = await Task.detached(priority: .utility) {
                unique.filter { !ImageCache.shared.isOnDisk(coverArt: $0) }
            }.value
            total = unique.count
            done = unique.count - missing.count
            guard !missing.isEmpty else { return }
            await withTaskGroup(of: Void.self) { group in
                var iterator = missing.makeIterator()
                for _ in 0..<4 {
                    guard let next = iterator.next() else { break }
                    group.addTask(priority: .utility) { _ = await ImageCache.shared.prefetch(coverArt: next) }
                }
                while await group.next() != nil {
                    done += 1
                    if Task.isCancelled {
                        group.cancelAll()
                        break
                    }
                    if let next = iterator.next() {
                        group.addTask(priority: .utility) { _ = await ImageCache.shared.prefetch(coverArt: next) }
                    }
                }
            }
        }
    }

    func cancel() {
        task?.cancel()
        isRunning = false
    }
}
