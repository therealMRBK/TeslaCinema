# Getting started

The shortest path from nothing to a browser on your car screen. About 10 minutes, most of it waiting for the first build.

## 1. What you need

- An **x86-64 machine that stays on**: mini PC, NAS, home server, VPS, old laptop. (Not a Raspberry Pi: see the [FAQ](faq.md#does-it-run-on-a-raspberry-pi-or-an-apple-silicon-mac).)
- **Docker with Compose v2.** Not installed? [Linux](install-linux.md) · [Windows](install-windows.md) · [macOS](install-macos.md) · [NAS](install-nas.md)
- `git` (or download the repository as a ZIP from GitHub).

## 2. Install

```bash
git clone https://github.com/therealMRBK/TeslaCinema.git
cd TeslaCinema
./setup.sh
```

Answer the question "How should the car reach TeslaCinema?":

| Choose | When |
|---|---|
| **1 - Cloudflare quick tunnel** | You want it working now, with nothing to configure. Recommended start. |
| **2 - Your own domain (Caddy)** | You have a domain and can forward ports 80 and 443 to the machine. |
| **3 - Home network only** | You only want to test from a PC or phone first. Will not work in the car (the car needs https). |
| **4 - I have my own reverse proxy** | You already run nginx, Nginx Proxy Manager or Traefik. See [reverse proxies](reverse-proxies.md). |

At the end the script prints:

```
  Address : https://something-random.trycloudflare.com
  User    : cinema
  Password: Xk3j9...            (also stored in .env)
```

Write the address and password down (the password is also in the `.env` file).

## 3. Test it on a PC or phone

Open the address, log in. You should see a Chrome browser. Click into it, type a web address, press Enter. Open a video
and check that you hear sound (tap the screen once if the page shows "Tap for sound").

## 4. Open it in the car

1. Park the car.
2. Make sure the car has internet (phone hotspot, Wi-Fi or mobile data).
3. Open the car's browser, enter the address, log in.
4. Bookmark it.

More in [Using it in the car](using-in-the-car.md).

## 5. Log in to your services once

Inside the streamed Chrome, sign in to the sites you use. The profile lives in the Docker volume `teslacinema-data`,
so you stay signed in after restarts and updates.

## Next steps

- The quick-tunnel address changes when the tunnel restarts. For a fixed address: [named tunnel](https-cloudflare-tunnel.md#named-tunnel-fixed-address) or [your own domain](https-caddy.md).
- Picture stutters in the car? Lower `AV_BITRATE`: [configuration](configuration.md#picture-quality).
- Have a GPU on the host? [Use it](gpu.md).
- Read [Security](security.md) before you share the address with anyone.
