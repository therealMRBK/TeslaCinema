# Using TeslaCinema in the car

> **Parked only.** Do not use it while driving. You are responsible for following the law where you are.

## Before you go

- Test the address on a phone or PC first. Log in, open a site, play a video, check the sound.
- Sign in to your streaming services inside the streamed Chrome once. They stay signed in (Docker volume).
- Make sure the server stays on and the stream address will not change: use a [named tunnel](https-cloudflare-tunnel.md#named-tunnel-fixed-address) or [your own domain](https-caddy.md).

## In the car

1. Park, and make sure the car has internet: phone hotspot, Wi-Fi, or the car's own mobile data connection.
2. Open the car's **web browser**.
3. Type the address of your TeslaCinema (`https://...`). The car shows its own login box: enter the user name and the
   password from `.env`. (Let the browser remember them if it offers to.)
4. Bookmark the page so you do not have to type it again.

You now see a Chrome window. The page makes the virtual screen the same size as the browser window, so it fills the
screen edge to edge.

## Controls

| Gesture | What it does |
|---|---|
| **Tap** | Click |
| **Drag** one finger | Scroll (the page moves with your finger) |
| **Two fingers** | Scroll |
| **Press and hold** | Right click |

Buttons in the top-right corner:

| Button | What it does |
|---|---|
| 📁 | Files: upload a file into the shared folder, download files Chrome saved |
| 📋 | Clipboard: fetch text from the remote Chrome or send yours to it |
| 🎤 | Send this device's microphone to the remote Chrome |
| 🔊 | Mute or unmute the stream sound (the page also shows **Tap for sound** if the browser needs a tap before it may play audio) |
| ⌨️ | Show or hide the car's on-screen keyboard |

The keyboard opens **by itself** when you tap a text field in the remote Chrome and closes again when you leave it. The
⌨️ button is there if you want it manually.

The small grey line at the bottom right shows the stream: transport (WebSocket or polling), frames per second and
Mbit/s.

## Tips

- **Video fullscreen:** use the player's fullscreen button (or press `F11` in the remote Chrome with the ⌨️ keyboard).
- **Better picture on a weak connection:** lower `AV_BITRATE` (see [Configuration](configuration.md#picture-quality)).
- **Sound out of step or missing:** tap once on the screen. See [Troubleshooting](troubleshooting.md).
- **Several people:** the remote Chrome is **one** shared screen. Everyone who opens the page sees and controls the
  same window.

## Other browsers

Anything that can show a canvas and play Web Audio can use it: a phone, a tablet, a TV browser, another car.
It is not Tesla-specific except in its defaults.
