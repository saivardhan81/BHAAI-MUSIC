import json
import unittest
from unittest.mock import Mock, patch

import playlist_sources as sources
from youtube_bridge import normalize_track


def spotify_html(entity):
    data = {"props": {"pageProps": {"state": {"data": {"entity": entity}}}}}
    return '<html><script id="__NEXT_DATA__" type="application/json">%s</script></html>' % json.dumps(data)


def apple_html(sections):
    data = {"data": [{"data": {"sections": sections}}]}
    return '<script type="application/json" id="serialized-server-data">%s</script>' % json.dumps(data)


class DetectTests(unittest.TestCase):
    def test_spotify_links(self):
        self.assertEqual(sources.detect("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc")[:3], ("spotify", "playlist", "37i9dQZF1DXcBWIGoYBM5M"))
        self.assertEqual(sources.detect("open.spotify.com/intl-en/album/4aawyAB9vmqN3uQ7FjRGTy")[:3], ("spotify", "album", "4aawyAB9vmqN3uQ7FjRGTy"))
        self.assertEqual(sources.detect("spotify:track:4cOdK2wGLETKBW3PvgPWqT")[:3], ("spotify", "track", "4cOdK2wGLETKBW3PvgPWqT"))
        self.assertEqual(sources.detect("https://spotify.link/AbCdEf")[:2], ("spotify", "short"))
        with self.assertRaises(sources.SourceError):
            sources.detect("https://open.spotify.com/user/someone")

    def test_apple_links(self):
        self.assertEqual(sources.detect("https://music.apple.com/in/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"),
                         ("apple", "playlist", "pl.f4d106fed2bd41149aaacabb233eb5eb", "in"))
        self.assertEqual(sources.detect("https://music.apple.com/us/playlist/road-trip/pl.u-abcdEFGH1234"),
                         ("apple", "playlist", "pl.u-abcdEFGH1234", "us"))
        found = sources.detect("https://music.apple.com/us/album/been-by-now/6792676858?i=6792676860")
        self.assertEqual(found[:3], ("apple", "album", "6792676858"))
        self.assertEqual(found[3], {"storefront": "us", "song": "6792676860"})
        with self.assertRaises(sources.SourceError):
            sources.detect("https://music.apple.com/us/artist/someone/123")

    def test_other_links_are_left_to_youtube(self):
        self.assertIsNone(sources.detect("https://music.youtube.com/playlist?list=PLabcdefghijk123"))
        self.assertIsNone(sources.detect("PLabcdefghijk123"))


class ParseTests(unittest.TestCase):
    def test_spotify_playlist(self):
        info = sources.parse_spotify_embed(spotify_html({
            "type": "playlist", "name": "Road trip", "subtitle": "Sai", "coverArt": {"sources": [{"url": "https://i.scdn.co/image/x"}]},
            "trackList": [{"title": "Song A", "subtitle": "Artist 1, Artist 2", "duration": 200500},
                          {"title": "Gone", "subtitle": "X", "duration": 1000, "isPlayable": False}]}))
        self.assertEqual(info["title"], "Road trip")
        self.assertEqual(info["art"], "https://i.scdn.co/image/x")
        self.assertEqual(info["songs"], [{"title": "Song A", "artists": ["Artist 1", "Artist 2"], "duration": 200.5}])

    def test_spotify_track(self):
        info = sources.parse_spotify_embed(spotify_html({"type": "track", "title": "One", "artists": [{"name": "A"}], "duration": 180000}))
        self.assertEqual(info["songs"], [{"title": "One", "artists": ["A"], "duration": 180.0}])

    def test_apple_playlist_and_single_song(self):
        sections = [
            {"itemKind": "containerDetailHeaderLockup", "items": [{"title": "Today’s Hits", "subtitleLinks": [{"title": "Apple Music Hits"}],
                                                                   "artwork": {"dictionary": {"url": "https://is1-ssl.mzstatic.com/a/{w}x{h}bb.{f}"}}}]},
            {"itemKind": "trackLockup", "items": [
                {"id": "track-lockup - pl.x - 111", "title": "Kuch Mat Kar", "artistName": "Raga, Seedhe Maut & Hashbass", "duration": 225882},
                {"id": "track-lockup - pl.x - 222", "title": "Been By Now", "artistName": "Morgan Wallen", "duration": 213806}]},
            {"itemKind": "squareLockup", "items": [{"title": "Not a song"}]},
        ]
        info = sources.parse_apple_page(apple_html(sections))
        self.assertEqual(info["title"], "Today’s Hits")
        self.assertEqual(info["art"], "https://is1-ssl.mzstatic.com/a/1200x1200bb.jpg")
        self.assertEqual([s["title"] for s in info["songs"]], ["Kuch Mat Kar", "Been By Now"])
        self.assertEqual(info["songs"][0]["artists"], ["Raga", "Seedhe Maut", "Hashbass"])
        single = sources.parse_apple_page(apple_html(sections), song_id="222")
        self.assertEqual(single["title"], "Been By Now")
        self.assertEqual(len(single["songs"]), 1)

    def test_unreadable_pages_raise_friendly_errors(self):
        with self.assertRaisesRegex(sources.SourceError, "Spotify"):
            sources.parse_spotify_embed("<html>nothing</html>")
        with self.assertRaisesRegex(sources.SourceError, "Apple Music"):
            sources.parse_apple_page('<script type="application/json" id="serialized-server-data">{not json</script>')


class MatchTests(unittest.TestCase):
    def row(self, video_id, title, artist, duration):
        return {"videoId": video_id, "title": title, "artists": [{"name": artist}], "duration_seconds": duration}

    def test_prefers_same_artist_and_length(self):
        client = Mock()
        client.search.return_value = [self.row("aaaaaaaaaaa", "Samajavaragamana (Cover)", "Someone Else", 250),
                                      self.row("bbbbbbbbbbb", "Samajavaragamana", "Sid Sriram", 221)]
        song = {"title": "Samajavaragamana (From \"Ala Vaikunthapurramuloo\")", "artists": ["Sid Sriram"], "duration": 220}
        self.assertEqual(sources.match_song(client, song, normalize_track)["id"], "bbbbbbbbbbb")
        client.search.assert_called_once_with("samajavaragamana Sid Sriram", filter="songs", limit=10)

    def test_language_suffix_and_spacing_do_not_block_a_match(self):
        client = Mock()
        client.search.return_value = [self.row("eeeeeeeeeee", "Butta Bomma", "Armaan Malik", 199)]
        song = {"title": "Buttabomma - Telugu", "artists": ["Armaan Malik", "Thaman S"], "duration": 198.8}
        self.assertEqual(sources.match_song(client, song, normalize_track)["id"], "eeeeeeeeeee")
        self.assertEqual(client.search.call_args_list[0].args[0], "buttabomma Armaan Malik Thaman S")

    def test_covers_and_title_only_matches_are_rejected(self):
        client = Mock()
        client.search.return_value = [
            self.row("fffffffffff", "Butta Bomma Ft. Armaan Malik (Dance Cover)", "TeamArmaalians", 88),
            self.row("ggggggggggg", "Butta Bomma", "Tajmeel Sherif", 165)]
        song = {"title": "Buttabomma - Telugu", "artists": ["Armaan Malik", "Thaman S"], "duration": 198.8}
        self.assertIsNone(sources.match_song(client, song, normalize_track))
        # both query variants (two artists, one artist) were tried on songs and videos
        self.assertEqual(len(client.search.call_args_list), 4)

    def test_rejects_poor_matches_after_trying_videos(self):
        client = Mock()
        client.search.return_value = [self.row("ccccccccccc", "Completely Different", "Nobody", 30)]
        self.assertIsNone(sources.match_song(client, {"title": "Kuch Mat Kar", "artists": ["Raga"], "duration": 225}, normalize_track))
        self.assertEqual([c.kwargs["filter"] for c in client.search.call_args_list], ["songs", "videos"])

    def test_import_reports_missing_songs(self):
        info = {"title": "Mix", "author": "", "art": "", "songs": [
            {"title": "Found", "artists": ["A"], "duration": 200, "art": "https://is1-ssl.mzstatic.com/x/1200x1200bb.jpg"},
            {"title": "Lost", "artists": ["B"], "duration": 100}]}
        client = Mock()
        client.search.side_effect = lambda query, filter, limit: [self.row("ddddddddddd", "Found", "A", 201)] if query.lower().startswith("found") else []
        with patch.object(sources, "fetch_source", return_value=("apple-pl.x", info)):
            result = sources.import_external(("apple", "playlist", "pl.x", "us"), lambda: client, normalize_track)
        self.assertEqual([t["id"] for t in result["tracks"]], ["ddddddddddd"])
        self.assertEqual(result["tracks"][0]["thumb"], "https://is1-ssl.mzstatic.com/x/240x240bb.jpg")
        self.assertEqual((result["missingCount"], result["missing"], result["source"]), (1, ["Lost"], "apple"))


if __name__ == "__main__":
    unittest.main()
