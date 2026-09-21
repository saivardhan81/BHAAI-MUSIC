"""Audio for the local player: yt-dlp finds a song's audio-only stream, and ffmpeg turns it into a tagged MP3 download.

This needs a normal internet connection. YouTube blocks most cloud servers, so it is meant for dev.py on your own computer.
"""
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unicodedata
from urllib.parse import urlparse

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
ART_HOSTS = {"lh3.googleusercontent.com", "yt3.googleusercontent.com", "yt3.ggpht.com", "i.ytimg.com", "i.scdn.co", "mosaic.scdn.co"}
MAX_DOWNLOADS = 2  # conversions at once; each uses a CPU core for a few seconds
YDL_BASE = {"quiet": True, "no_warnings": True, "noplaylist": True, "format": "bestaudio[ext=m4a]/bestaudio",
            "js_runtimes": {"node": {}}}  # yt-dlp needs a JavaScript runtime for YouTube's player challenges

_streams = {}
_streams_lock = threading.Lock()
_download_slots = threading.BoundedSemaphore(MAX_DOWNLOADS)


class Unavailable(Exception):
    """A song can't be played or saved. The message is safe to show."""


def check_id(video_id):
    if not isinstance(video_id, str) or not VIDEO_ID.fullmatch(video_id):
        raise ValueError("Invalid song.")
    return video_id


def watch_url(video_id):
    return "https://music.youtube.com/watch?v=" + check_id(video_id)


def stream_info(video_id, fresh=False, extract=None):
    """Signed googlevideo.com audio URL, cached until five minutes before it expires."""
    check_id(video_id)
    now = time.time()
    if not fresh:
        with _streams_lock:
            hit = _streams.get(video_id)
        if hit and hit["until"] > now:
            return hit
    try:
        info = (extract or _extract)(video_id)
    except Unavailable:
        raise
    except Exception:
        raise Unavailable("This song can't be played right now. Try another one.")
    url = info.get("url", "")
    if not url.startswith("https://") or not (urlparse(url).hostname or "").endswith(".googlevideo.com"):
        raise Unavailable("This song has no playable audio.")
    expire = re.search(r"[?&]expire=(\d+)", url)
    until = min(int(expire.group(1)) - 300, now + 5 * 3600) if expire else now + 1800
    entry = {"url": url, "mime": "audio/mp4" if info.get("ext") in ("m4a", "mp4") else "audio/webm", "until": max(until, now + 60)}
    with _streams_lock:
        if len(_streams) > 500:
            _streams.clear()
        _streams[video_id] = entry
    return entry


def _extract(video_id):
    import yt_dlp
    with yt_dlp.YoutubeDL(YDL_BASE) as ydl:
        return ydl.extract_info(watch_url(video_id), download=False)


def open_stream(video_id, range_header, session=None):
    """Open the song's audio at the requested byte range. Returns (upstream response, mime)."""
    import requests
    session = session or requests
    # Google throttles audio requests without a byte range to real-time speed, so always ask for one.
    headers = {"Range": range_header or "bytes=0-"}
    entry = stream_info(video_id)
    upstream = session.get(entry["url"], headers=headers, stream=True, timeout=(10, 60))
    if upstream.status_code in (403, 410):  # the signed URL went stale
        upstream.close()
        entry = stream_info(video_id, fresh=True)
        upstream = session.get(entry["url"], headers=headers, stream=True, timeout=(10, 60))
    if upstream.status_code not in (200, 206, 416):
        upstream.close()
        with _streams_lock:
            _streams.pop(video_id, None)
        raise Unavailable("This song can't be played right now. Try another one.")
    return upstream, entry["mime"]


def ffmpeg_path():
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise Unavailable("MP3 downloads need ffmpeg. Run: pip install -r requirements.txt")


def safe_name(text, fallback="Untitled"):
    """A file name that is valid on Windows, macOS, Linux, Android and iOS."""
    name = unicodedata.normalize("NFC", str(text or ""))
    name = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]+', " ", name)
    name = re.sub(r"\s+", " ", name).strip()[:120].rstrip(". ")
    if not name:
        return fallback
    return "_" + name if re.fullmatch(r"(con|prn|aux|nul|com\d|lpt\d)", name.split(".")[0], re.I) else name


def clean_tag(value, limit=300):
    return re.sub(r"[\x00-\x1f\x7f]+", " ", value).strip()[:limit] if isinstance(value, str) else ""


def fetch_cover(art, folder, session=None):
    """Download the poster so it can be embedded in the MP3. Only known artwork hosts; failures just skip the cover."""
    import requests
    session = session or requests
    try:
        parsed = urlparse(art or "")
        if parsed.scheme != "https" or parsed.hostname not in ART_HOSTS:
            return ""
        response = session.get(art, timeout=15)
        if response.status_code != 200 or not response.headers.get("content-type", "").startswith("image/") or len(response.content) > 5_000_000:
            return ""
        path = os.path.join(folder, "cover")
        with open(path, "wb") as handle:
            handle.write(response.content)
        return path
    except Exception:
        return ""


def mp3_command(ffmpeg, source, cover, target, tags):
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", source]
    if cover:
        command += ["-i", cover, "-map", "0:a:0", "-map", "1:v:0", "-c:v", "mjpeg",
                    "-disposition:v:0", "attached_pic", "-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
    else:
        command += ["-map", "0:a:0"]
    command += ["-c:a", "libmp3lame", "-b:a", "192k", "-id3v2_version", "3"]
    for key in ("title", "artist", "album"):
        if tags.get(key):
            command += ["-metadata", "%s=%s" % (key, tags[key])]
    return command + [target]


def build_mp3(video_id, tags, folder, download=None, run=subprocess.run):
    """Download the audio into `folder` and convert it to a tagged 192 kbps MP3. Returns (path, file name)."""
    check_id(video_id)
    if not _download_slots.acquire(timeout=120):
        raise Unavailable("Other downloads are still being prepared. Try again in a moment.")
    try:
        ffmpeg = ffmpeg_path()
        try:
            info = (download or _download)(video_id, folder)
        except Unavailable:
            raise
        except Exception:
            raise Unavailable("This song can't be downloaded right now. Try another one.")
        source = info.get("filepath", "")
        if not source or not os.path.isfile(source):
            raise Unavailable("This song can't be downloaded right now. Try another one.")
        title = clean_tag(tags.get("title")) or clean_tag(info.get("track")) or clean_tag(info.get("title")) or "Untitled"
        artist = clean_tag(tags.get("artist")) or clean_tag(info.get("artist")) or clean_tag(info.get("uploader")) or ""
        album = clean_tag(tags.get("album")) or clean_tag(info.get("album")) or ""
        cover = fetch_cover(tags.get("art") or "", folder)
        target = os.path.join(folder, "song.mp3")
        result = run(mp3_command(ffmpeg, source, cover, target, {"title": title, "artist": artist, "album": album}),
                     capture_output=True, timeout=300)
        if cover and (result.returncode != 0 or not os.path.isfile(target)):
            # An unusual cover image shouldn't cost the song; try once more without it.
            result = run(mp3_command(ffmpeg, source, "", target, {"title": title, "artist": artist, "album": album}),
                         capture_output=True, timeout=300)
        if result.returncode != 0 or not os.path.isfile(target):
            raise Unavailable("Couldn't convert this song to MP3. Try again.")
        name = safe_name(" - ".join(p for p in (artist, title) if p)) + ".mp3"
        return target, name
    finally:
        _download_slots.release()


def _download(video_id, folder):
    import yt_dlp
    options = {**YDL_BASE, "noprogress": True, "outtmpl": os.path.join(folder, "source.%(ext)s")}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(watch_url(video_id), download=True)
    downloads = info.get("requested_downloads") or [{}]
    return {**info, "filepath": downloads[0].get("filepath") or ""}


def temporary_folder():
    return tempfile.TemporaryDirectory(prefix="bhaai-")


MAX_ZIP_TRACKS = 1000


def playlist_request(raw):
    """Validate the posted playlist: {"title": str, "tracks": [{"id", "title", "artist", "album", "art"}]}."""
    import json
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError("Invalid playlist.")
    tracks = data.get("tracks") if isinstance(data, dict) else None
    if not isinstance(tracks, list) or not tracks or len(tracks) > MAX_ZIP_TRACKS:
        raise ValueError("Choose a playlist with 1 to %d songs." % MAX_ZIP_TRACKS)
    songs, seen = [], set()
    for track in tracks:
        if not isinstance(track, dict):
            raise ValueError("Invalid playlist.")
        video_id = check_id(track.get("id"))
        if video_id in seen:
            continue
        seen.add(video_id)
        songs.append({"id": video_id, **{key: clean_tag(track.get(key), 2000 if key == "art" else 300) for key in ("title", "artist", "album", "art")}})
    return safe_name(clean_tag(data.get("title")), "Playlist"), songs


def _zip_song(track, build):
    folder = temporary_folder()
    try:
        path, name = build(track["id"], track, folder.name)
        return folder, path, name
    except BaseException:
        folder.cleanup()
        raise


def write_playlist_zip(output, songs, build=None):
    """Stream a ZIP of MP3s into `output`, adding each song as soon as it's converted.

    Works on a socket (no seeking), so the browser's download starts at once and grows song by song.
    Songs that fail are listed in "Couldn't download.txt" inside the ZIP. Returns their titles.
    """
    import zipfile
    from concurrent.futures import ThreadPoolExecutor, as_completed
    build = build or build_mp3
    width = len(str(len(songs)))
    failed = []
    pool = ThreadPoolExecutor(max_workers=MAX_DOWNLOADS)
    futures = {pool.submit(_zip_song, track, build): (number, track) for number, track in enumerate(songs, 1)}
    try:
        # MP3s are already compressed, so they are stored as they are.
        with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
            for future in as_completed(futures):
                number, track = futures[future]
                try:
                    folder, path, name = future.result()
                except Exception:
                    failed.append((number, " - ".join(p for p in (track["artist"], track["title"]) if p) or track["id"]))
                    continue
                try:
                    archive.write(path, "%0*d %s" % (width, number, name))
                finally:
                    folder.cleanup()
            if failed:
                lines = ["These songs couldn't be downloaded. Try them one at a time in BHAAI Music.", ""]
                lines += ["%0*d %s" % (width, number, title) for number, title in sorted(failed)]
                archive.writestr("Couldn't download.txt", "\r\n".join(lines) + "\r\n")
    finally:
        # If the browser cancelled the download, skip the songs that haven't started.
        pool.shutdown(wait=False, cancel_futures=True)
    return [title for _, title in sorted(failed)]
