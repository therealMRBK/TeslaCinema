# Your own domain with Caddy (automatic https)

[Caddy](https://caddyserver.com) is a web server that gets and renews a free Let's Encrypt certificate by itself.
TeslaCinema ships a ready-made `caddy` profile.

## What you need

1. A **domain name** that points at your home or server IP.
   No domain? A free name from [DuckDNS](https://www.duckdns.org) (`yourname.duckdns.org`) works.
2. Your machine reachable from the internet on **TCP 80 and 443**.
   - At home: forward these two ports on your router to the machine that runs Docker.
   - Behind CGNAT / DS-Lite (no public IPv4)? Port forwarding cannot work. Use a [Cloudflare tunnel](https-cloudflare-tunnel.md) instead.
3. The DNS record: an **A** record (and **AAAA** for IPv6) from the name to your public IP.
   With a changing home IP use dynamic DNS (DuckDNS, your router's DDNS, or a Cloudflare DDNS updater).

## Set it up

```bash
./setup.sh --mode domain --domain cinema.example.com
```

or by hand, in `.env`:

```
DOMAIN=cinema.example.com
COMPOSE_PROFILES=caddy
```

```bash
docker compose up -d --build
docker compose logs -f caddy      # wait for "certificate obtained successfully"
```

Open `https://cinema.example.com`.

## How it works

`deploy/Caddyfile` contains:

```
{$DOMAIN} {
	reverse_proxy app:3000 {
		flush_interval -1
	}
}
```

`flush_interval -1` turns buffering off, which matters because picture and sound arrive as a stream. WebSocket upgrades
are handled by Caddy automatically.

## Troubleshooting

- **Certificate not issued:** `docker compose logs caddy`. The usual causes: the DNS name does not point at you yet, port
  80 is not forwarded (Let's Encrypt validates over port 80), or another web server already uses 80/443 on the host.
  Let's Encrypt has rate limits: wait an hour after repeated failures.
- **Another program already uses 80/443** (a NAS web UI, another proxy): put TeslaCinema behind *that* proxy instead:
  [reverse proxies](reverse-proxies.md).
- **Works at home, not from the car:** the car is outside your network. Test from your phone with Wi-Fi switched off.
- **Router "NAT loopback":** some routers cannot reach their own public address from inside. Test from mobile data.
