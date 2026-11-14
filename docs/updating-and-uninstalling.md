# Updating and uninstalling

## Update

```bash
cd TeslaCinema
git pull
docker compose up -d --build
```

`--build` rebuilds the image, which also downloads the **current Google Chrome**. Your settings (`.env`) and your logins
(Docker volume) stay untouched.

If a new version added a variable to `.env.example`, add it to your `.env` by hand (git never touches `.env`).

Rebuild without cache (to force a fresh Chrome and fresh packages):

```bash
docker compose build --no-cache && docker compose up -d
```

Clean up old images afterwards: `docker image prune -f`.

### Chrome gets old between rebuilds
Chrome inside the running container does not update itself. Rebuild from time to time (for example monthly) to get
security updates.

## Stop and start

```bash
docker compose stop        # stop, keep everything
docker compose start
docker compose restart app
docker compose down        # remove the containers, keep the data volume
```

## Change the password

Edit `AUTH_PASSWORD` in `.env`, then `docker compose up -d`. Update the saved password in the car's browser.

## Uninstall completely

```bash
docker compose down -v --rmi local     # containers, the data volume (all Chrome logins!) and the built image
cd .. && rm -rf TeslaCinema
```

Leave out `-v` to keep your Chrome profile.
