# TeslaCinema documentation

Start with **[Getting started](getting-started.md)**. Everything else is a reference for a specific step.

## Install Docker and TeslaCinema
- [Linux (Ubuntu, Debian, Fedora, Arch, Proxmox)](install-linux.md)
- [Windows 10/11](install-windows.md)
- [macOS](install-macos.md)
- [NAS and home servers: Unraid, Synology, TrueNAS, Portainer](install-nas.md)

## Make it reachable from the car
The car's browser needs a public **https** address. Pick one:

| Option | Account / domain needed | Open ports | Fixed address | Guide |
|---|---|---|---|---|
| Cloudflare quick tunnel | none | none | no (changes on restart) | [guide](https-cloudflare-tunnel.md) |
| Cloudflare named tunnel | free Cloudflare account + a domain | none | yes | [guide](https-cloudflare-tunnel.md#named-tunnel-fixed-address) |
| Caddy | a domain (a free DuckDNS name works) | 80 and 443 | yes | [guide](https-caddy.md) |
| Your own reverse proxy | a domain | 443 | yes | [guide](reverse-proxies.md) |

## Use and tune
- [Using it in the car](using-in-the-car.md)
- [Configuration reference](configuration.md)
- [GPU acceleration](gpu.md)
- [Security](security.md)

## When something is wrong
- [Troubleshooting](troubleshooting.md)
- [FAQ](faq.md)
- [Updating and uninstalling](updating-and-uninstalling.md)

## Under the hood
- [How it works](how-it-works.md)
