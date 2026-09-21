# Third-party components

## ytmusicapi

- Repository: https://github.com/sigma67/ytmusicapi
- Version: 1.12.3, installed from its published Python package
- License: MIT — https://github.com/sigma67/ytmusicapi/blob/main/LICENSE
- Use: `music.py` calls `YTMusic.search` and `YTMusic.get_playlist` without an account, for public catalog data.

## yt-dlp

- Repository: https://github.com/yt-dlp/yt-dlp
- Version: 2026.8.19 with the `default` extra (includes yt-dlp-ejs)
- License: Unlicense — https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE
- Use: `audio.py` calls `YoutubeDL.extract_info` to resolve an audio-only stream URL, and to download that audio into a temporary folder for MP3 conversion. The temporary files are deleted after each download.

## imageio-ffmpeg / FFmpeg

- Repository: https://github.com/imageio/imageio-ffmpeg (BSD-2-Clause); bundles an FFmpeg build (https://ffmpeg.org, GPL/LGPL depending on build)
- Version: 0.6.0
- Use: `audio.py` runs ffmpeg with libmp3lame to convert audio to MP3 and embed tags and cover art. A system ffmpeg on PATH is used first.

## Fonts

Bricolage Grotesque and Figtree, loaded from Google Fonts (SIL Open Font License). System fonts are used when they can't load.
