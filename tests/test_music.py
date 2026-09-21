import unittest
from unittest.mock import Mock, patch

import music
from music import import_playlist, load_playlist, normalize_track, playlist_id_from_link, search_tracks


class YouTubeMusicTests(unittest.TestCase):
    def test_normalizes_song_and_selects_largest_https_artwork(self):
        track = normalize_track({"videoId": "abcdefghijk", "title": "తెలుగు పాట", "artists": [{"name": "A"}, {"name": "B"}], "duration": "1:02:03", "thumbnails": [{"url": "https://example.com/small", "width": 50}, {"url": "https://example.com/large", "width": 500}, {"url": "javascript:alert(1)", "width": 1000}]})
        self.assertEqual(track["artist"], "A, B")
        self.assertEqual(track["duration"], 3723)
        self.assertEqual(track["art"], "https://example.com/large")
        self.assertNotIn("url", track)

    def test_artwork_is_upscaled_for_now_playing(self):
        track = normalize_track({"videoId": "abcdefghijk", "thumbnails": [{"url": "https://lh3.googleusercontent.com/x=w120-h120-l90-rj", "width": 120}]})
        self.assertEqual(track["art"], "https://lh3.googleusercontent.com/x=w1200-h1200-l90-rj")
        self.assertEqual(track["thumb"], "https://lh3.googleusercontent.com/x=w240-h240-l90-rj")

    def test_unavailable_and_invalid_ids_are_excluded(self):
        self.assertIsNone(normalize_track({"videoId": "abcdefghijk", "isAvailable": False}))
        self.assertIsNone(normalize_track({"videoId": "bad<script>"}))
        self.assertIsNone(normalize_track({"videoId": None}))

    def test_search_preserves_query_and_deduplicates(self):
        client = Mock()
        client.search.return_value = [{"videoId": "abcdefghijk", "title": "One"}, {"videoId": "abcdefghijk", "title": "Duplicate"}, {"title": "No ID"}]
        result = search_tracks(client, "  తెలుగు పాట  ")
        client.search.assert_called_once_with("తెలుగు పాట", filter="songs", limit=40)
        self.assertEqual(len(result["tracks"]), 1)
        self.assertEqual(result["excluded"], 2)

    def test_empty_query_does_not_contact_youtube(self):
        client = Mock()
        self.assertEqual(search_tracks(client, " ")["tracks"], [])
        client.search.assert_not_called()

    def test_bad_query_is_rejected(self):
        with self.assertRaises(ValueError):
            search_tracks(Mock(), "a" * 201)

    def test_playlist_links_are_parsed(self):
        self.assertEqual(playlist_id_from_link("https://music.youtube.com/playlist?list=PLabcdefghijk123&si=xyz"), "PLabcdefghijk123")
        self.assertEqual(playlist_id_from_link("https://www.youtube.com/watch?v=abcdefghijk&list=RDCLAK5uy_abcdefg"), "RDCLAK5uy_abcdefg")
        self.assertEqual(playlist_id_from_link("music.youtube.com/browse/VLPLabcdefghijk123?list=VLPLabcdefghijk123"), "PLabcdefghijk123")
        self.assertEqual(playlist_id_from_link("PLabcdefghijk123"), "PLabcdefghijk123")
        for bad in ["https://evil.example/playlist?list=PLabcdefghijk123", "https://www.youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/playlist?list=LL", "abcdefghijk"]:
            with self.assertRaises(ValueError):
                playlist_id_from_link(bad)

    def test_load_playlist_normalizes_tracks(self):
        client = Mock()
        client.get_playlist.return_value = {"title": "Road trip", "author": {"name": "Sai"}, "thumbnails": [], "tracks": [
            {"videoId": "abcdefghijk", "title": "One", "artists": [{"name": "A"}]},
            {"videoId": "abcdefghijk", "title": "Dupe"}, {"videoId": None}]}
        result = load_playlist(client, "https://music.youtube.com/playlist?list=PLabcdefghijk123")
        client.get_playlist.assert_called_once_with("PLabcdefghijk123", limit=1000)
        self.assertEqual((result["id"], result["source"], result["title"]), ("PLabcdefghijk123", "youtube", "Road trip"))
        self.assertEqual([t["title"] for t in result["tracks"]], ["One"])

    def test_import_routes_links_to_the_right_reader(self):
        factory = Mock()
        factory.return_value.get_playlist.return_value = {"title": "Mix", "tracks": []}
        self.assertEqual(import_playlist(factory, "https://music.youtube.com/playlist?list=PLabcdefghijk123")["title"], "Mix")
        with patch.object(music.playlist_sources, "import_external", return_value={"title": "Spotify mix"}) as external:
            self.assertEqual(import_playlist(factory, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")["title"], "Spotify mix")
        self.assertIs(external.call_args.args[1], factory)
        for bad in ["", "https://evil.example/x", "x" * 501]:
            with self.assertRaises(ValueError):
                import_playlist(factory, bad)


if __name__ == "__main__":
    unittest.main()
