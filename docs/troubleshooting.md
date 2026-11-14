# Troubleshooting

First look at the logs: `docker compose logs --tail 100 app`

## It does not start

| Symptom | Cause and fix |
|---|---|
| `AUTH_PASSWORD is not set` | Run `./setup.sh`, or set `AUTH_PASSWORD` in `.env` |
| `docker compose` says `Run ./setup.sh first` | No `.env` yet: `./setup.sh` |
| Build fails while downloading Chrome | Check the host's internet access. Chrome comes from `dl.google.com` |
| `exec format error` | The host is not x86-64 (arm64). See the [FAQ](faq.md#does-it-run-on-a-raspberry-pi-or-an-apple-silicon-mac) |
| `no such device /dev/dri` | You enabled the GPU file on a host without a GPU. Remove `docker-compose.gpu.yml` from `COMPOSE_FILE` |
| `port is already allocated` | Change `HOST_PORT` in `.env` |
| Container `unhealthy` for a long time | `docker compose logs app`. Often the host is too small (2+ cores, 2 GB RAM) |

## I cannot reach it

| Symptom | Cause and fix |
|---|---|
| Works on `localhost`, not from another device | The port is bound to loopback. Use a tunnel / Caddy, or set `BIND_ADDRESS=0.0.0.0` for a LAN test |
| Works on my Wi-Fi, not in the car | The car is outside your network and needs a public **https** address: [options](index.md#make-it-reachable-from-the-car) |
| Quick-tunnel address does not work any more | It changed after a restart: `docker compose logs cloudflared \| grep trycloudflare` |
| Browser warns about the certificate | You are using `http://` or an address without a valid certificate. Use the https front end |
| Asks for the password again and again | Wrong user name or password. Check `.env`. If a reverse proxy also has a login, remove that one |
| Caddy gets no certificate | [Caddy troubleshooting](https-caddy.md#troubleshooting) |

## Picture problems

| Symptom | Fix |
|---|---|
| Stutters, freezes, jumps ahead | The line is too slow: lower `AV_BITRATE` (try `2000k`, then `1500k`) |
| The picture lags more and more | A proxy is buffering. Turn buffering off ([reverse proxies](reverse-proxies.md)). The status line at the bottom right shows whether it runs as WebSocket or polling |
| Black screen | Wait a few seconds after the start (Chrome is starting). Then reload the page. `docker compose logs app` |
| Garbled or torn picture | Try another browser to see whether it is the viewer. Software mode (no GPU file) is the most compatible |
| Blurry text | Raise `AV_BITRATE` and match `DISPLAY_*` to the viewer's size |
| Chrome window smaller than the screen / bars | Reload the page: it resizes the virtual screen to the browser window |

## Sound problems

| Symptom | Fix |
|---|---|
| No sound | Tap the screen once (browsers need a tap before they play audio, the page shows **Tap for sound**). Check the 🔊 button is on, and the car's volume |
| Sound but no picture changes | Reload. If only polling works the stream is slower: look at the status line |
| Sound drifts from the picture | Reload the page. If it keeps happening the connection is unstable; lower `AV_BITRATE` |
| Site says "no sound output" | Wait a moment: Chrome's audio device (a virtual PulseAudio sink) appears when the container starts. `docker compose restart app` |

## Input problems

| Symptom | Fix |
|---|---|
| Keyboard does not appear | Tap into a text field in the remote Chrome, or press ⌨️ |
| Special characters (umlauts, accents) do not type | The container needs a UTF-8 locale: check `LOCALE` in `.env` |
| Clicks land in the wrong place | Reload the page so the virtual screen matches the window size |

## Streaming sites

| Symptom | Fix |
|---|---|
| "Playback error" / protected video does not play | The site checks your hardware or browser. Try another site; check `chrome://components` for *Widevine Content Decryption Module* (click "Check for update") |
| The site wants a login again and again | The profile must persist: do not use `docker compose down -v`, it deletes the volume |
| "Unusual traffic" / CAPTCHA | The site sees your *server's* IP address, not the car's. A data-centre IP is more often challenged than a home IP |

## Still stuck?

Open an [issue](https://github.com/therealMRBK/TeslaCinema/issues) with: your host (CPU, OS, Docker version),
`docker compose logs --tail 200 app`, the status line text from the page, and what the car/browser is. **Do not paste
your `.env` or password.**
