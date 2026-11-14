#!/usr/bin/env bash
# TeslaCinema setup: checks Docker, creates .env with a random password, picks how the car will reach it, starts it.
#
#   ./setup.sh                      asks a few questions
#   ./setup.sh --mode quick-tunnel  no questions: free Cloudflare quick tunnel (https URL, nothing to configure)
#   ./setup.sh --mode domain --domain cinema.example.com
#   ./setup.sh --mode lan           plain http on your home network (test from a PC/phone first)
#   ./setup.sh --mode proxy         you bring your own reverse proxy (nginx, NPM, Traefik, ...)
# Extra: --gpu (pass /dev/dri through), --no-gpu, --yes (accept defaults), --help
set -euo pipefail
cd "$(dirname "$0")"

MODE=""; DOMAIN_ARG=""; GPU=""; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --domain) DOMAIN_ARG="${2:-}"; shift 2 ;;
    --gpu) GPU=1; shift ;;
    --no-gpu) GPU=0; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it first: https://docs.docker.com/engine/install/  (see docs/install-linux.md)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing ('docker compose' must work). See docs/install-linux.md"
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Is it running, and are you in the 'docker' group (or use sudo)?"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) warn "This machine is $(uname -m). TeslaCinema needs an x86-64 (amd64) host: Google Chrome has no Linux arm64 build." ;;
esac

# --- .env helpers ------------------------------------------------------------------------------------------------
[ -f .env ] || { cp .env.example .env; say "Created .env"; }
get_env() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- || true; }
set_env() { # set_env KEY VALUE (replaces the line, or appends it)
  local k="$1" v="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^$k=" .env > "$tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"
}
ask() { # ask "question" default -> answer
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then echo "$2"; return; fi
  local a; read -r -p "$1 [$2] " a || true; echo "${a:-$2}"
}

# --- login -------------------------------------------------------------------------------------------------------
PASS="$(get_env AUTH_PASSWORD)"
if [ -z "$PASS" ] || [ "$PASS" = "change-me-to-something-long" ]; then
  PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)"
  set_env AUTH_PASSWORD "$PASS"
  say "Generated a random password"
fi
USER_NAME="$(get_env AUTH_USER)"; USER_NAME="${USER_NAME:-cinema}"

# --- how will the car reach it? ----------------------------------------------------------------------------------
if [ -z "$MODE" ]; then
  cat <<'MENU'

How should the car reach TeslaCinema? The car browser needs a public https address.

  1) Cloudflare quick tunnel  - easiest. Free, no account, no domain, no port forwarding. The address changes
                                 when the container restarts (fine to start with).
  2) My own domain (Caddy)    - automatic https certificate. Needs a domain pointing at this machine and
                                 ports 80 + 443 forwarded to it.
  3) Home network only (http) - first test from a PC or phone on your Wi-Fi. Will NOT work in the car.
  4) I already have a reverse proxy (nginx / Nginx Proxy Manager / Traefik ...)
MENU
  c="$(ask "Choose 1-4" 1)"
  case "$c" in 1) MODE=quick-tunnel ;; 2) MODE=domain ;; 3) MODE=lan ;; 4) MODE=proxy ;; *) die "Please answer 1, 2, 3 or 4" ;; esac
fi

PROFILES=""
case "$MODE" in
  quick-tunnel) PROFILES="cloudflared"; set_env BIND_ADDRESS 127.0.0.1 ;;
  domain)
    D="${DOMAIN_ARG:-$(get_env DOMAIN)}"
    [ -n "$D" ] || D="$(ask "Your domain (e.g. cinema.example.com)" "")"
    [ -n "$D" ] || die "A domain is required for this mode"
    set_env DOMAIN "$D"; PROFILES="caddy"; set_env BIND_ADDRESS 127.0.0.1
    warn "Make sure $D points to this machine and ports 80 and 443 are forwarded to it (docs/https-caddy.md)."
    ;;
  lan) set_env BIND_ADDRESS 0.0.0.0 ;;
  proxy) set_env BIND_ADDRESS 127.0.0.1 ;;
  *) die "Unknown mode '$MODE' (use quick-tunnel, domain, lan or proxy)" ;;
esac

# --- GPU ---------------------------------------------------------------------------------------------------------
FILES="docker-compose.yml"
if [ -z "$GPU" ]; then
  if [ -e /dev/dri/renderD128 ]; then
    [ "$(ask "A GPU was found (/dev/dri). Use it for smoother video? (y/n)" y)" = y ] && GPU=1 || GPU=0
  else GPU=0; fi
fi
[ "$GPU" = 1 ] && FILES="docker-compose.yml:docker-compose.gpu.yml"

# remember the choices, so a plain `docker compose up -d` later does the same
set_env COMPOSE_FILE "$FILES"
set_env COMPOSE_PROFILES "$PROFILES"

# --- go ----------------------------------------------------------------------------------------------------------
say "Building and starting (first build downloads Chrome, a few minutes)..."
docker compose up -d --build

say "Waiting for it to become healthy..."
for _ in $(seq 1 60); do
  st="$(docker inspect -f '{{.State.Health.Status}}' teslacinema 2>/dev/null || echo starting)"
  [ "$st" = healthy ] && break
  sleep 3
done
[ "${st:-}" = healthy ] || { warn "Not healthy yet. Look at: docker compose logs app"; }

URL=""
PORT="$(get_env HOST_PORT)"; PORT="${PORT:-8195}"
case "$MODE" in
  quick-tunnel)
    say "Waiting for the Cloudflare address..."
    for _ in $(seq 1 40); do
      URL="$(docker compose logs cloudflared 2>&1 | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n1 || true)"
      [ -n "$URL" ] && break; sleep 2
    done
    [ -n "$URL" ] || warn "No address yet. Run: docker compose logs cloudflared" ;;
  domain) URL="https://$(get_env DOMAIN)" ;;
  lan)
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; URL="http://${IP:-localhost}:$PORT" ;;
  proxy) URL="(point your reverse proxy at http://127.0.0.1:$PORT)" ;;
esac

cat <<DONE

$(printf '\033[1;32m')TeslaCinema is running.$(printf '\033[0m')

  Address : ${URL:-see above}
  User    : $USER_NAME
  Password: $PASS      (also stored in .env)

Next: open the address in a normal browser first, log in, type a web address into the Chrome you see there.
Then open the same address in the car's browser (docs/using-in-the-car.md). Only while parked!

Useful:  docker compose logs -f app     docker compose down     ./setup.sh --help
DONE
[ "$MODE" = lan ] && warn "Plain http works on your network only. The car needs https: re-run ./setup.sh and choose 1 or 2."
[ "$MODE" = quick-tunnel ] && warn "The quick-tunnel address changes when the tunnel container restarts: run 'docker compose logs cloudflared' to see the new one."
exit 0
