import os
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import audio

GOOD_URL = "https://rr1---sn-abc.googlevideo.com/videoplayback?expire=%d&itag=140" % (time.time() + 6 * 3600)


def response(status, headers=None, content=b""):
    reply = Mock(status_code=status, headers=headers or {}, content=content)
    return reply


class StreamTests(unittest.TestCase):
    def setUp(self):
        audio._streams.clear()

    def test_stream_urls_are_cached_and_only_googlevideo_is_accepted(self):
        extract = Mock(return_value={"url": GOOD_URL, "ext": "m4a"})
        first = audio.stream_info("abcdefghijk", extract=extract)
        self.assertEqual(audio.stream_info("abcdefghijk", extract=extract), first)
        extract.assert_called_once()
        self.assertEqual(first["mime"], "audio/mp4")
        self.assertLessEqual(first["until"], time.time() + 5 * 3600 + 1)
        audio._streams.clear()
        with self.assertRaises(audio.Unavailable):
            audio.stream_info("abcdefghijk", extract=Mock(return_value={"url": "https://evil.example/a.m4a"}))
        with self.assertRaises(audio.Unavailable):
            audio.stream_info("abcdefghijk", extract=Mock(side_effect=RuntimeError("yt-dlp details")))
        with self.assertRaises(ValueError):
            audio.stream_info("../etc", extract=extract)

    def test_open_stream_always_sends_a_range_and_retries_stale_urls(self):
        audio._streams["abcdefghijk"] = {"url": GOOD_URL, "mime": "audio/mp4", "until": time.time() + 999}
        session = Mock()
        session.get.side_effect = [response(403), response(206)]
        with patch.object(audio, "_extract", return_value={"url": GOOD_URL + "&fresh=1", "ext": "m4a"}):
            upstream, mime = audio.open_stream("abcdefghijk", None, session)
        self.assertEqual((upstream.status_code, mime), (206, "audio/mp4"))
        self.assertEqual(session.get.call_args_list[0].kwargs["headers"], {"Range": "bytes=0-"})
        self.assertTrue(session.get.call_args_list[1].args[0].endswith("&fresh=1"))

    def test_open_stream_gives_up_on_other_errors(self):
        audio._streams["abcdefghijk"] = {"url": GOOD_URL, "mime": "audio/mp4", "until": time.time() + 999}
        session = Mock()
        session.get.return_value = response(500)
        with self.assertRaises(audio.Unavailable):
            audio.open_stream("abcdefghijk", "bytes=0-99", session)
        self.assertNotIn("abcdefghijk", audio._streams)


class MP3Tests(unittest.TestCase):
    def test_file_names_are_safe_everywhere(self):
        self.assertEqual(audio.safe_name('AC/DC: "Back" <In> Black?.'), "AC DC Back In Black")
        self.assertEqual(audio.safe_name("con"), "_con")
        self.assertEqual(audio.safe_name("  ..  "), "Untitled")
        self.assertEqual(audio.safe_name("సామజవరగమన"), "సామజవరగమన")

    def test_mp3_command_tags_and_embeds_the_cover(self):
        command = audio.mp3_command("ffmpeg", "in.m4a", "cover", "out.mp3", {"title": "Wonderwall", "artist": "Oasis", "album": ""})
        self.assertEqual(command[-1], "out.mp3")
        for part in ["libmp3lame", "192k", "attached_pic", "title=Wonderwall", "artist=Oasis"]:
            self.assertIn(part, command)
        self.assertNotIn("album=", " ".join(command))
        self.assertNotIn("attached_pic", audio.mp3_command("ffmpeg", "in.m4a", "", "out.mp3", {}))

    def test_cover_only_comes_from_artwork_hosts(self):
        with tempfile.TemporaryDirectory() as folder:
            session = Mock()
            session.get.return_value = response(200, {"content-type": "image/jpeg"}, b"jpeg")
            self.assertEqual(audio.fetch_cover("http://i.ytimg.com/x.jpg", folder, session), "")
            self.assertEqual(audio.fetch_cover("https://169.254.169.254/latest", folder, session), "")
            session.get.assert_not_called()
            path = audio.fetch_cover("https://lh3.googleusercontent.com/x=w1200-h1200", folder, session)
            self.assertTrue(os.path.isfile(path))
            session.get.return_value = response(200, {"content-type": "text/html"}, b"<html>")
            self.assertEqual(audio.fetch_cover("https://i.ytimg.com/vi/x/hq720.jpg", folder, session), "")

    def test_build_mp3_retries_without_a_bad_cover(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "source.webm")
            open(source, "wb").close()
            calls = []

            def run(command, **kwargs):
                calls.append(command)
                if "attached_pic" not in command:
                    open(command[-1], "wb").close()
                return Mock(returncode=0 if "attached_pic" not in command else 1)

            with patch.object(audio, "ffmpeg_path", return_value="ffmpeg"), patch.object(audio, "fetch_cover", return_value="cover"):
                path, name = audio.build_mp3("abcdefghijk", {"title": "", "artist": "Oasis", "art": "https://i.ytimg.com/x"}, folder,
                                             download=lambda video_id, folder: {"filepath": source, "track": "Wonderwall"}, run=run)
            self.assertEqual((os.path.basename(path), name), ("song.mp3", "Oasis - Wonderwall.mp3"))
            self.assertEqual(len(calls), 2)

    def test_build_mp3_reports_friendly_errors(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(audio, "ffmpeg_path", return_value="ffmpeg"):
            with self.assertRaises(audio.Unavailable) as caught:
                audio.build_mp3("abcdefghijk", {}, folder, download=Mock(side_effect=RuntimeError("yt-dlp details")))
            self.assertNotIn("yt-dlp", str(caught.exception))
            with self.assertRaises(ValueError):
                audio.build_mp3("bad", {}, folder)


class PlaylistZipTests(unittest.TestCase):
    def test_playlist_request_is_validated(self):
        import json
        title, songs = audio.playlist_request(json.dumps({"title": 'Road: "trip"', "tracks": [
            {"id": "abcdefghijk", "title": "One", "artist": "A\nB"}, {"id": "abcdefghijk", "title": "Dupe"}]}))
        self.assertEqual(title, "Road trip")
        self.assertEqual(songs, [{"id": "abcdefghijk", "title": "One", "artist": "A B", "album": "", "art": ""}])
        for bad in [None, "nope", json.dumps({"tracks": []}), json.dumps({"tracks": [{"id": "../x"}]}),
                    json.dumps({"tracks": [{"id": "abcdefghijk"}] * 1001}), json.dumps([1])]:
            with self.assertRaises(ValueError):
                audio.playlist_request(bad)

    def test_zip_streams_to_an_unseekable_output_and_lists_failures(self):
        import io
        import zipfile

        class SocketLike(io.RawIOBase):
            def __init__(self):
                self.data = bytearray()

            def writable(self):
                return True

            def write(self, chunk):
                self.data += chunk
                return len(chunk)

            def tell(self):
                raise io.UnsupportedOperation("socket")

        def build(video_id, track, folder):
            if video_id == "bbbbbbbbbbb":
                raise audio.Unavailable("nope")
            path = os.path.join(folder, "song.mp3")
            with open(path, "wb") as handle:
                handle.write(b"ID3" + video_id.encode())
            return path, "%s - %s.mp3" % (track["artist"], track["title"])

        songs = [{"id": c * 11, "title": "Song " + c, "artist": "Artist", "album": "", "art": ""} for c in "abc"]
        output = SocketLike()
        failed = audio.write_playlist_zip(output, songs, build=build)
        self.assertEqual(failed, ["Artist - Song b"])
        archive = zipfile.ZipFile(io.BytesIO(bytes(output.data)))
        self.assertEqual(sorted(archive.namelist()), ["1 Artist - Song a.mp3", "3 Artist - Song c.mp3", "Couldn't download.txt"])
        self.assertEqual(archive.read("3 Artist - Song c.mp3"), b"ID3ccccccccccc")
        self.assertIn("2 Artist - Song b", archive.read("Couldn't download.txt").decode())


if __name__ == "__main__":
    unittest.main()
