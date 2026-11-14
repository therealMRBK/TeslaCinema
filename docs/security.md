# Security

TeslaCinema gives whoever reaches it **full control of a web browser that is logged into your accounts**, including its
sound, clipboard and a file folder. Treat it like a remote desktop.

## What is built in

- **Login on everything.** HTTP Basic Auth protects every page, the streams and the WebSocket. Only `/healthz` (which returns the word `ok`) is open.
- **No password, no start.** The server exits with an explanation if `AUTH_PASSWORD` is empty (unless you set `ALLOW_NO_AUTH=1`).
- **Random password.** `./setup.sh` generates 20 random letters and digits.
- **Slow guessing.** A wrong login is answered only after about 0.8 s, and the comparison does not leak timing.
- **Loopback by default.** The container's port is published on `127.0.0.1` only. Nothing is reachable from your LAN or the internet until *you* choose a front end.
- **No terminal, no extra apps.** TeslaCinema contains no shell button and no launcher. The only program on the screen is Chrome.
- **Chrome's debugging port** (9222) listens inside the container only and is not published.

## What you must do

1. **Use https.** Basic Auth sends the password with every request, in clear text apart from the encryption of https. Always use one of the [https options](index.md#make-it-reachable-from-the-car). Plain http (`--mode lan`) is for a quick test on a network you trust.
2. **Keep the password secret and long.** Change it in `.env` (`AUTH_PASSWORD=...`), then `docker compose up -d`.
3. **Do not publish port 8195** to the internet. Keep `BIND_ADDRESS=127.0.0.1` unless a proxy on another machine needs it, and then firewall the port.
4. **Do not stay logged in to things you do not want exposed** in the streamed Chrome. Anyone with the TeslaCinema password can use those sessions.
5. **Keep it updated** ([Updating](updating-and-uninstalling.md)). The image downloads the current Google Chrome on every build, so a rebuild also brings Chrome security fixes.

## Things to know

- Chrome inside the container runs as root with `--no-sandbox` (standard for containers). The container is the isolation boundary: do not run it with `--privileged`, and do not mount anything sensitive into it.
- Everyone who has the password sees and controls the **same** browser window.
- Chrome's cookies and saved logins sit in the Docker volume with only weak protection (`--password-store=basic`, there is no keyring in a container). Protect the host and its backups accordingly.
- The GPU file passes `/dev/dri` into the container. Leave it out if you do not need it.
- There is no rate limit across IP addresses. If you worry about brute force, use a long password and, if you like, a front end that has its own limits (Cloudflare, fail2ban in front of nginx).

## Reporting a problem

See [SECURITY.md](../SECURITY.md).
