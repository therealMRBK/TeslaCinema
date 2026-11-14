# Contributing

Thanks for helping! Bug reports, setup experience reports (especially from real cars), docs fixes and pull requests are all welcome.

## Reporting problems

Use the issue templates. For a bug please include the host (CPU, OS, Docker version), `docker compose logs --tail 200 app`
and the status line from the bottom right of the page. **Never paste your `.env`, password or tunnel token.**

## Development

```bash
git clone https://github.com/therealMRBK/TeslaCinema.git && cd TeslaCinema
cp .env.example .env            # set AUTH_PASSWORD, BIND_ADDRESS=0.0.0.0 for LAN testing
docker compose up -d --build
docker compose logs -f app
```

The page and the server are plain files without a build step: edit `app/server.js` or `app/static/index.html`,
then `docker compose up -d --build` (the image copies `app/`). To iterate faster, bind-mount `./app` over `/app` in a
`docker-compose.override.yml` and `docker compose restart app`.

Checks that CI runs and you can run locally:

```bash
node --check app/server.js
shellcheck setup.sh
docker compose config -q
docker build -t teslacinema:test .
```

## Pull requests

- Keep them focused; describe what and why. Screenshots help for UI changes.
- Keep the defaults safe: the login must stay on, ports stay on loopback by default.
- No third-party trackers, no phone-home code.
- Docs matter: update `docs/` and `README.md` when behaviour changes, and add a line to `CHANGELOG.md`.
- By contributing you agree that your contribution is licensed under the project's MIT license.

## Ideas that would help

- Reports and measurements from real cars and other in-car browsers
- Translations of the docs
- Guides for more platforms and proxies
- A pre-built multi-arch-free (amd64) image on a registry
