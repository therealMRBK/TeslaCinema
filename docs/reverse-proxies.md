# Your own reverse proxy

If you already run a reverse proxy that handles https, point it at TeslaCinema. TeslaCinema has its own login, so
**do not** add a second Basic Auth in front of it (two `Authorization` logins on one request conflict).

First decide where TeslaCinema listens:

| Proxy runs... | Set in `.env` |
|---|---|
| on the same machine | `BIND_ADDRESS=127.0.0.1` (default), forward to `http://127.0.0.1:8195` |
| on another machine in your LAN | `BIND_ADDRESS=0.0.0.0`, forward to `http://<docker-host-ip>:8195`, and block port 8195 from the internet |
| as a container in the same Docker network | no published port needed, forward to `http://app:3000` (see Traefik below) |

Start without a front end: `./setup.sh --mode proxy`.

**Two things every proxy must do:**

1. **Do not buffer** responses. Picture and sound are a live stream.
2. Allow **long requests** and **WebSocket upgrades** (the page tries a WebSocket first, and falls back to long polling).

## Nginx Proxy Manager

1. **Hosts → Proxy Hosts → Add Proxy Host.**
2. Domain name: `cinema.example.com`. Scheme `http`, Forward host: IP of the Docker host, Forward port `8195`.
3. Turn on **Websockets Support**. Leave **Access List** on *Publicly Accessible* (TeslaCinema has its own login).
4. **SSL** tab: *Request a new SSL certificate*, tick *Force SSL* and *HTTP/2*.
5. **Advanced** tab, paste:
   ```nginx
   proxy_buffering off;
   proxy_request_buffering off;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   ```
6. Save. Open `https://cinema.example.com`.

If you want NPM's access list to do the login instead of TeslaCinema, set `ALLOW_NO_AUTH=1` and `AUTH_PASSWORD=` in
`.env`. Then keep port 8195 off the internet. This is the less safe option.

## nginx

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name cinema.example.com;
    ssl_certificate     /etc/letsencrypt/live/cinema.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cinema.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8195;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 512m;   # uploads through the file panel
    }
}
```

Get the certificate with Certbot (`sudo certbot --nginx -d cinema.example.com`) if you do not have one.

## Traefik (v2/v3)

Add a `docker-compose.override.yml` next to `docker-compose.yml`. Replace the network name, entrypoint and resolver with
yours:

```yaml
services:
  app:
    ports: !reset []              # no host port needed (Compose 2.24+); remove this line on older versions
    networks: [default, traefik]
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.teslacinema.rule=Host(`cinema.example.com`)
      - traefik.http.routers.teslacinema.entrypoints=websecure
      - traefik.http.routers.teslacinema.tls.certresolver=letsencrypt
      - traefik.http.services.teslacinema.loadbalancer.server.port=3000

networks:
  traefik:
    external: true
```

Traefik streams responses without buffering by default and handles WebSocket upgrades.

## Apache

Enable `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, `mod_rewrite`:

```apache
<VirtualHost *:443>
    ServerName cinema.example.com
    # ... SSLEngine on, certificate lines ...
    ProxyPreserveHost On
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} websocket [NC]
    RewriteRule /(.*) ws://127.0.0.1:8195/$1 [P,L]
    ProxyPass / http://127.0.0.1:8195/ flushpackets=on
    ProxyPassReverse / http://127.0.0.1:8195/
    ProxyTimeout 3600
</VirtualHost>
```

## Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) can publish a local port on a public `*.ts.net` https address:
`tailscale funnel 8195` (with `BIND_ADDRESS=127.0.0.1`). A normal Tailscale connection does **not** help the car, because
the car cannot run a Tailscale client, only Funnel (a public address) does. Keep the TeslaCinema login on.
