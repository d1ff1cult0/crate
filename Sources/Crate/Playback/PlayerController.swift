import AppKit
import AVFoundation
import MediaPlayer
import Observation
import os

private let log = Logger(subsystem: "com.jplessers.crate", category: "player")

struct QueueItem: Identifiable, Hashable, Codable, Sendable {
    var id = UUID()
    var track: Track
    var fromAutoplay = false
}

enum RepeatMode: String, Codable {
    case off, all, one
}

/// The playback position lives in its own object so that only the progress bar redraws
/// four times a second, not every view that reads the player.
@MainActor
@Observable
final class PlaybackClock {
    var time: Double = 0
}

@MainActor
@Observable
final class PlayerController {
    enum Status: Equatable {
        case idle, loading, fetching(String), playing, paused, failed(String)
    }

    private(set) var queue: [QueueItem] = []
    private(set) var index: Int?
    private(set) var status: Status = .idle
    private(set) var isPlaying = false
    private(set) var duration: Double = 0
    private(set) var shuffle = false
    private(set) var repeatMode: RepeatMode = .off
    private(set) var isExtendingAutoplay = false
    /// Shown above "Up next" when the queue was started as a radio.
    private(set) var radioName: String?
    /// What the queue was started from ("playlist:<id>", "album:<id>", "mix:<id>"), for
    /// now-playing indicators on those pages.
    private(set) var context: String?
    let clock = PlaybackClock()

    var volume: Double = 0.8 {
        didSet {
            player.volume = Float(volume * volume)
            settings?.volume = volume
        }
    }

    /// The exact playback position, for lyrics (the clock only ticks four times a second).
    func preciseTime() -> Double {
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? seconds : clock.time
    }

    var current: QueueItem? {
        guard let index, queue.indices.contains(index) else { return nil }
        return queue[index]
    }

    var upcoming: ArraySlice<QueueItem> {
        guard let index, index + 1 < queue.count else { return [] }
        return queue[(index + 1)...]
    }

    var history: ArraySlice<QueueItem> {
        guard let index, index > 0 else { return [] }
        return queue[..<index]
    }

    @ObservationIgnored private let player = AVQueuePlayer()
    @ObservationIgnored private var avItemQueueIds: [ObjectIdentifier: UUID] = [:]
    @ObservationIgnored private var currentAVItem: ObjectIdentifier?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var itemObservations: [ObjectIdentifier: NSKeyValueObservation] = [:]
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var loadToken = 0
    @ObservationIgnored private var originalOrder: [QueueItem]?
    @ObservationIgnored private var transcodeRetried: Set<UUID> = []
    @ObservationIgnored private var playedHistory: [Track] = []

    // Listening accounting for scrobbles, skip detection and autoplay feedback.
    @ObservationIgnored private var startedAt: Date?
    @ObservationIgnored private var listened: Double = 0
    @ObservationIgnored private var lastTick: Double?
    @ObservationIgnored private var scrobbled = false
    @ObservationIgnored private var nowPlayingSent = false
    @ObservationIgnored private var persistTask: Task<Void, Never>?

    @ObservationIgnored private weak var library: LibraryStore?
    @ObservationIgnored private weak var downloads: DownloadManager?
    @ObservationIgnored private weak var fetcher: RemoteFetcher?
    @ObservationIgnored private weak var settings: SettingsStore?
    @ObservationIgnored private var autoplay: AutoplayEngine?
    @ObservationIgnored var isOffline: () -> Bool = { false }
    @ObservationIgnored var onNotice: ((String) -> Void)?
    @ObservationIgnored private let listenBrainz = ListenBrainzService()

    init() {
        player.actionAtItemEnd = .advance
        player.automaticallyWaitsToMinimizeStalling = true
        observations.append(player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.currentItemChanged() }
        })
        observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.timeControlChanged() }
        })
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time.seconds) }
        }
        NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            guard let item = note.object as? AVPlayerItem else { return }
            let id = ObjectIdentifier(item)
            MainActor.assumeIsolated { self?.itemFinished(id) }
        }
        NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            guard let item = note.object as? AVPlayerItem else { return }
            let id = ObjectIdentifier(item)
            MainActor.assumeIsolated { self?.itemFailed(id) }
        }
        setupRemoteCommands()
    }

    func configure(library: LibraryStore, downloads: DownloadManager, fetcher: RemoteFetcher, settings: SettingsStore, autoplay: AutoplayEngine) {
        self.library = library
        self.downloads = downloads
        self.fetcher = fetcher
        self.settings = settings
        self.autoplay = autoplay
        volume = settings.volume
        player.volume = Float(volume * volume)
    }

    // MARK: Starting playback

    /// Replaces the queue. `startAt` is the song the user picked; with shuffle on, it plays
    /// first and the rest is shuffled. `shuffled: nil` keeps the current shuffle setting.
    func play(_ tracks: [Track], startAt start: Int? = nil, shuffled: Bool? = nil, radio: String? = nil, context: String? = nil) {
        guard !tracks.isEmpty else { return }
        let shuffleOn = shuffled ?? shuffle
        var items = tracks.map { QueueItem(track: $0) }
        var startIndex = min(max(start ?? 0, 0), items.count - 1)
        originalOrder = nil
        if shuffleOn {
            originalOrder = items
            if let start {
                let first = items.remove(at: min(max(start, 0), items.count - 1))
                items.shuffle()
                items.insert(first, at: 0)
            } else {
                items.shuffle()
            }
            startIndex = 0
        }
        shuffle = shuffleOn
        radioName = radio
        self.context = context
        queue = items
        transcodeRetried = []
        startItem(at: startIndex, play: true)
        schedulePersist()
    }

    /// Starts an endless station from a seed: the first batch comes from autoplay, and
    /// autoplay keeps it going.
    func startRadio(_ seed: AutoplayEngine.Seed, name: String, leading: [Track] = []) {
        guard let autoplay else { return }
        onNotice?("Starting \(name) radio…")
        Task {
            let picks = await autoplay.pick(seed: seed, context: leading, count: 12, isAvailable: availability)
            let tracks = leading + picks
            guard !tracks.isEmpty else {
                onNotice?("Couldn't find anything to play for \(name).")
                return
            }
            play(tracks, radio: name)
            for i in leading.count..<queue.count { queue[i].fromAutoplay = true }
        }
    }

    func playNext(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        let items = tracks.map { QueueItem(track: $0) }
        guard let index else {
            play(tracks)
            return
        }
        queue.insert(contentsOf: items, at: index + 1)
        originalOrder?.append(contentsOf: items)
        refreshPreload()
        schedulePersist()
        onNotice?(tracks.count == 1 ? "“\(tracks[0].title)” plays next." : "\(tracks.count) songs play next.")
    }

    func addToQueue(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        guard index != nil else {
            play(tracks)
            return
        }
        let items = tracks.map { QueueItem(track: $0) }
        // Queued songs go before autoplay picks; those only fill in after your choices.
        let current = index ?? -1
        let insertAt = queue.indices.first { $0 > current && queue[$0].fromAutoplay } ?? queue.count
        queue.insert(contentsOf: items, at: insertAt)
        originalOrder?.append(contentsOf: items)
        refreshPreload()
        schedulePersist()
        onNotice?(tracks.count == 1 ? "Added “\(tracks[0].title)” to the queue." : "Added \(tracks.count) songs to the queue.")
    }

    // MARK: Transport

    func togglePlayPause() {
        if current == nil {
            if !queue.isEmpty { startItem(at: 0, play: true) }
            return
        }
        isPlaying ? pause() : resume()
    }

    func resume() {
        guard current != nil else { return }
        if player.currentItem == nil, let index {
            startItem(at: index, play: true, seek: clock.time)
            return
        }
        isPlaying = true
        player.play()
        updateNowPlaying()
    }

    func pause() {
        log.info("pause at \(self.clock.time)")
        isPlaying = false
        player.pause()
        if case .playing = status { status = .paused }
        updateNowPlaying()
        schedulePersist()
    }

    func next() {
        guard let index else { return }
        if let next = nextIndex(after: index, automatic: false) {
            startItem(at: next, play: true)
        } else if settings?.autoplay == true {
            Task {
                await extendAutoplay(force: true)
                if let next = nextIndex(after: index, automatic: false) { startItem(at: next, play: true) }
            }
        }
    }

    func previous() {
        guard let index else { return }
        if clock.time > 3 || index == 0 {
            seek(to: 0)
        } else {
            startItem(at: index - 1, play: true)
        }
    }

    func seek(to seconds: Double) {
        let target = max(0, min(seconds, duration > 0 ? duration - 0.5 : seconds))
        clock.time = target
        lastTick = nil
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        updateNowPlaying()
    }

    func jump(to itemId: UUID) {
        guard let target = queue.firstIndex(where: { $0.id == itemId }) else { return }
        startItem(at: target, play: true)
    }

    func toggleShuffle() {
        guard let index else {
            shuffle.toggle()
            return
        }
        if shuffle {
            // Back to the original order, keeping the current song playing.
            if let original = originalOrder {
                let present = Set(queue.map(\.id))
                var restored = original.filter { present.contains($0.id) }
                let added = queue.filter { item in !restored.contains { $0.id == item.id } }
                restored += added
                let currentId = queue[index].id
                queue = restored
                self.index = queue.firstIndex { $0.id == currentId }
            }
            originalOrder = nil
            shuffle = false
        } else {
            originalOrder = queue
            let head = Array(queue[...index])
            let rest = queue[(index + 1)...].filter { !$0.fromAutoplay }.shuffled()
            let auto = queue[(index + 1)...].filter(\.fromAutoplay)
            queue = head + rest + auto
            shuffle = true
        }
        refreshPreload()
        schedulePersist()
    }

    func cycleRepeat() {
        switch repeatMode {
        case .off: repeatMode = .all
        case .all: repeatMode = .one
        case .one: repeatMode = .off
        }
        refreshPreload()
    }

    // MARK: Queue editing

    func remove(_ itemId: UUID) {
        guard let target = queue.firstIndex(where: { $0.id == itemId }) else { return }
        originalOrder?.removeAll { $0.id == itemId }
        if target == index {
            queue.remove(at: target)
            if queue.indices.contains(target) {
                startItem(at: target, play: isPlaying)
            } else {
                index = queue.isEmpty ? nil : queue.count - 1
                stopAtEnd()
            }
            schedulePersist()
            return
        }
        queue.remove(at: target)
        if let i = index, target < i { index = i - 1 }
        refreshPreload()
        schedulePersist()
    }

    /// Moves within "Up next" (offsets relative to the upcoming slice).
    func moveUpcoming(fromOffsets source: IndexSet, toOffset destination: Int) {
        guard let index else { return }
        var upcoming = Array(queue[(index + 1)...])
        upcoming.move(fromOffsets: source, toOffset: destination)
        queue = Array(queue[...index]) + upcoming
        refreshPreload()
        schedulePersist()
    }

    func clearUpcoming() {
        guard let index else {
            queue = []
            return
        }
        queue = Array(queue[...index])
        originalOrder = nil
        radioName = nil
        refreshPreload()
        schedulePersist()
    }

    func clearHistory() {
        guard let index, index > 0 else { return }
        queue.removeFirst(index)
        self.index = 0
        schedulePersist()
    }

    // MARK: Loading

    private func availability(_ track: Track) -> Bool {
        if !isOffline() { return true }
        return downloads?.localURL(for: track.id) != nil || (track.isExternal && fetcher?.cachedFile(for: track.id) != nil)
    }

    private func startItem(at newIndex: Int, play: Bool, seek: Double? = nil) {
        guard queue.indices.contains(newIndex) else { return }
        finishAccounting()
        loadToken += 1
        let token = loadToken
        index = newIndex
        let item = queue[newIndex]
        log.info("start \(item.track.title, privacy: .public) [\(item.track.id, privacy: .public)] play=\(play)")
        duration = Double(item.track.duration)
        clock.time = seek ?? 0
        isPlaying = play
        status = .loading
        player.pause()
        player.removeAllItems()
        avItemQueueIds.removeAll()
        itemObservations.removeAll()
        currentAVItem = nil
        beginAccounting(item)
        updateNowPlaying()
        schedulePersist()

        Task {
            do {
                let url = try await resolveURL(for: item, foreground: true)
                guard token == loadToken else { return }
                let avItem = makeItem(url: url, for: item)
                currentAVItem = ObjectIdentifier(avItem)
                player.insert(avItem, after: nil)
                if let seek, seek > 0 {
                    await avItem.seek(to: CMTime(seconds: seek, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                }
                guard token == loadToken else { return }
                if isPlaying { player.play() } else { status = .paused }
                afterItemStarted()
            } catch {
                guard token == loadToken else { return }
                handleFailure(of: item, error: error)
            }
        }
    }

    private func resolveURL(for item: QueueItem, foreground: Bool) async throws -> URL {
        let track = item.track
        if let local = downloads?.localURL(for: track.id) { return local }
        guard let client = library?.client else { throw CrateError.notConnected }
        if track.isExternal {
            if let mapped = library?.db?.localId(forExternal: track.id), !isOffline() {
                return streamURL(client: client, id: mapped, item: item)
            }
            if let cached = fetcher?.cachedFile(for: track.id) { return cached }
            if isOffline() { throw CrateError.offline }
            if foreground { status = .fetching(track.provider ?? "provider") }
            guard let fetcher else { throw CrateError.notConnected }
            return try await fetcher.fetch(track)
        }
        if isOffline() { throw CrateError.offline }
        return streamURL(client: client, id: track.id, item: item)
    }

    private func streamURL(client: SubsonicClient, id: String, item: QueueItem) -> URL {
        let quality = settings?.streamQuality ?? .original
        if transcodeRetried.contains(item.id) {
            return client.streamURL(id: id, format: "mp3", maxBitRate: 320)
        }
        if quality == .original { return client.streamURL(id: id) }
        return client.streamURL(id: id, format: "mp3", maxBitRate: quality.rawValue)
    }

    private func makeItem(url: URL, for item: QueueItem) -> AVPlayerItem {
        let asset = AVURLAsset(url: url)
        let avItem = AVPlayerItem(asset: asset)
        avItem.preferredForwardBufferDuration = 30
        let id = ObjectIdentifier(avItem)
        avItemQueueIds[id] = item.id
        itemObservations[id] = avItem.observe(\.status, options: [.new]) { [weak self] observed, _ in
            let status = observed.status
            let duration = observed.duration.seconds
            Task { @MainActor in
                guard let self else { return }
                if status == .failed {
                    self.itemFailed(id)
                } else if status == .readyToPlay, self.currentAVItem == id, duration.isFinite, duration > 0 {
                    self.duration = duration
                    self.updateNowPlaying()
                }
            }
        }
        return avItem
    }

    private func handleFailure(of item: QueueItem, error: Error) {
        log.error("failed \(item.track.title, privacy: .public): \(error.localizedDescription, privacy: .public)")
        let message: String
        if case CrateError.offline = error {
            message = "“\(item.track.title)” isn't downloaded, so it can't play offline."
        } else if item.track.isExternal {
            message = "octo-fiesta couldn't fetch “\(item.track.title)” from \(item.track.provider ?? "the provider")."
        } else {
            message = "Couldn't play “\(item.track.title)”. \(error.localizedDescription)"
        }
        status = .failed(message)
        onNotice?(message + " Skipping.")
        let token = loadToken
        Task {
            try? await Task.sleep(for: .seconds(1.2))
            guard token == loadToken, let index, queue.indices.contains(index), queue[index].id == item.id else { return }
            if let next = nextIndex(after: index, automatic: false), next != index {
                startItem(at: next, play: isPlaying)
            } else {
                isPlaying = false
            }
        }
    }

    private func itemFailed(_ id: ObjectIdentifier) {
        guard let queueId = avItemQueueIds[id], let item = queue.first(where: { $0.id == queueId }) else { return }
        if id == currentAVItem {
            // A format AVFoundation can't decode: ask the server for MP3 once.
            if !item.track.isExternal, downloads?.localURL(for: item.track.id) == nil, !transcodeRetried.contains(item.id),
               let index = queue.firstIndex(where: { $0.id == queueId }) {
                transcodeRetried.insert(item.id)
                startItem(at: index, play: isPlaying, seek: clock.time)
                return
            }
            handleFailure(of: item, error: CrateError.invalidResponse)
        } else {
            // A preloaded item failed; drop it and let the normal path try again later.
            if let avItem = player.items().first(where: { ObjectIdentifier($0) == id }) {
                player.remove(avItem)
            }
        }
    }

    /// Gapless: the next song is decoded into AVQueuePlayer while this one plays.
    private func afterItemStarted() {
        guard let index else { return }
        if settings?.prefetchExternal != false {
            fetcher?.prefetch(Array(queue.dropFirst(index + 1).prefix(3).map(\.track)))
        }
        if settings?.autoplay == true, repeatMode == .off, index >= queue.count - 2 {
            Task { await extendAutoplay() }
        }
        refreshPreload()
    }

    private func refreshPreload() {
        guard let index, let currentItem = player.currentItem else { return }
        for extra in player.items() where extra !== currentItem {
            avItemQueueIds[ObjectIdentifier(extra)] = nil
            itemObservations[ObjectIdentifier(extra)] = nil
            player.remove(extra)
        }
        guard let nextIdx = nextIndex(after: index, automatic: true) else { return }
        let next = queue[nextIdx]
        let token = loadToken
        // External songs preload only when already fetched; otherwise they're fetched in
        // the background and picked up when this song ends.
        if next.track.isExternal, downloads?.localURL(for: next.track.id) == nil, library?.db?.localId(forExternal: next.track.id) == nil,
           fetcher?.cachedFile(for: next.track.id) == nil {
            if settings?.prefetchExternal != false { fetcher?.prefetch([next.track]) }
            return
        }
        Task {
            guard let url = try? await resolveURL(for: next, foreground: false) else { return }
            guard token == loadToken, self.index == index, player.currentItem === currentItem,
                  nextIndex(after: index, automatic: true) == nextIdx, queue.indices.contains(nextIdx), queue[nextIdx].id == next.id,
                  player.items().count == 1 else { return }
            let avItem = makeItem(url: url, for: next)
            if player.canInsert(avItem, after: currentItem) {
                player.insert(avItem, after: currentItem)
            }
        }
    }

    private func nextIndex(after i: Int, automatic: Bool) -> Int? {
        if automatic, repeatMode == .one { return i }
        if i + 1 < queue.count { return i + 1 }
        if repeatMode == .all, !queue.isEmpty { return 0 }
        return nil
    }

    private func currentItemChanged() {
        guard let avItem = player.currentItem else { return }
        let id = ObjectIdentifier(avItem)
        guard id != currentAVItem, let queueId = avItemQueueIds[id], let newIndex = queue.firstIndex(where: { $0.id == queueId }) else { return }
        // AVQueuePlayer moved on to the preloaded song by itself.
        log.info("advanced gaplessly to \(self.queue[newIndex].track.title, privacy: .public)")
        finishAccounting()
        currentAVItem = id
        index = newIndex
        duration = Double(queue[newIndex].track.duration)
        if avItem.duration.seconds.isFinite, avItem.duration.seconds > 0 { duration = avItem.duration.seconds }
        clock.time = 0
        lastTick = nil
        beginAccounting(queue[newIndex])
        updateNowPlaying()
        afterItemStarted()
        schedulePersist()
    }

    private func itemFinished(_ id: ObjectIdentifier) {
        guard id == currentAVItem, let index else { return }
        // Something is queued in AVQueuePlayer: it advances on its own.
        if player.items().count > 1 { return }
        if let next = nextIndex(after: index, automatic: true) {
            startItem(at: next, play: true)
            return
        }
        guard settings?.autoplay == true else {
            stopAtEnd()
            return
        }
        Task {
            await extendAutoplay(force: true)
            if let next = nextIndex(after: index, automatic: true) {
                startItem(at: next, play: true)
            } else {
                stopAtEnd()
            }
        }
    }

    private func stopAtEnd() {
        finishAccounting()
        isPlaying = false
        status = .paused
        clock.time = 0
        player.removeAllItems()
        currentAVItem = nil
        updateNowPlaying()
    }

    private func extendAutoplay(force: Bool = false) async {
        guard let autoplay, !isExtendingAutoplay, let index else { return }
        guard force || index >= queue.count - 2 else { return }
        isExtendingAutoplay = true
        defer { isExtendingAutoplay = false }
        let context = playedHistory.suffix(40) + queue.map(\.track)
        let recent = Array(playedHistory.suffix(5)) + [queue[index].track] + queue[(index + 1)...].map(\.track)
        let picks = await autoplay.pick(seed: .recent(Array(recent.suffix(6))), context: Array(context), count: 10, isAvailable: availability)
        guard !picks.isEmpty else { return }
        queue.append(contentsOf: picks.map { QueueItem(track: $0, fromAutoplay: true) })
        refreshPreload()
        if settings?.prefetchExternal != false, let i = self.index {
            fetcher?.prefetch(Array(queue.dropFirst(i + 1).prefix(3).map(\.track)))
        }
        schedulePersist()
    }

    private func timeControlChanged() {
        log.debug("timeControl \(self.player.timeControlStatus.rawValue) reason \(self.player.reasonForWaitingToPlay?.rawValue ?? "-", privacy: .public)")
        switch player.timeControlStatus {
        case .playing:
            status = .playing
            isPlaying = true
        case .paused:
            if case .loading = status, isPlaying { return }
            if case .fetching = status { return }
            if player.currentItem != nil { status = .paused }
        case .waitingToPlayAtSpecifiedRate:
            if case .fetching = status { return }
            status = .loading
        @unknown default:
            break
        }
        updateNowPlaying()
    }

    // MARK: Accounting

    private func tick(_ seconds: Double) {
        guard seconds.isFinite, player.currentItem != nil, ObjectIdentifier(player.currentItem!) == currentAVItem else { return }
        if abs(clock.time - seconds) >= 0.2 { clock.time = seconds }
        if let lastTick, isPlaying {
            let delta = seconds - lastTick
            if delta > 0, delta < 1.5 { listened += delta }
        }
        lastTick = seconds
        guard let item = current, !scrobbled else { return }
        let length = duration > 0 ? duration : Double(item.track.duration)
        if length > 30, listened >= min(240, length * 0.5) {
            scrobbled = true
            if settings?.scrobble != false {
                library?.scrobble(item.track, at: startedAt ?? Date(), submission: true)
            }
            if settings?.listenBrainzScrobble == true, let token = settings?.listenBrainzToken, !token.isEmpty {
                let started = startedAt ?? Date()
                Task { await listenBrainz.submit(track: item.track, listenedAt: started, token: token) }
            }
        }
        if !nowPlayingSent, listened > 2 {
            nowPlayingSent = true
            if settings?.scrobble != false {
                library?.scrobble(item.track, at: Date(), submission: false)
            }
            if settings?.listenBrainzScrobble == true, let token = settings?.listenBrainzToken, !token.isEmpty {
                Task { await listenBrainz.submit(track: item.track, listenedAt: nil, token: token) }
            }
        }
    }

    private func beginAccounting(_ item: QueueItem) {
        startedAt = Date()
        listened = 0
        lastTick = nil
        scrobbled = false
        nowPlayingSent = false
        playedHistory.append(item.track)
        if playedHistory.count > 80 { playedHistory.removeFirst(playedHistory.count - 80) }
    }

    private func finishAccounting() {
        guard let item = current, let startedAt, listened > 1 else { return }
        let length = duration > 0 ? duration : Double(item.track.duration)
        let skipped = !scrobbled && listened < min(30, length * 0.5)
        library?.db?.addPlay(PlayRecord(songId: item.track.id, artist: item.track.artist, playedAt: startedAt,
                                        listened: listened, skipped: skipped, autoplay: item.fromAutoplay))
        autoplay?.feedback(item.track, skipped: skipped, fromAutoplay: item.fromAutoplay)
        self.startedAt = nil
    }

    // MARK: Now Playing & media keys

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.togglePlayPause() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.previous() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            MainActor.assumeIsolated { self?.seek(to: position) }
            return .success
        }
    }

    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard let track = current?.track else {
            center.nowPlayingInfo = nil
            center.playbackState = .stopped
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPMediaItemPropertyAlbumTitle: track.album,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: clock.time,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying && status == .playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        let cover = library?.cover(for: track)
        if let image = ImageCache.shared.memoryImage(coverArt: cover, url: track.artworkURL, points: 200) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        } else {
            let id = track.id
            Task {
                if let _ = await ImageCache.shared.image(coverArt: cover, url: track.artworkURL, points: 200), current?.track.id == id {
                    updateNowPlaying()
                }
            }
        }
        center.nowPlayingInfo = info
        center.playbackState = isPlaying ? .playing : .paused
    }

    // MARK: Persistence

    private struct Snapshot: Codable {
        var queue: [QueueItem]
        var index: Int?
        var position: Double
        var shuffle: Bool
        var repeatMode: RepeatMode
        var radioName: String?
    }

    @ObservationIgnored var persistenceURL: URL?

    private func schedulePersist() {
        persistTask?.cancel()
        persistTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            persistNow()
        }
    }

    func persistNow() {
        guard let persistenceURL else { return }
        let snapshot = Snapshot(queue: Array(queue.suffix(500)), index: index.map { $0 - max(0, queue.count - 500) },
                                position: clock.time, shuffle: shuffle, repeatMode: repeatMode, radioName: radioName)
        if let data = try? JSONEncoder().encode(snapshot) {
            try? FileManager.default.createDirectory(at: persistenceURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: persistenceURL, options: .atomic)
        }
    }

    func restore() {
        guard let persistenceURL, let data = try? Data(contentsOf: persistenceURL),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data), !snapshot.queue.isEmpty else { return }
        queue = snapshot.queue
        index = snapshot.index.flatMap { queue.indices.contains($0) ? $0 : nil }
        shuffle = snapshot.shuffle
        repeatMode = snapshot.repeatMode
        radioName = snapshot.radioName
        clock.time = snapshot.position
        if let current {
            duration = Double(current.track.duration)
            status = .paused
        }
        updateNowPlaying()
    }

    func reset() {
        loadToken += 1
        player.removeAllItems()
        queue = []
        index = nil
        isPlaying = false
        status = .idle
        clock.time = 0
        playedHistory = []
        updateNowPlaying()
        if let persistenceURL { try? FileManager.default.removeItem(at: persistenceURL) }
    }
}
