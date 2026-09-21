import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("api_index", Path(__file__).resolve().parent.parent / "api" / "index.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class APITests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.client.search.return_value = []

    def call(self, method, path):
        return api.handle(method, path, lambda: self.client)

    def test_vercel_rewrite_and_direct_paths_route_the_same(self):
        for path in ["/api/index?route=search&q=oasis", "/api/search?q=oasis"]:
            status, payload, cache = self.call("GET", path)
            self.assertEqual((status, payload), (200, {"tracks": [], "excluded": 0}))
            self.assertIn("s-maxage", cache)
        self.client.search.assert_called_with("oasis", filter="songs", limit=40)

    def test_no_sign_in_is_needed(self):
        self.client.get_playlist.return_value = {"title": "Road trip", "tracks": []}
        status, payload, cache = self.call("GET", "/api/playlist?url=https%3A%2F%2Fmusic.youtube.com%2Fplaylist%3Flist%3DPLabcdefghijk123")
        self.assertEqual((status, payload["title"], cache), (200, "Road trip", "no-store"))

    def test_only_get_is_accepted(self):
        for method in ["POST", "PUT", "DELETE"]:
            self.assertEqual(self.call(method, "/api/search?q=x")[0], 405)
        self.assertEqual(self.call("GET", "/api/nope")[0], 404)

    def test_errors_are_friendly(self):
        self.assertEqual(self.call("GET", "/api/playlist?url=https://evil.example/x")[:2],
                         (400, {"error": "Paste a playlist link from YouTube Music, Spotify, or Apple Music."}))
        self.client.search.side_effect = ConnectionError("secret details")
        with patch("sys.stderr"):
            status, payload, cache = self.call("GET", "/api/search?q=x")
        self.assertEqual((status, payload, cache), (502, {"error": "Search is unavailable right now. Try again."}, "no-store"))
        self.client.get_playlist.side_effect = RuntimeError("secret details")
        with patch("sys.stderr"):
            status, payload, _ = self.call("GET", "/api/playlist?url=PLabcdefghijk123")
        self.assertEqual(status, 404)
        self.assertNotIn("secret", payload["error"])


if __name__ == "__main__":
    unittest.main()
