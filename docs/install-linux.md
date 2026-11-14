# Install on Linux

TeslaCinema runs on any x86-64 Linux with Docker. The steps below use the official Docker packages.

## 1. Install Docker Engine and Compose

### Ubuntu / Debian (the easy way)

Docker's convenience script installs the engine and the Compose plugin:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # lets you run docker without sudo
```

Log out and back in (or run `newgrp docker`), then check:

```bash
docker --version
docker compose version               # must print v2.x
```

Prefer the distribution's repository instead of a script? Follow the official guide for your distribution:
<https://docs.docker.com/engine/install/>.

### Fedora / RHEL family

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

### Arch

```bash
sudo pacman -S docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

## 2. Install TeslaCinema

```bash
sudo apt-get install -y git          # or: dnf install git / pacman -S git
git clone https://github.com/therealMRBK/TeslaCinema.git
cd TeslaCinema
./setup.sh
```

## Proxmox

Use a **VM** (Debian or Ubuntu) and follow the steps above. That is the least surprising option.

An LXC container also works if you enable nesting for Docker: in the container's *Options → Features* tick
`Nesting` (and `keyctl`), use a privileged or well-configured unprivileged container, and give it at least 2 cores and
2 GB RAM. For a GPU in an LXC see [GPU](gpu.md).

## Start on boot

The containers use `restart: unless-stopped`, and Docker starts on boot (`sudo systemctl enable docker`), so TeslaCinema
comes back by itself after a reboot.

## Firewall

- Quick tunnel / named tunnel: nothing to open, the connection goes outward.
- Caddy: open TCP **80** and **443**.
- Your own reverse proxy: open **443** there, and keep port 8195 closed to the internet.

On Ubuntu with `ufw`: `sudo ufw allow 80,443/tcp`.

> Docker publishes ports by editing the firewall itself and bypasses `ufw` rules for published ports. TeslaCinema's
> port is bound to `127.0.0.1` by default for exactly this reason. Only set `BIND_ADDRESS=0.0.0.0` if you want it on
> your LAN and the machine is not exposed to the internet.
