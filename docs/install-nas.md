# NAS and home servers

TeslaCinema is one Docker Compose project, so anything that can run Compose with an **x86-64 CPU** can host it.
ARM-based NAS models (many entry-level Synology, QNAP and Raspberry-Pi-class boxes) cannot: Google Chrome has no arm64 build for Linux.

## Portainer (any host)

1. **Stacks → Add stack → Repository.**
2. Repository URL: `https://github.com/therealMRBK/TeslaCinema`, reference `refs/heads/main`, compose path `docker-compose.yml`.
3. Under **Environment variables** add at least:
   ```
   AUTH_USER=cinema
   AUTH_PASSWORD=<a long random password>
   BIND_ADDRESS=0.0.0.0
   COMPOSE_PROFILES=cloudflared
   ```
   Use `COMPOSE_PROFILES=caddy` plus `DOMAIN=...` for a domain, or leave it empty if you use your own reverse proxy.
   The full list is in [Configuration](configuration.md).
4. **Deploy the stack.** Portainer builds the image on the host (a few minutes the first time).
5. For the quick-tunnel address open the `teslacinema-tunnel` container's **Logs**.

## Unraid

Install the **Docker Compose Manager** plugin from Community Applications, then:

1. *Docker → Compose → Add new stack*, name it `teslacinema`.
2. Put the repository on a share, for example `/mnt/user/appdata/teslacinema` (`git clone` in the Unraid terminal).
3. *Edit stack → Compose file*: use the repository's `docker-compose.yml`; *Edit stack → ENV file*: paste your `.env`
   (create it with `./setup.sh --mode proxy` from that folder, or copy `.env.example` and set `AUTH_PASSWORD`).
4. Press **Compose up**.

The data volume is a normal Docker volume; Unraid keeps it in its Docker image.

## Synology (DSM 7.2+, Intel/AMD models)

1. Install **Container Manager** from Package Center. Check that your model is x86-64 (Plus-series DS-Models mostly are).
2. Copy the repository to the NAS, for example `/volume1/docker/teslacinema` (download the ZIP from GitHub and unpack it
   with File Station, or `git clone` over SSH).
3. In the folder, create `.env` from `.env.example` and set `AUTH_PASSWORD`.
4. Container Manager → **Project → Create**: project name `teslacinema`, path = that folder, source *Use existing docker-compose.yml*.
5. Start it. The first build takes a while on a NAS.
6. For https use the quick tunnel (`COMPOSE_PROFILES=cloudflared` in `.env`) or Synology's built-in
   **Login Portal → Reverse Proxy** pointing at `localhost:8195` (set *Custom header → WebSocket* and turn off buffering if offered).

## TrueNAS SCALE

Use *Apps → Discover Apps → Custom App → Install via YAML*, paste the content of `docker-compose.yml`, put the variables
from your `.env` in as literals, and give the app at least 2 CPU cores and 2 GB RAM. (The `build:` section does not work in
the custom app form: build the image once on any Docker host and push it to a registry you control, or run TeslaCinema in
a small VM instead.)

## Proxmox / virtualisation

A small Debian or Ubuntu **VM** with 2 cores and 2-4 GB RAM is the simplest. Then follow the [Linux guide](install-linux.md).

## Raspberry Pi

Not supported, see the [FAQ](faq.md#does-it-run-on-a-raspberry-pi-or-an-apple-silicon-mac).
