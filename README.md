# BHAAI Music

A free music player. Search any song and it plays with just its cover art: no video. Make playlists, paste a Spotify, Apple Music, or YouTube Music link to bring a playlist over, and download songs as MP3 files. There's no account; playlists, loved songs and history are saved on the device.

Search and playlist links go through [sigma67/ytmusicapi](https://github.com/sigma67/ytmusicapi) without logging in. The backend uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to find each song's audio-only stream and passes it to a normal `<audio>` player. MP3s are made with ffmpeg.

## Run it on your computer

You need **Python 3.10+** and **Node.js** (yt-dlp uses Node for YouTube's player checks).

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python dev.py
```

Open **http://localhost:3000**. (macOS/Linux: use `.venv/bin/python`. Set `PORT` to use another port.) Press Ctrl+C to stop.

## Features

- **Poster-only player.** The mini player and **Now playing** show the song's artwork, with the background tinted from its colours. Seeking, shuffle, repeat, media keys and lock-screen controls all work.
- **MP3 downloads.** Every song has a download arrow, a **Download MP3** item in its **⋯** menu, and a download button in the mini player and **Now playing**. The server downloads the audio and converts it to a 192 kbps MP3 with title, artist, album and cover art embedded. The browser saves it, usually to your **Downloads** folder, as `Artist - Title.mp3`. One song takes about 5–15 seconds.
- **Download a whole playlist.** **Download all** on a playlist saves one ZIP file, `Playlist name.zip`, with every song as an MP3 numbered in playlist order (`01 Artist - Title.mp3`, …; the numbers get a leading zero from 10 songs up). The download starts right away and grows as songs are converted, two at a time, about 4 seconds per song. Songs that can't be downloaded are listed in `Couldn't download.txt` inside the ZIP.
- **Playlists on the device.** Create, rename, delete, and add or remove songs. Paste a link to import:
  - **YouTube Music / YouTube**: public or unlisted playlists, up to 1,000 songs.
  - **Spotify**: playlists, albums, and songs. Spotify's public page lists only the **first 100 songs** of a playlist.
  - **Apple Music**: playlists, albums, and songs.
  - Spotify and Apple Music songs are matched on YouTube Music by title, artist, and length. Songs without a confident match are skipped, and the import tells you how many.
- Loved songs, recently played, and keyboard shortcuts: Space plays or pauses, `/` searches, Shift+←/→ skips.

## Where things are saved

| Data | Storage |
| --- | --- |
| Downloaded MP3s | Wherever the browser saves downloads on that device |
| Playlists | IndexedDB in the browser (database `svara`) |
| Loved songs, recently played, volume | `localStorage` in the browser |

The server keeps nothing except stream URLs in memory, until they expire. Clearing the site's browser data removes playlists and loved songs, but not downloaded MP3s.

## How it works

```
public/              the site: index.html, styles.css, app.js, library.js
api/index.py         the API (served by dev.py)
music.py             ytmusicapi: search and public playlists
playlist_sources.py  Spotify / Apple Music pages → YouTube Music matches
audio.py             yt-dlp stream lookup, audio proxy, MP3 conversion with ffmpeg
dev.py               local server for public/ and /api/*
```

| Route | What it does |
| --- | --- |
| `GET /api/search?q=` | `YTMusic().search(q, filter="songs")` |
| `GET /api/playlist?url=` | Songs from a public YouTube Music, Spotify, or Apple Music link |
| `GET /api/stream/<videoId>` | Audio-only stream (m4a), with byte ranges for seeking. yt-dlp resolves the signed URL, which is cached until shortly before it expires and resolved again if it goes stale. |
| `GET /api/download/<videoId>?title=&artist=&album=&art=` | A tagged MP3 with its cover, sent as a file download |
| `POST /api/download-playlist` (form field `playlist`: JSON title + tracks) | A ZIP of tagged MP3s, streamed while songs are converted |

ffmpeg: a system `ffmpeg` on PATH is used when there is one. Otherwise the copy bundled with `imageio-ffmpeg` is used.

When YouTube changes something and songs stop playing or downloading, update `yt-dlp` in `requirements.txt` to its newest version and install again.

## Run it on a Raspberry Pi

A Pi 4 or 5 (a Pi 3 works, slowly) with **Raspberry Pi OS 64-bit** can keep it running for every device at home. Copy the project to the Pi, then:

```bash
sudo bash deploy/raspberry-pi/setup.sh
```

It installs ffmpeg, Node.js 22 and the Python packages, and runs the app as a service that starts on boot. Open **http://raspberrypi.local:3000** (use your Pi's hostname) from your computer or phone. Downloaded MP3s save on the device you're using, not on the Pi. Add `TAILSCALE=1` (`sudo TAILSCALE=1 bash deploy/raspberry-pi/setup.sh`) to also reach it privately from outside home with [Tailscale](https://tailscale.com). Logs: `journalctl -u bhaai-music -f`.

## Hosting

Search, playlists and import can run on Vercel (`vercel.json` routes `/api/*` to `api/index.py`), but **playback and MP3 downloads need `dev.py` on a normal computer**:

- YouTube blocks most cloud and datacenter IP addresses, so yt-dlp fails there.
- Vercel functions can't stream a whole song or return a 5–10 MB MP3, and they have no ffmpeg.

Streaming and saving songs from YouTube this way is against YouTube's Terms of Service, and most music on it is copyrighted. This build is for personal testing on your own machine; don't run it as a public service.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -p "test_*.py"
```

The tests mock every network call and ffmpeg run. They cover stream URL caching and re-resolving, byte ranges, the artwork host allowlist, MP3 command building and tagging, file naming, API routing and errors, search result normalisation, playlist link parsing, and song matching.
