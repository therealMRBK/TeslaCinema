# Install on macOS

TeslaCinema needs an **x86-64 (amd64)** Linux container because Google Chrome has no Linux arm64 build.

| Mac | Works? |
|---|---|
| Intel Mac | Yes, with Docker Desktop. |
| Apple Silicon (M1/M2/M3/M4) | Only through emulation. Docker Desktop can run amd64 images with Rosetta/QEMU, but a Chrome plus a 1080p software video encoder under emulation is very slow. **Not recommended.** Run TeslaCinema on a small x86 machine or a VPS instead. |

## Intel Mac

1. Install Docker Desktop: <https://www.docker.com/products/docker-desktop/> (or `brew install --cask docker`).
2. Start it once and wait for *Engine running*.
3. In Terminal:
   ```bash
   git clone https://github.com/therealMRBK/TeslaCinema.git
   cd TeslaCinema
   ./setup.sh
   ```

A laptop that sleeps is a poor server: use *System Settings → Battery/Energy* to keep it awake, or use a machine that
stays on.

## Apple Silicon: trying it anyway

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64
./setup.sh --mode lan
```

Expect a slow build and a low frame rate. Lower the load with `AV_FPS=15`, `DISPLAY_WIDTH=1280`, `DISPLAY_HEIGHT=720` and
`AV_BITRATE=2000k` in `.env`. We do not test this setup.
