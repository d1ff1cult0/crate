// No `import Foundation`: it pulls in the _Testing_Foundation overlay, whose module layout is broken in the Command Line Tools. Foundation types come through Crate.
import Testing
@testable import Crate

@Suite("octo-fiesta ids")
struct OctoIDTests {
    @Test func recognisesExternalItems() {
        #expect(OctoID.isExternal("ext-deezer-song-71428557"))
        #expect(!OctoID.isExternal("gwGX2fFIq0AgqmyAZd5tnu"))
        #expect(OctoID.type("ext-deezer-album-7014335") == "album")
        #expect(OctoID.type("ext-deezer-123") == "song")
        #expect(OctoID.providerName("ext-qobuz-song-1") == "Qobuz")
    }

    @Test func externalPlaylistsAreNotLocalCoverIds() {
        #expect(OctoID.isExternalPlaylist("pl-deezer-3012211882"))
        // Navidrome's own playlist cover art ids also start with "pl-".
        #expect(!OctoID.isExternalPlaylist("pl-ICjHk56stq5VJov9FogYyo_6adba308"))
    }
}

@Suite("matching keys")
struct TextKeyTests {
    @Test func titleDropsFeaturesAndRemasterNotes() {
        #expect(TextKey.title("Get Lucky (feat. Pharrell Williams and Nile Rodgers)") == "get lucky")
        #expect(TextKey.title("Instant Crush") == "instant crush")
        #expect(TextKey.title("Heroes - 2017 Remaster") == "heroes")
        #expect(TextKey.title("Song [Remastered 2011]") == "song")
        // Remixes and live versions are different recordings.
        #expect(TextKey.title("Papaoutai (Liam Summers Remix)") != TextKey.title("Papaoutai"))
    }

    @Test func foldsAccentsAndPunctuation() {
        #expect(TextKey.fold("Beyoncé") == "beyonce")
        #expect(TextKey.fold("Guns N' Roses") == "guns n roses")
        #expect(TextKey.fold("Simon & Garfunkel") == "simon and garfunkel")
    }

    @Test func artistCreditsOverlap() {
        #expect(TextKey.artistsOverlap("Daft Punk feat. Pharrell Williams", "Daft Punk"))
        #expect(TextKey.artistsOverlap("Röyksopp & Alison Goldfrapp", "Royksopp"))
        #expect(!TextKey.artistsOverlap("Daft Punk", "Justice"))
        #expect(TextKey.primaryCredit("Paul Kalkbrenner & Stromae") == "Paul Kalkbrenner")
    }

    @Test func songKeyIgnoresAlbumVersions() {
        #expect(TextKey.songKey(title: "One More Time", artist: "Daft Punk")
            == TextKey.songKey(title: "One More Time (Radio Edit)", artist: "Daft Punk"))
    }
}

@Suite("formatting")
struct FormatTests {
    @Test func parsesSubsonicDates() {
        let nanos = Format.parseDate("2026-09-25T13:48:01.639763258Z")
        let plain = Format.parseDate("2026-09-25T13:48:01Z")
        #expect(nanos != nil)
        #expect(nanos == plain)
        #expect(Format.parseDate("2013-10-28T00:00:00.0000000Z") != nil)
        #expect(Format.parseDate("2026-10-24T22:08:58.278725+00:00") != nil)
        #expect(Format.parseDate("") == nil)
    }

    @Test func durations() {
        #expect(Format.duration(212) == "3:32")
        #expect(Format.duration(3725) == "1:02:05")
        #expect(Format.longDuration(45584) == "12 h 39 min")
    }
}

@Suite("lyrics")
struct LyricsTests {
    @Test func parsesLRCWithRepeatedTimestamps() {
        let lrc = """
        [ar:Stromae]
        [00:12.50]Dites-moi d'où il vient
        [00:15.00][01:15.00]Papa où t'es ?
        """
        let lines = LRCLib.parseLRC(lrc) ?? []
        #expect(lines.count == 3)
        #expect(lines.first?.start == 12.5)
        #expect(lines.last?.start == 75)
        #expect(lines.last?.text == "Papa où t'es ?")
    }
}

@Suite("autoplay")
struct AutoplayTests {
    private func track(_ id: String, _ artist: String) -> Track {
        Track(id: id, title: id, artist: artist, album: "", duration: 200, starred: false, rating: 0, playCount: 0)
    }

    @Test func keepsArtistsApart() {
        let input = [track("a1", "A"), track("a2", "A"), track("a3", "A"), track("b1", "B"), track("c1", "C"), track("b2", "B")]
        let picked = AutoplayEngine.diversify(input, count: 5, recentArtists: [])
        for (left, right) in zip(picked, picked.dropFirst()) {
            #expect(left.artist != right.artist)
        }
        #expect(picked.filter { $0.artist == "A" }.count <= 2)
    }

    @Test func avoidsTheArtistThatJustPlayed() {
        let picked = AutoplayEngine.diversify([track("a1", "A"), track("b1", "B")], count: 1, recentArtists: ["a"])
        #expect(picked.first?.artist == "B")
    }
}

@Suite("decoding")
struct DecodingTests {
    @Test func decodesMergedOctoFiestaSearch() throws {
        let json = """
        {"subsonic-response":{"status":"ok","version":"1.16.1","searchResult3":{
          "song":[
            {"id":"tvOC1fUykUqmTZzik68QXt","title":"Papaoutai","artist":"Stromae","album":"racine carrée","duration":232,"suffix":"mp3","created":"2026-09-25T13:48:01.639763258Z","isExternal":false},
            {"id":"ext-deezer-song-71428557","title":"papaoutai (Extended)","artist":"Stromae","duration":"379","suffix":"Remote","isExternal":true}
          ],
          "album":[{"id":"pl-deezer-3012211882","name":"Stromae playlist","artist":"🎵 Deezer flower","duration":0}]
        }}}
        """
        let payload = try SubsonicClient.decodePayload(WireSearch.self, key: "searchResult3", from: json)
        let results = try #require(payload.value?.results)
        #expect(results.songs.count == 2)
        #expect(results.songs[1].isExternal)
        #expect(results.songs[1].duration == 379)
        #expect(results.songs[1].provider == "Deezer")
        #expect(results.albums.first?.isExternalPlaylist == true)
    }

    @Test func surfacesServerErrors() throws {
        let json = #"{"subsonic-response":{"status":"failed","error":{"code":40,"message":"Wrong username or password"}}}"#
        let payload = try SubsonicClient.decodePayload(Empty.self, key: "", from: json)
        #expect(payload.status == "failed")
        #expect(payload.error?.code == 40)
    }
}
