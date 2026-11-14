# Third-party software

TeslaCinema itself is MIT-licensed ([LICENSE](LICENSE)). It includes, downloads or depends on:

| Component | How | License |
|---|---|---|
| [JSMpeg](https://github.com/phoboslab/jsmpeg) by Dominic Szablewski | `app/static/jsmpeg.min.js`, shipped in the repository | MIT |
| [Express](https://expressjs.com), [multer](https://github.com/expressjs/multer), [ws](https://github.com/websockets/ws) | npm dependencies, installed at build time | MIT |
| [Node.js](https://nodejs.org) | base image `node:22-bookworm` | MIT and others |
| [FFmpeg](https://ffmpeg.org) | Debian package at build time | LGPL/GPL (see Debian) |
| Xvfb, Fluxbox, xdotool, xclip, PulseAudio | Debian packages at build time | various open-source licenses |
| [Google Chrome](https://www.google.com/chrome/) | **downloaded from Google at image build time**, not redistributed by this repository | Google Chrome Terms of Service, proprietary |
| [Caddy](https://caddyserver.com), [cloudflared](https://github.com/cloudflare/cloudflared) | optional images pulled by the compose profiles | Apache-2.0 |

Building the image means you accept the licenses of the packages it downloads, in particular the Google Chrome Terms of
Service. Chrome includes Widevine, a content decryption module licensed by Google.

"Tesla" is a trademark of Tesla, Inc. TeslaCinema is an independent project, not affiliated with, authorised or endorsed by Tesla, Inc.
