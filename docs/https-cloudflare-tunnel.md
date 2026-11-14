# Cloudflare Tunnel (public https, no open ports)

A Cloudflare Tunnel connects your server **outward** to Cloudflare, which then serves your page on a public https
address. You do not forward any router ports, and it works behind carrier-grade NAT (DS-Lite, mobile internet), where
Caddy cannot.

Two flavours:

| | Quick tunnel | Named tunnel |
|---|---|---|
| Account | none | free Cloudflare account |
| Domain | none | a domain added to Cloudflare |
| Address | random `*.trycloudflare.com`, **changes when the tunnel container restarts** | your own, fixed |
| Good for | trying it out, occasional use | everyday use |

## Quick tunnel

```bash
./setup.sh --mode quick-tunnel
```

or by hand:

```bash
docker compose --profile cloudflared up -d
docker compose logs cloudflared | grep trycloudflare.com
```

The log shows a line with `https://<random-words>.trycloudflare.com`. That is your address. Open it, log in with the
TeslaCinema user and password.

Quick tunnels are meant for testing by Cloudflare's own description: no uptime guarantee. It restarts with the server
and gets a **new** address each time, so you have to bookmark the new one in the car. Use a named tunnel to avoid that.

## Named tunnel (fixed address)

You need a free Cloudflare account and a domain whose DNS is managed by Cloudflare (a domain costs a few euros a year;
you can move an existing one to Cloudflare for free).

1. In the Cloudflare dashboard open **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**.
2. Choose **Cloudflared**, give it a name (for example `teslacinema`) and save.
3. On the install page, find the long **token** (the string after `--token`). Copy only the token.
4. In `.env` set:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...your token...
   ```
5. In the tunnel's **Public hostname** tab add a hostname, for example `cinema.example.com`:
   - Service type: **HTTP**
   - URL: **`app:3000`**
6. Start it with the named-tunnel profile (and stop the quick one if it runs):
   ```bash
   docker compose --profile cloudflared-token up -d
   ```
7. Open `https://cinema.example.com`.

To make the choice permanent for plain `docker compose up -d`, set `COMPOSE_PROFILES=cloudflared-token` in `.env`.

## Good to know

- The tunnel container talks to TeslaCinema over Docker's internal network (`app:3000`), so TeslaCinema's own port can
  stay closed (`BIND_ADDRESS=127.0.0.1`, the default).
- TeslaCinema's login (HTTP Basic Auth) stays active behind the tunnel. Keep it that way. Cloudflare Access can add a
  second layer, but then the car's browser has to pass that too, which is more fiddly.
- Cloudflare terms apply to its service, including the rules for what content may be proxied. Read them before you
  run a permanent tunnel.
- WebSocket and long polling both work. TeslaCinema falls back to polling by itself if a WebSocket does not connect.

## Troubleshooting

- **No address shows up:** `docker compose logs cloudflared`. The host needs outbound access to Cloudflare
  (port 7844 TCP/UDP). Some networks block it.
- **Error 502 / 1033:** the tunnel is up but TeslaCinema is not. Check `docker compose ps` and `docker compose logs app`.
- **Named tunnel says the hostname is not routed:** check the *Public hostname* entry (HTTP, `app:3000`) and that the
  tunnel shows as *Healthy* in the dashboard.
