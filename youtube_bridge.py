"""Small JSON bridge to sigma67/ytmusicapi (catalog) and yt-dlp (audio stream URLs). No account cookies."""
import json
import os
import re
import sys
from importlib.metadata import version
from urllib.parse import parse_qs, urlparse

import playlist_sources

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
PLAYLIST_ID = re.compile(r"[A-Za-z0-9_-]{10,80}")
PLAYLIST_HOSTS = {"music.youtube.com", "www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"}
MAX_PLAYLIST_TRACKS = 1000


def sized_art(url, size):
    """Ask Google's image CDN for a larger square rendition (Apple Music style artwork)."""
    if re.search(r"=w\d+-h\d+", url):
        return re.sub(r"=w\d+-h\d+", "=w%d-h%d" % (size, size), url)
    match = re.match(r"https://i\.ytimg\.com/vi/([A-Za-z0-9_-]{11})/", url)
    if match:
        # hq720 / mqdefault are 16:9 without letterbox bars, so a square crop looks clean.
        return "https://i.ytimg.com/vi/%s/%s.jpg" % (match.group(1), "hq720" if size > 300 else "mqdefault")
    return url


def normalize_track(track):
    video_id = track.get("videoId", "")
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        return None
    if track.get("isAvailable") is False:
        return None
    thumbnails = [t for t in (track.get("thumbnails") or []) if str(t.get("url", "")).startswith("https://")]
    art = max(thumbnails, key=lambda t: t.get("width", 0) or 0).get("url", "") if thumbnails else ""
    duration = track.get("duration_seconds")
    if not isinstance(duration, (int, float)):
        try:
            duration = 0
            for part in str(track.get("duration") or "0").split(":"):
                duration = duration * 60 + int(part)
        except ValueError:
            duration = 0
    album = track.get("album")
    return {
        "id": video_id, "provider": "youtube", "title": track.get("title") or "Untitled",
        "artist": ", ".join(a.get("name", "") for a in (track.get("artists") or []) if a.get("name")) or "Unknown artist",
        "album": album.get("name", "") if isinstance(album, dict) else "",
        "duration": max(0, duration), "art": sized_art(art, 1200) if art else "", "thumb": sized_art(art, 240) if art else "",
        "playable": True,
    }


def search_tracks(client, query):
    if not isinstance(query, str) or len(query) > 200:
        raise ValueError("Search text must contain at most 200 characters.")
    if not query.strip():
        return {"tracks": [], "excluded": 0}
    rows = client.search(query.strip(), filter="songs", limit=40)
    tracks, seen = [], set()
    for row in rows:
        track = normalize_track(row)
        if track and track["id"] not in seen:
            tracks.append(track)
            seen.add(track["id"])
        if len(tracks) == 40:
            break
    return {"tracks": tracks, "excluded": max(0, len(rows) - len(tracks))}


def playlist_id_from_link(link):
    """Accept a pasted YouTube / YouTube Music playlist link, or a bare playlist ID."""
    if not isinstance(link, str) or len(link) > 500:
        raise ValueError("Paste a playlist link from YouTube Music, Spotify, or Apple Music.")
    link = link.strip()
    if PLAYLIST_ID.fullmatch(link) and not VIDEO_ID.fullmatch(link):
        candidate = link
    else:
        try:
            parsed = urlparse(link if "://" in link else "https://" + link)
        except ValueError:
            parsed = None
        if not parsed or parsed.hostname not in PLAYLIST_HOSTS:
            raise ValueError("Paste a playlist link from YouTube Music, Spotify, or Apple Music.")
        candidate = (parse_qs(parsed.query).get("list") or [""])[0]
    if candidate.startswith("VL"):
        candidate = candidate[2:]
    if not PLAYLIST_ID.fullmatch(candidate):
        raise ValueError("That link has no playlist in it. Open the playlist, then copy its share link.")
    if candidate in ("LL", "WL", "LM"):
        raise ValueError("Liked songs and Watch later are private. Make a public or unlisted playlist and paste that link.")
    return candidate


def load_playlist(client, link):
    playlist_id = playlist_id_from_link(link)
    data = client.get_playlist(playlist_id, limit=MAX_PLAYLIST_TRACKS)
    tracks, seen = [], set()
    for row in data.get("tracks") or []:
        track = normalize_track(row)
        if track and track["id"] not in seen:
            tracks.append(track)
            seen.add(track["id"])
    covers = [t for t in (data.get("thumbnails") or []) if str(t.get("url", "")).startswith("https://")]
    cover = max(covers, key=lambda t: t.get("width", 0) or 0).get("url", "") if covers else ""
    author = data.get("author")
    return {
        "id": playlist_id, "source": "youtube", "title": data.get("title") or "Imported playlist",
        "author": author.get("name", "") if isinstance(author, dict) else "",
        "art": sized_art(cover, 1200) if cover else (tracks[0]["art"] if tracks else ""),
        "tracks": tracks[:MAX_PLAYLIST_TRACKS],
    }


def resolve_stream(video_id):
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        raise ValueError("Invalid track.")
    import yt_dlp
    options = {"quiet": True, "no_warnings": True, "noplaylist": True, "format": "bestaudio[ext=m4a]/bestaudio",
               "js_runtimes": {"node": {}}}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info("https://music.youtube.com/watch?v=" + video_id, download=False)
    url = info.get("url", "")
    if not url.startswith("https://"):
        raise LookupError("This song has no playable audio.")
    mime = "audio/mp4" if info.get("ext") in ("m4a", "mp4") else "audio/webm"
    return {"url": url, "mime": mime}


def tag_file(raw):
    """Embed title, artist, album and cover art into a downloaded .m4a so other music players show them."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError("Invalid tag request.")
    target = data.get("path") if isinstance(data, dict) else None
    if not isinstance(target, str) or not target.lower().endswith(".m4a") or not os.path.isfile(target):
        raise ValueError("Invalid tag request.")
    from mutagen.mp4 import MP4, MP4Cover
    audio = MP4(target)
    if audio.tags is None:
        audio.add_tags()
    for key, field in (("\xa9nam", "title"), ("\xa9ART", "artist"), ("\xa9alb", "album")):
        value = data.get(field)
        if isinstance(value, str) and value.strip():
            audio.tags[key] = [value.strip()[:300]]
    cover = data.get("cover")
    if isinstance(cover, str) and cover and os.path.isfile(cover) and os.path.getsize(cover) < 5_000_000:
        with open(cover, "rb") as handle:
            image = handle.read()
        kind = MP4Cover.FORMAT_PNG if image.startswith(b"\x89PNG") else MP4Cover.FORMAT_JPEG
        audio.tags["covr"] = [MP4Cover(image, imageformat=kind)]
    audio.save()
    return {"tagged": True}


def handle(payload, client_factory):
    """Run one request and return a JSON-ready dict. Errors never expose third-party details."""
    action = payload.get("action") if isinstance(payload, dict) else None
    query = payload.get("query", "") if isinstance(payload, dict) else ""
    try:
        if action == "status":
            return {"ready": True, "version": version("ytmusicapi")}
        if action == "search":
            if not isinstance(query, str) or len(query) > 200:
                raise ValueError("Search text must contain at most 200 characters.")
            # Unauthenticated YTMusic() is sufficient for public catalog search.
            return search_tracks(client_factory() if query.strip() else None, query)
        if action == "playlist":
            if not isinstance(query, str) or len(query) > 500:
                raise ValueError("Paste a playlist link from YouTube Music, Spotify, or Apple Music.")
            detected = playlist_sources.detect(query)
            if detected:
                return playlist_sources.import_external(detected, client_factory, normalize_track)
            playlist_id_from_link(query)  # validate before touching the network
            return load_playlist(client_factory(), query)
        if action == "stream":
            return resolve_stream(query)
        if action == "tag":
            return tag_file(query)
        raise ValueError("Unsupported operation.")
    except ValueError as error:
        return {"error": str(error), "status": 400}
    except ImportError:
        return {"error": "BHAAI Music needs its Python packages. Run Setup-Windows.bat to install them.", "status": 428}
    except LookupError as error:
        return {"error": str(error), "status": 404}
    except Exception:
        if action == "playlist":
            return {"error": "Couldn't open that playlist. Make sure it's public or unlisted, then try again.", "status": 404}
        if action == "stream":
            return {"error": "This song can't be played right now. Try another one.", "status": 502}
        return {"error": "Search is unavailable. Check your internet connection and try again.", "status": 502}


def serve(client_factory):
    """Long-lived mode: one JSON request per stdin line, answered by id on stdout.
    Keeping Python and yt-dlp loaded saves a couple of seconds on every song."""
    import threading
    from concurrent.futures import ThreadPoolExecutor
    lock = threading.Lock()

    def work(line):
        try:
            payload = json.loads(line)
        except ValueError:
            return
        output = handle(payload, client_factory)
        output["_id"] = payload.get("_id")
        with lock:
            sys.stdout.write(json.dumps(output, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    with ThreadPoolExecutor(max_workers=6) as pool:
        for line in sys.stdin:
            if line.strip() and len(line) <= 8192:
                pool.submit(work, line)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        from ytmusicapi import YTMusic
    except ImportError:
        print(json.dumps({"error": "BHAAI Music needs its Python packages. Run Setup-Windows.bat, or install requirements.txt in .venv.", "status": 428}))
        return
    if "--serve" in sys.argv:
        import threading
        local = threading.local()

        def client_factory():
            if not hasattr(local, "client"):
                local.client = YTMusic()
            return local.client
        serve(client_factory)
        return
    try:
        payload = json.loads(sys.stdin.read(8192))
    except ValueError:
        payload = {}
    print(json.dumps(handle(payload, YTMusic), ensure_ascii=False))


if __name__ == "__main__":
    main()
