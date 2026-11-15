# Changelog

## Unreleased

- Fewer sound and picture dropouts: bigger rate-control buffer (`AV_BUFSIZE`, default `4M`) and larger capture queues
- Chrome no longer starts with the zero-copy / native GPU buffer / VAAPI encoder flags (they crashed the GPU process on one setup)
- The server logs `[av] stream stalled N ms` when the stream pauses

## 1.0.0 - first public release

TeslaCinema grew out of a private remote-browser tool. This is the first standalone, public version.

- Real Google Chrome on a virtual display, streamed with sound as one MPEG-TS stream, WebSocket with long-polling fallback
- Touch and keyboard made for a car screen, including an automatic on-screen keyboard
- **Built-in login** (HTTP Basic Auth) with a generated password; refuses to start without one
- `setup.sh`: one command, random password, picks Cloudflare quick tunnel / Caddy + own domain / LAN / own proxy
- Compose profiles for Caddy and Cloudflare Tunnel, optional GPU file
- Configurable language (`LOCALE`, `CHROME_LANG`)
- Removed from the private tool: the Discord launcher and the terminal button
- Full documentation in `docs/`
- Prominent parked-only / no-use-while-driving disclaimer (README, docs and a confirmation notice on the page itself)
