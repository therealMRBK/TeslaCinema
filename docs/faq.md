# FAQ

### What is this?
A real Google Chrome that runs on your own server, streamed with its sound to a browser, built for the browser in a car.
You use the car's touchscreen as the screen, mouse and keyboard of that Chrome.

### Why not just use the car's own browser?
The car's browser is limited: some sites refuse it, some players do not work, and features like extensions or your
saved sessions are missing. Chrome on a server is a normal desktop Chrome, so what plays on your PC plays here.
The car browser only has to show a canvas and play Web Audio.

### Why a server at all? Why not mirror my phone?
A server is always on, has a fast, stable connection, and does not drain your phone. It also keeps your logins.

### Is it legal?
TeslaCinema is a remote-browser tool, like any remote desktop. It does not remove or circumvent any protection. What you
may watch and where is governed by the law where you are and the terms of the services you use: that is your responsibility.
**Never use it while driving: in the EU this is prohibited by national road traffic laws, and it is dangerous. Parked only.**

### Is it safe to put on the internet?
It is built for that: login on everything, no start without a password, loopback by default. Use https and a long password.
Read [Security](security.md).

### Does it run on a Raspberry Pi or an Apple Silicon Mac?
Not in a supported way. The image uses **Google Chrome**, and Google does not publish Chrome for Linux/arm64.
(Chromium on arm64 would work technically, but it ships without Widevine, so protected video would not play.)
Use a small x86-64 machine: a used mini PC costs about as much as a Pi, a VPS works too.
On Apple Silicon you can emulate amd64 but it is slow, see [macOS](install-macos.md).

### How much bandwidth does it use?
By default about **3.5 Mbit/s** while someone watches (≈ 1.5 GB per hour). When nobody has the page open, no video is
encoded and nothing is sent. Lower it with `AV_BITRATE`. Your server needs at least that much **upload**, and the car
at least that much download.

### How much CPU does it need?
Plan for 2 or more cores. A GPU is optional and helps only a little: see [GPU](gpu.md) and
[Configuration](configuration.md#picture-quality).

### Can I use it from a phone, tablet or TV?
Yes. Any browser with canvas and Web Audio works.

### Can two people use it at once?
They share **one** screen: both see and control the same Chrome window. There is no multi-user mode.

### Will my logins survive a restart or update?
Yes, they are in the Docker volume `teslacinema-data`. They are lost only if you delete the volume
(`docker compose down -v`).

### Can I change the language?
Yes: `LOCALE` and `CHROME_LANG` in `.env`, see [Configuration](configuration.md#language).

### Does it work with a VPN on the server?
Yes, if the server can still be reached on your https address. A VPN on the server changes the IP that streaming sites see.

### Does it need WebSockets?
No. The page tries a WebSocket first for the lowest delay and **falls back to HTTP long polling** by itself if a
WebSocket cannot be opened (some networks and proxies block them). Both are covered by the login.

### The address of the quick tunnel keeps changing.
Yes, that is how Cloudflare quick tunnels work. Use a [named tunnel or your own domain](index.md#make-it-reachable-from-the-car).

### Why is it called TeslaCinema?
Because it was built for the browser in a Tesla. It is independent and not affiliated with Tesla, Inc. The name only says
what the project is for.

### Can I contribute?
Yes. See [CONTRIBUTING.md](../CONTRIBUTING.md).
