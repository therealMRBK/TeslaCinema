# How it works

A short tour for the curious and for contributors. Source: `app/server.js` (server), `app/static/index.html` (page),
`app/xhelper.c` (mouse helper), `Dockerfile`.

## The pieces inside the container

- **Xvfb** is a virtual X11 screen. **Fluxbox** is a minimal window manager (no title bars, no toolbar).
- **Google Chrome** runs on that screen, launched like any desktop app: no automation flags, no Playwright. That is why
  logins, extensions and DRM (Widevine) behave normally.
- **PulseAudio** (system mode) provides a virtual sound card `chrome_out`: Chrome's default output. A second virtual
  device, `virtmic`, is the microphone.
- **ffmpeg** captures the screen (`x11grab`) and the monitor of `chrome_out` **in one process**.
- **Node.js (Express + ws)** serves the page, checks the login, hands out the stream and takes input.
- **xhelper** is a small X client (XTest) for mouse input and the pointer shape; **xdotool** types and sends key combinations.

## Picture and sound as one stream

One ffmpeg process writes **MPEG-TS**: MPEG-1 video + MP2 audio. Because both come from one process and one clock,
they carry timestamps that belong together. The server keeps about 4 seconds of chunks and cuts them only at packet
boundaries; if a viewer is more than `AV_MAX_BEHIND_MS` behind it jumps to the newest keyframe (a "GOP").

The page decodes with [JSMpeg](https://github.com/phoboslab/jsmpeg) into a canvas (WebGL) and plays the sound through Web
Audio. The **sound is the clock**: a picture is shown when the sound has reached its moment. No `<video>` element is
involved, which makes the page independent of what the car browser can decode.

**Transport:** the page first tries a WebSocket (`/avws`, pushed by the server, the lowest delay). If it does not
open within 3 seconds twice, it uses **HTTP long polling** (`/av?after=<seq>`): one request in flight, answered with
everything newer. Polling never lets frames pile up in a proxy, which is the failure mode of long streaming responses.

Two older paths stay in the code for non-car browsers: H.264 over WebCodecs (`?mode=h264`) and JPEG (`?mode=jpeg`).

## Input

The page collects touch and keyboard events and sends them as batches with a single `POST /input` in flight, so input
can never queue up behind a slow connection (mouse moves are merged to the newest position, typed characters into one
string). Touch is translated to mouse: tap = click, drag = wheel, hold = right click.

**The car keyboard:** the server asks Chrome, over its local debugging port, whether a text field has focus (one
`Runtime.evaluate` per tab, no domains enabled, nothing injected). The page focuses or blurs a hidden input, which makes
the car's on-screen keyboard appear and disappear on its own.

**Resize:** the virtual screen is switched with a real `xrandr` mode to the size of the viewing window, so the picture
is never scaled by CSS.

## The login

`authorized()` in `server.js` checks HTTP Basic Auth with timing-safe comparisons of SHA-256 digests. It guards every
Express route except `/healthz`, and the WebSocket upgrade is checked separately because upgrades bypass Express.

## Measured numbers

From the author's tests with desktop Chrome as the viewer on a local network (not a car):

| | Result |
|---|---|
| Picture against sound | within about −60…+30 ms |
| Tap to changed picture | about 120-240 ms over WebSocket, 150-390 ms with sound sync over polling |
| CPU | around 40 % of one core, 550 MB RAM at 720p30 with a video playing (one viewer) |

Numbers on mobile data depend on that connection. If you measure in a car, please share it in an issue.
