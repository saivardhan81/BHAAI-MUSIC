# BHAAI Music — local music app

Search any song and it plays with just its cover art: no video player, no ads. Make your own playlists, paste a Spotify, Apple Music, or YouTube Music link to bring a playlist over, and download songs to keep them on this computer.

BHAAI Music runs on your own machine. Search and playlists come from YouTube Music through [sigma67/ytmusicapi](https://github.com/sigma67/ytmusicapi). Audio-only streams are resolved by [yt-dlp](https://github.com/yt-dlp/yt-dlp) and passed through the local server to a normal `<audio>` element. Internet access is needed for anything that isn't downloaded.

## Start on Windows

1. Install Node.js 22 or newer from https://nodejs.org.
2. Install Python 3.10 or newer from https://www.python.org and select **Add Python to PATH**.
3. Double-click `Start-Windows.bat`. The first launch runs `Setup-Windows.bat`, which creates `.venv` and installs `requirements.txt`. Keep the command window open.
4. Open http://localhost:3030.

On macOS/Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
node server.mjs
```

`BHAAI_PORT` changes the port (default 3030). The older `SVARA_*` variable names still work. `BHAAI_PYTHON` points at a different Python that already has the requirements installed.

## Features

- **Cover-art player.** The mini player and the full-screen **Now playing** view show the song's artwork at 1200px, with the background tinted from the artwork's colours. The queue shows under **Up next**.
- **No ads.** Ads are part of YouTube's video player, not the audio stream. BHAAI Music never loads that player, so nothing needs to be blocked. A browser extension such as uBlock Origin can't be bundled into a web page, and with this design you don't need one.
- **Your own playlists.** Use **+** next to *Your playlists* (or **New playlist** in Library) and give it a name. Add songs with the **⋯** button on any song or the **+** in Now playing. Inside a playlist, **⋯ → Remove** takes a song out, the pencil renames the playlist, and the bin deletes it. Imported playlists can be edited the same way.
- **Playlist import.** Paste a link on Home or in Library:
  - **YouTube Music / YouTube**: public or unlisted playlists (including `watch?v=…&list=…` links), up to 1,000 songs. These are copied exactly.
  - **Spotify**: playlists, albums, and songs (`open.spotify.com/…`, `spotify.link/…`, `spotify:playlist:…`). BHAAI Music reads Spotify's public embed page, which only lists the **first 100 songs** of a playlist.
  - **Apple Music**: playlists (including shared `pl.u-…` links), albums, and single songs (`music.apple.com/…`). Apple's cover art is kept.
  - Spotify and Apple Music can't stream here, so each song is looked up on YouTube Music. A match must agree on title, artist, and length. Songs with no confident match are skipped, and the import tells you how many. A 100-song playlist takes about 10 seconds.
  - Private playlists can't be read by any of the three. Make them public, or share a link, first. Importing the same link again refreshes that playlist.
- **Downloads are real music files.** Use the download arrow on a song, or **Download all** on a playlist. Each song is saved as `Artist - Title.m4a` in **`C:\Users\<you>\Music\BHAAI Music`**, with the title, artist, album and cover art embedded, so it plays in any music app and can be copied to a phone. Downloaded songs play from that file, even without internet. **Library → Downloads** lists them, shows the folder, and has **Open folder**. The bin deletes the file.
  - Set `BHAAI_MUSIC_DIR` to use a different folder, for example `set BHAAI_MUSIC_DIR=D:\Music\BHAAI Music` before `node server.mjs`.
  - BHAAI Music keeps a small index and the cover images in the folder's `.bhaai` subfolder. If you delete or move a song file yourself, it disappears from Downloads.
  - Older versions kept downloads inside the browser. BHAAI Music moves those into the folder automatically the next time it opens, then frees the browser copy. This needs internet.
- Loved songs, recently played, shuffle, repeat all/one, media keys and lock-screen controls (Media Session), and keyboard shortcuts: Space plays or pauses, `/` searches, Shift+←/→ skips.
- Works on desktop and phone widths.

## Where your data lives

| Data | Storage |
| --- | --- |
| Downloaded songs (`.m4a` with tags) | `Music\BHAAI Music` on this computer, or `BHAAI_MUSIC_DIR` |
| Your own and imported playlists | IndexedDB in this browser (database `svara`) |
| Loved songs, recently played, volume | `localStorage` in this browser |
| Search results and stream URLs | Server memory for 15 minutes and until expiry; never written to disk |

Clearing site data for `localhost:3030` removes playlists, loved songs and history, but not downloaded song files.

## How playback works

1. `server.mjs` keeps one Python worker (`youtube_bridge.py --serve`) running, so ytmusicapi and yt-dlp stay loaded between requests.
2. `GET /api/stream/youtube/:id` asks the worker for a signed `googlevideo.com` audio URL (m4a/AAC), caches it until shortly before it expires, and proxies the bytes. Seeking works through byte ranges. Requests for a whole song still send a range upstream, because Google throttles unranged requests to real-time speed. If a cached URL returns 403, it is resolved again once.
3. `GET /api/art?src=` proxies artwork, but only from YouTube's, Spotify's, and Apple's image hosts. That keeps artwork same-origin, so the page can read its colours and store it offline.
4. `GET /api/playlist?url=` loads YouTube playlists with `YTMusic.get_playlist`. For Spotify and Apple Music links, `playlist_sources.py` reads the public page's embedded JSON (no API keys), then matches each song on YouTube Music using 8 parallel searches. Those pages can change without notice. When an import suddenly fails for every link from one service, that parser needs updating.

yt-dlp needs a JavaScript runtime for YouTube's player challenges. BHAAI Music tells it to use Node.js, which you already have. When YouTube changes something and playback stops working, update the pinned `yt-dlp` version in `requirements.txt` and `Start-Windows.bat`, then run `Setup-Windows.bat`.

Using yt-dlp to stream YouTube audio is outside YouTube's Terms of Service. BHAAI Music is meant for personal use on your own computer. Don't host it publicly.

## Personal server (Oracle Cloud)

`deploy/oracle/setup.sh` installs BHAAI Music on an Ubuntu server behind [Caddy](https://caddyserver.com), which adds HTTPS and a username and password. The app itself still listens only on `127.0.0.1`. Point a domain (a free `*.duckdns.org` name works) at the server, then run `sudo DOMAIN=yourname.duckdns.org bash deploy/oracle/setup.sh` from the cloned repository. Also allow TCP ports 80 and 443 in the instance's Oracle security list. Downloads are saved on the server in `~/Music/BHAAI Music`. YouTube often blocks cloud servers, so playback may fail there even when search works.

## Other providers

The server still has the original Audius and Jamendo adapters (`/api/search?provider=audius|jamendo`, `/api/config`), but the redesigned interface only uses YouTube Music.

## Tests

```sh
npm test
.venv/Scripts/python.exe -m unittest discover -s tests -p "test_*.py"   # macOS/Linux: .venv/bin/python
```

The tests mock every network call. They cover stream proxying and range handling, stream-URL caching and re-resolving, the artwork host allowlist, playlist link parsing (YouTube, Spotify, Apple Music), song matching, result normalisation, and downloads (file naming, tagging calls, range playback, deletion, and path and origin checks).

## Files

- `server.mjs`: local HTTP server, caches, stream/artwork proxies, Audius/Jamendo adapters.
- `downloads.mjs`: saves, lists, serves and deletes downloaded song files.
- `youtube.mjs`: manages the long-lived Python worker.
- `youtube_bridge.py`: ytmusicapi search/playlists, yt-dlp stream resolution, and mutagen tagging of downloads.
- `playlist_sources.py`: Spotify and Apple Music link parsing and YouTube Music matching.
- `dist/index.html`, `dist/styles.css`, `dist/app.js`: the interface.
- `dist/library.js`: playlist storage (IndexedDB) and the downloads API client.
- `Setup-Windows.bat`, `Start-Windows.bat`: Windows setup and launcher.
