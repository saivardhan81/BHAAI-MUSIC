"""YouTube Music catalog through sigma67/ytmusicapi, without an account: song search and public playlist import.

Playlists themselves are saved in each visitor's browser (see public/library.js), never on the server.
"""
import re
import threading
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


def largest_thumbnail(thumbnails):
    usable = [t for t in (thumbnails or []) if str(t.get("url", "")).startswith("https://")]
    return max(usable, key=lambda t: t.get("width", 0) or 0).get("url", "") if usable else ""


def normalize_track(track):
    video_id = track.get("videoId", "")
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        return None
    if track.get("isAvailable") is False:
        return None
    art = largest_thumbnail(track.get("thumbnails"))
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
    cover = largest_thumbnail(data.get("thumbnails"))
    author = data.get("author")
    return {
        "id": playlist_id, "source": "youtube", "title": data.get("title") or "Imported playlist",
        "author": author.get("name", "") if isinstance(author, dict) else "",
        "art": sized_art(cover, 1200) if cover else (tracks[0]["art"] if tracks else ""),
        "tracks": tracks[:MAX_PLAYLIST_TRACKS],
    }


def import_playlist(client_factory, link):
    """Read a public YouTube Music, Spotify, or Apple Music link. The browser saves the result."""
    if not isinstance(link, str) or not link.strip() or len(link) > 500:
        raise ValueError("Paste a playlist link from YouTube Music, Spotify, or Apple Music.")
    detected = playlist_sources.detect(link)
    if detected:
        return playlist_sources.import_external(detected, client_factory, normalize_track)
    playlist_id_from_link(link)  # validate before touching the network
    return load_playlist(client_factory(), link)


_clients = threading.local()


def client():
    """One unauthenticated YTMusic per thread; a warm serverless instance reuses it."""
    if getattr(_clients, "ytmusic", None) is None:
        from ytmusicapi import YTMusic
        _clients.ytmusic = YTMusic()
    return _clients.ytmusic
