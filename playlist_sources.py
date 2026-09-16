"""Read public Spotify and Apple Music playlists/albums/songs without API keys, then match each song on YouTube Music.

Spotify: the public embed page (open.spotify.com/embed/...) carries the track list as JSON (first 100 tracks).
Apple Music: the public web page carries a serialized-server-data JSON block with the track list.
"""
import json
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from urllib.parse import parse_qs, urlparse

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
SPOTIFY_ID = re.compile(r"[A-Za-z0-9]{22}")
APPLE_PLAYLIST_ID = re.compile(r"pl\.(?:u-)?[A-Za-z0-9]{8,64}")
MAX_EXTERNAL_TRACKS = 500


class SourceError(ValueError):
    """A problem with the pasted link the user can fix."""


def detect(link):
    """Return (source, kind, id, extra) for Spotify / Apple Music links, or None for anything else."""
    link = link.strip()
    match = re.fullmatch(r"spotify:(playlist|album|track):([A-Za-z0-9]{22})", link)
    if match:
        return "spotify", match.group(1), match.group(2), None
    try:
        parsed = urlparse(link if "://" in link else "https://" + link)
    except ValueError:
        return None
    host = (parsed.hostname or "").lower()
    parts = [p for p in parsed.path.split("/") if p]
    if host in ("open.spotify.com", "play.spotify.com"):
        parts = [p for p in parts if not p.startswith("intl-") and p != "embed"]
        if len(parts) >= 2 and parts[0] in ("playlist", "album", "track") and SPOTIFY_ID.fullmatch(parts[1]):
            return "spotify", parts[0], parts[1], None
        raise SourceError("Paste a Spotify playlist, album, or song link.")
    if host in ("spotify.link", "spotify.app.link"):
        return "spotify", "short", link if "://" in link else "https://" + link, None
    if host in ("music.apple.com", "itunes.apple.com", "geo.music.apple.com", "embed.music.apple.com"):
        storefront = parts[0] if parts and re.fullmatch(r"[a-z]{2}", parts[0]) else "us"
        kinds = [p for p in parts if p in ("playlist", "album", "song")]
        last = parts[-1] if parts else ""
        if kinds and kinds[0] == "playlist" and APPLE_PLAYLIST_ID.fullmatch(last):
            return "apple", "playlist", last, storefront
        if kinds and kinds[0] in ("album", "song") and last.isdigit():
            song = (parse_qs(parsed.query).get("i") or [""])[0]
            return "apple", kinds[0], last, {"storefront": storefront, "song": song if song.isdigit() else ""}
        if kinds and kinds[0] == "playlist":
            raise SourceError("That Apple Music playlist link is incomplete. Use Share → Copy Link in Apple Music.")
        raise SourceError("Paste an Apple Music playlist, album, or song link.")
    return None


def _session():
    import requests
    session = requests.Session()
    session.headers.update(HEADERS)
    return session


def _page(session, url):
    response = session.get(url, timeout=20)
    if response.status_code == 404:
        raise SourceError("That link doesn't open. Make sure the playlist is public, then copy its share link again.")
    response.raise_for_status()
    response.encoding = "utf-8"
    return response


def parse_spotify_embed(html):
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not match:
        raise SourceError("Couldn't read that Spotify link. Make sure the playlist is public.")
    try:
        entity = json.loads(match.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (ValueError, KeyError, TypeError):
        raise SourceError("Couldn't read that Spotify link. Make sure the playlist is public.")
    kind = entity.get("type")
    covers = [s.get("url", "") for s in (entity.get("coverArt") or {}).get("sources") or [] if str(s.get("url", "")).startswith("https://")]
    if kind == "track":
        artists = [a.get("name", "") for a in entity.get("artists") or [] if a.get("name")]
        songs = [{"title": entity.get("title") or entity.get("name") or "", "artists": artists, "duration": (entity.get("duration") or 0) / 1000}]
    else:
        songs = [{"title": t.get("title", ""), "artists": [a.strip() for a in (t.get("subtitle") or "").replace(" ", " ").split(",") if a.strip()],
                  "duration": (t.get("duration") or 0) / 1000}
                 for t in entity.get("trackList") or [] if t.get("isPlayable", True)]
    return {"title": entity.get("name") or entity.get("title") or "Spotify playlist", "author": entity.get("subtitle") or "",
            "art": covers[0] if covers else "", "songs": [s for s in songs if s["title"]]}


def _apple_art(artwork, size=1200):
    url = ((artwork or {}).get("dictionary") or {}).get("url", "")
    return url.replace("{w}", str(size)).replace("{h}", str(size)).replace("{f}", "jpg").replace("{c}", "bb") if url.startswith("https://") else ""


def parse_apple_page(html, song_id=""):
    match = re.search(r'<script type="application/json" id="serialized-server-data">(.*?)</script>', html, re.S)
    if not match:
        raise SourceError("Couldn't read that Apple Music link. Make sure the playlist is public.")
    try:
        page = (json.loads(match.group(1)).get("data") or [{}])[0].get("data") or {}
    except (ValueError, AttributeError, IndexError):
        raise SourceError("Couldn't read that Apple Music link. Make sure the playlist is public.")
    sections = page.get("sections") or []
    header = next((s["items"][0] for s in sections if s.get("itemKind") == "containerDetailHeaderLockup" and s.get("items")), {})
    header_artists = [link.get("title", "") for link in header.get("subtitleLinks") or [] if link.get("title")]
    songs = []
    for section in sections:
        if section.get("itemKind") != "trackLockup":
            continue
        for item in section.get("items") or []:
            if song_id and not str(item.get("id", "")).endswith(" - " + song_id):
                continue
            artists = [a.strip() for a in re.split(r",|&", item.get("artistName") or "") if a.strip()] or header_artists
            songs.append({"title": item.get("title") or "", "artists": artists, "duration": (item.get("duration") or 0) / 1000,
                          "art": _apple_art(item.get("artwork"))})
    title = header.get("title") or "Apple Music playlist"
    if song_id and songs:
        title = songs[0]["title"]
    return {"title": title, "author": ", ".join(header_artists), "art": _apple_art(header.get("artwork")),
            "songs": [s for s in songs if s["title"]]}


def fetch_source(detected):
    source, kind, ident, extra = detected
    session = _session()
    if source == "spotify":
        if kind == "short":
            response = _page(session, ident)
            found = detect(response.url)
            if not found or found[0] != "spotify" or found[1] == "short":
                raise SourceError("That Spotify short link doesn't lead to a playlist, album, or song.")
            source, kind, ident, extra = found
        info = parse_spotify_embed(_page(session, "https://open.spotify.com/embed/%s/%s" % (kind, ident)).text)
        return "spotify-" + ident, info
    storefront = extra if isinstance(extra, str) else extra["storefront"]
    if kind == "playlist":
        url = "https://music.apple.com/%s/playlist/%s" % (storefront, ident)
        info = parse_apple_page(_page(session, url).text)
    else:
        url = "https://music.apple.com/%s/album/%s" % (storefront, ident)
        info = parse_apple_page(_page(session, url).text, extra["song"] if kind == "album" else "")
    return "apple-" + ident + ("-" + extra["song"] if isinstance(extra, dict) and extra.get("song") else ""), info


LANGUAGES = r"telugu|tamil|hindi|malayalam|kannada|bengali|marathi|punjabi|english|spanish"
EXTRAS = r"feat|ft\.|with|from|remaster|version|edit|original motion picture|soundtrack|" + LANGUAGES


def _clean(text):
    text = unicodedata.normalize("NFKD", text or "").lower()
    text = re.sub(r"[\(\[][^\)\]]*(%s)[^\)\]]*[\)\]]" % EXTRAS, " ", text)
    # "Buttabomma - Telugu", "Song - From \"Film\"", "Song - 2011 Remaster"
    text = re.sub(r"\s-\s.*(%s).*$" % EXTRAS, " ", text)
    text = re.sub(r"\b(feat|ft)\.?\s.*$", " ", text)
    return re.sub(r"[^\w]+", " ", text).strip()


def _title_similarity(a, b):
    a, b = _clean(a), _clean(b)
    # "Buttabomma" and "Butta Bomma" are the same song.
    return max(SequenceMatcher(None, a, b).ratio(), SequenceMatcher(None, a.replace(" ", ""), b.replace(" ", "")).ratio())


# Words that mark a different recording (a fan cover, a status clip) unless the original title has them too.
NOISE = re.compile(r"\b(cover|remix|karaoke|instrumental|8d|slowed|reverb|lo-?fi|live|unplugged|status|reprise|dance|mashup|jukebox|ringtone|whatsapp|nightcore|sped up|reaction|tutorial)\b", re.I)


def _parts(song, candidate):
    title = _title_similarity(song["title"], candidate.get("title", ""))
    found_artists = _clean(candidate.get("artist", ""))
    wanted = [_clean(a) for a in song.get("artists") or [] if _clean(a)]
    artist = 1.0 if not wanted else (1.0 if found_artists and any(a in found_artists or found_artists in a for a in wanted) else 0.0)
    if not song.get("duration") or not candidate.get("duration"):
        duration = 0.5
    else:
        gap = abs(song["duration"] - candidate["duration"])
        duration = 1.0 if gap <= 5 else 0.6 if gap <= 15 else 0.0
    noise = {w.lower() for w in NOISE.findall(candidate.get("title", "") + " " + candidate.get("artist", ""))} - \
        {w.lower() for w in NOISE.findall(song["title"])}
    return title, artist, duration, bool(noise)


def score(song, candidate):
    """0..1 confidence that a YouTube Music result is the same recording."""
    title, artist, duration, noisy = _parts(song, candidate)
    return title * 0.55 + artist * 0.3 + duration * 0.15 - (0.35 if noisy else 0)


def acceptable(song, candidate):
    title, artist, duration, noisy = _parts(song, candidate)
    # A title match alone isn't enough: the artist or the length has to agree too.
    return not noisy and title >= 0.6 and (artist == 1.0 or duration >= 0.6) and score(song, candidate) >= 0.6


def match_song(client, song, normalize_track):
    title = _clean(song["title"]) or song["title"]
    artists = song.get("artists") or []
    queries = list(dict.fromkeys(" ".join([title] + artists[:n])[:200] for n in (2, 1)))
    best, best_score = None, 0.0
    for query in queries:
        for search_filter in ("songs", "videos"):
            for row in client.search(query, filter=search_filter, limit=10)[:10]:
                track = normalize_track(row)
                if not track or not acceptable(song, track):
                    continue
                value = score(song, track)
                if value > best_score:
                    best, best_score = track, value
            if best_score >= 0.85:
                return best
    return best


def import_external(detected, client_factory, normalize_track):
    playlist_id, info = fetch_source(detected)
    songs = info["songs"][:MAX_EXTERNAL_TRACKS]
    if not songs:
        raise SourceError("That playlist looks empty, or it's private.")

    def work(song):
        try:
            track = match_song(client_factory(), song, normalize_track)
        except Exception:
            return None
        if track and song.get("art"):
            track["art"], track["thumb"] = song["art"], song["art"].replace("1200x1200", "240x240")
        return track

    with ThreadPoolExecutor(max_workers=8) as pool:
        matches = list(pool.map(work, songs))
    tracks, seen = [], set()
    for track in matches:
        if track and track["id"] not in seen:
            tracks.append(track)
            seen.add(track["id"])
    missing = [s["title"] for s, t in zip(songs, matches) if not t]
    return {
        "id": playlist_id, "title": info["title"], "author": info["author"], "source": detected[0],
        "art": info["art"] or (tracks[0]["art"] if tracks else ""), "tracks": tracks,
        "missing": missing[:50], "missingCount": len(missing),
        "truncated": detected[0] == "spotify" and len(info["songs"]) >= 100,
    }
