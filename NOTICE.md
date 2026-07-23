# Third-party components bundled with Lazy Music

Lazy Music uses helper binaries in `server/bin/` (fetched/updated at setup).
They are redistributed under their own permissive licenses:

- **Deno** (`deno.exe`) — JavaScript/TypeScript runtime for the audio helper.
  MIT License — see [`licenses/deno-LICENSE.txt`](licenses/deno-LICENSE.txt).
  https://github.com/denoland/deno
- **yt-dlp** (`yt-dlp.exe`) — downloads YouTube audio locally on the GM's machine.
  The Unlicense (public domain) — see [`licenses/yt-dlp-LICENSE.txt`](licenses/yt-dlp-LICENSE.txt).
  https://github.com/yt-dlp/yt-dlp

Lazy Music itself is MIT-licensed (see [`LICENSE`](LICENSE)).

**No audio content is bundled or distributed.** Music/audio is downloaded
locally on the GM's own machine at runtime and is never included in this
repository or in any release archive. Cookies and downloaded cache are excluded
from version control.
