# GPU acceleration (optional)

TeslaCinema works **without** a GPU. A GPU helps Chrome decode and render video, which frees some CPU.

## Requirements

- A Linux host with an Intel or AMD GPU and a `/dev/dri` directory: `ls /dev/dri` shows `card0` and `renderD128`.
- Not available on Docker Desktop for Windows/macOS.
- NVIDIA GPUs are not covered here (the VA-API path is for Intel and AMD).

## Turn it on

```bash
./setup.sh --gpu
```

or by hand, in `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

```bash
docker compose up -d
```

The extra file just passes `/dev/dri` into the container. When `/dev/dri/renderD128` exists, TeslaCinema starts Chrome
with GPU rasterisation and VA-API video decode; without it Chrome falls back to software.

## Check that it is used

```bash
docker compose exec app vainfo --display drm --device /dev/dri/renderD128   # should list the driver and some profiles (VAProfileH264..., VAProfileHEVC...)
```

In the streamed Chrome open `chrome://gpu` and look for "Video Decode: Hardware accelerated".

## Troubleshooting

- **`permission denied` on /dev/dri:** the container runs as root, so this normally works. On some hosts SELinux or AppArmor blocks it: add `security_opt: ["label=disable"]` to the `app` service.
- **Picture glitches with the GPU on:** just remove the GPU file from `COMPOSE_FILE`. Software mode is the default and works everywhere.
- **Proxmox LXC:** pass the render node into the container (`lxc.cgroup2.devices.allow: c 226:* rwm` and `lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir`) before enabling this.
