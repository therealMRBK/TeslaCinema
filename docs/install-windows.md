# Install on Windows 10 / 11

TeslaCinema runs in a **Linux container**. On Windows that means Docker Desktop with the WSL 2 backend.
The machine has to be on whenever you want to use it in the car, so a small always-on PC or a Linux server is a better
home for it than a laptop. It works fine for trying things out.

## 1. Install Docker Desktop

1. Download it from <https://www.docker.com/products/docker-desktop/> and install it with the **WSL 2** option ticked.
2. Start Docker Desktop and wait until it says *Engine running*.
3. In a PowerShell window:
   ```powershell
   docker --version
   docker compose version
   ```
4. Make sure Docker Desktop is in **Linux containers** mode (the default). In *Settings → General*, tick
   *Start Docker Desktop when you sign in*.

## 2. Get TeslaCinema

Install Git (<https://git-scm.com/download/win>) or download the repository as a ZIP from GitHub and unpack it.

```powershell
git clone https://github.com/therealMRBK/TeslaCinema.git
cd TeslaCinema
```

## 3a. With the setup script (recommended)

The script is written in bash. Run it from **Git Bash** (installed with Git for Windows) or from a WSL terminal:

```bash
./setup.sh
```

## 3b. By hand in PowerShell (no bash needed)

```powershell
Copy-Item .env.example .env
# make a random password and show it:
$pw = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 20 | ForEach-Object {[char]$_})
(Get-Content .env) -replace '^AUTH_PASSWORD=.*', "AUTH_PASSWORD=$pw" | Set-Content .env
$pw
# BIND_ADDRESS=0.0.0.0 in .env lets other devices on your network reach it (plain http, for testing)
docker compose up -d --build
```

For a public https address in the car, add a profile:

```powershell
docker compose --profile cloudflared up -d
docker compose logs cloudflared        # look for https://....trycloudflare.com
```

(or follow [Caddy](https-caddy.md) / [reverse proxies](reverse-proxies.md)).

## Notes for Windows

- **No GPU passthrough.** Docker Desktop does not hand `/dev/dri` to containers, so TeslaCinema runs in software. That is
  fine, see [GPU](gpu.md).
- **Windows Firewall.** If you open it on your LAN (`BIND_ADDRESS=0.0.0.0`), Windows may ask to allow Docker Desktop.
- **Sleep.** Turn off sleep/hibernate while you want to use it in the car.
- Line endings: if `./setup.sh` complains about `\r`, run `git config core.autocrlf false`, re-clone, and try again.
