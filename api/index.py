"""The API. dev.py serves it locally; vercel.json also routes /api/* here when deployed.

No accounts and nothing stored. JSON routes search YouTube Music and read public playlist links; the audio routes
stream a song's audio-only track and build MP3 downloads (see audio.py; those need to run on your own computer).
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, parse_qsl, quote, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import audio  # noqa: E402
import music  # noqa: E402

AUDIO_ROUTE = re.compile(r"(stream|download)/([A-Za-z0-9_-]{11})")
CHUNK = 64 * 1024
MAX_PLAYLIST_BODY = 3 * 1024 * 1024


class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def route(method, path, query, client_factory):
    """Returns (status, payload). Kept free of HTTP plumbing so tests can call it directly."""
    if method != "GET":
        raise HTTPError(405, "Method not supported.")
    if path == "search":
        return 200, music.search_tracks(client_factory(), query.get("q", "")[:200])
    if path == "playlist":
        return 200, music.import_playlist(client_factory, query.get("url", ""))
    raise HTTPError(404, "Not found.")


def friendly_error(error, path):
    """Map an exception to (status, message) without exposing third-party details."""
    if isinstance(error, HTTPError):
        return error.status, str(error)
    if isinstance(error, ValueError):  # includes playlist_sources.SourceError
        return 400, str(error)
    if isinstance(error, audio.Unavailable):
        return 502, str(error)
    if path == "playlist":
        return 404, "Couldn't open that playlist. Make sure it's public or unlisted, then try again."
    return 502, "Search is unavailable right now. Try again."


def split_path(raw_path):
    url = urlparse(raw_path)
    query = {key: values[0] for key, values in parse_qs(url.query).items()}
    # vercel.json passes the original path as ?route=; dev.py sends /api/... directly.
    path = (query.pop("route", None) or re.sub(r"^/api/?", "", url.path)).strip("/")
    return path, query


def handle(method, raw_path, client_factory=music.client):
    path, query = split_path(raw_path)
    try:
        status, payload = route(method, path, query, client_factory)
        # Search results change slowly; let a CDN answer repeat searches.
        cache = "public, s-maxage=900, stale-while-revalidate=3600" if path == "search" else "no-store"
    except Exception as error:
        status, message = friendly_error(error, path)
        payload, cache = {"error": message}, "no-store"
        if status >= 500 or (path == "playlist" and status == 404):
            print("BHAAI Music %s %s failed: %r" % (method, path, error), file=sys.stderr)
    return status, payload, cache


def download_disposition(name):
    stem, dot, extension = name.rpartition(".")
    ascii_stem = stem.encode("ascii", "ignore").decode().replace('"', "").strip(" -")
    # Browsers use the UTF-8 name; the ASCII one is only a fallback, so never let it be empty.
    ascii_name = (ascii_stem or "download") + dot + extension
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (ascii_name, quote(name))


class handler(BaseHTTPRequestHandler):
    def _respond(self):
        path, query = split_path(self.path)
        if path == "download-playlist" and self.command == "POST":
            self.zip_started = False
            try:
                return self._download_playlist()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return  # the download was cancelled in the browser
            except Exception as error:
                print("BHAAI Music download-playlist failed: %r" % error, file=sys.stderr)
                if self.zip_started:
                    return  # the ZIP is already on its way; the browser will show it as incomplete
                return self._error_page(*friendly_error(error, path))
        match = AUDIO_ROUTE.fullmatch(path)
        if match and self.command == "GET":
            try:
                if match.group(1) == "stream":
                    return self._stream(match.group(2))
                return self._download(match.group(2), query)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return  # the player moved on (seeking, skipping); nothing to answer
            except Exception as error:
                status, message = friendly_error(error, path)
                print("BHAAI Music %s failed: %r" % (path, error), file=sys.stderr)
                return self._json(status, {"error": message}, "no-store")
        status, payload, cache = handle(self.command, self.path)
        self._json(status, payload, cache)

    def _json(self, status, payload, cache):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _stream(self, video_id):
        """Pass the audio bytes through, honouring Range so the player can seek."""
        wanted = self.headers.get("range")
        if wanted and not re.fullmatch(r"bytes=\d*-\d*", wanted):
            wanted = None
        upstream, mime = audio.open_stream(video_id, wanted)
        try:
            if upstream.status_code == 416:
                return self._json(416, {"error": "Invalid range."}, "no-store")
            status = upstream.status_code
            headers = {"Content-Type": upstream.headers.get("content-type") or mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store"}
            if not headers["Content-Type"].startswith("audio/"):
                headers["Content-Type"] = mime
            if upstream.headers.get("content-length"):
                headers["Content-Length"] = upstream.headers["content-length"]
            if wanted and upstream.headers.get("content-range"):
                headers["Content-Range"] = upstream.headers["content-range"]
            elif not wanted:
                status = 200  # we asked Google for bytes=0- ourselves; the player asked for the whole file
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            for chunk in upstream.iter_content(CHUNK):
                self.wfile.write(chunk)
        finally:
            upstream.close()

    def _download(self, video_id, query):
        tags = {key: query.get(key, "") for key in ("title", "artist", "album", "art")}
        with audio.temporary_folder() as folder:
            path, name = audio.build_mp3(video_id, tags, folder)
            size = os.path.getsize(path)
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", download_disposition(name))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            with open(path, "rb") as handle:
                while True:
                    chunk = handle.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    def _download_playlist(self):
        """A form post from Download all. The ZIP streams straight into the browser's download, song by song."""
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_PLAYLIST_BODY:
            raise ValueError("Invalid playlist.")
        fields = dict(parse_qsl(self.rfile.read(length).decode("utf-8", "replace")))
        title, songs = audio.playlist_request(fields.get("playlist"))
        audio.ffmpeg_path()  # fail now, with a readable message, rather than inside the ZIP
        self.zip_started = True
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", download_disposition(title + ".zip"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")  # no Content-Length: the ZIP ends when the connection closes
        self.end_headers()
        failed = audio.write_playlist_zip(self.wfile, songs)
        print("BHAAI Music: sent %s.zip (%d songs, %d failed)" % (title, len(songs) - len(failed), len(failed)), file=sys.stderr)

    def _error_page(self, status, message):
        """Download all posts into a hidden frame; the page reads this message from there (same origin)."""
        from html import escape
        data = ('<!doctype html><meta charset="utf-8"><p id="error">%s</p>' % escape(message)).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _respond
