# Third-party components

## ytmusicapi

- Repository: https://github.com/sigma67/ytmusicapi
- Version: 1.12.3, installed from its published Python package
- License: MIT — https://github.com/sigma67/ytmusicapi/blob/main/LICENSE
- Use: `youtube_bridge.py` calls `YTMusic.search` and `YTMusic.get_playlist` for public catalog data.

## yt-dlp

- Repository: https://github.com/yt-dlp/yt-dlp
- Version: 2026.8.19 with the `default` extra (includes yt-dlp-ejs)
- License: Unlicense — https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE
- Use: `youtube_bridge.py` calls `YoutubeDL.extract_info(download=False)` to resolve an audio-only stream URL. Nothing is written to disk by yt-dlp.

## Fonts

Bricolage Grotesque and Figtree, loaded from Google Fonts (SIL Open Font License). System fonts are used when offline.

## mutagen

- Repository: https://github.com/quodlibet/mutagen
- Version: 1.48.1
- License: GPL-2.0-or-later — https://github.com/quodlibet/mutagen/blob/main/COPYING
- Use: `youtube_bridge.py` writes title, artist, album and cover art into downloaded `.m4a` files.
