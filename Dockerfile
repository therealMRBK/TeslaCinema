# TeslaCinema - a real Google Chrome on a virtual display (Xvfb + Fluxbox), streamed with sound to the car browser.
# amd64 only: Google does not publish Chrome for Linux/arm64, and Chrome (not Chromium) is what plays protected video.

# xhelper (app/xhelper.c): long-running X client for mouse input and the pointer shape. Built in its own stage so the
# compiler and headers stay out of the final image.
FROM debian:bookworm AS xhelper
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libx11-dev libxtst-dev libxfixes-dev \
    && rm -rf /var/lib/apt/lists/*
COPY app/xhelper.c /src/xhelper.c
RUN gcc -O2 -Wall -o /src/xhelper /src/xhelper.c -lX11 -lXtst -lXfixes

FROM node:22-bookworm

# VA-API drivers for optional GPU decode/encode live partly in Debian's non-free component. Patch the existing sources
# file (DEB822 format) instead of adding a second one, which would conflict on Signed-By.
RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i 's/^deb \(.*\) bookworm main$/deb \1 bookworm main contrib non-free non-free-firmware/' /etc/apt/sources.list; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb fluxbox xdotool libxtst6 libxfixes3 xclip ffmpeg x11-utils x11-xserver-utils xcvt dbus-x11 \
      wget gnupg ca-certificates fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      mesa-va-drivers libgl1-mesa-dri intel-media-va-driver-non-free vainfo \
      pulseaudio pulseaudio-utils locales \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Chrome runs as root in the container and therefore needs --no-sandbox. Hide the infobar that complains about it: it would
# eat vertical space on the car screen. (A managed policy, so nothing about how Chrome behaves changes.)
RUN mkdir -p /etc/opt/chrome/policies/managed \
    && echo '{"CommandLineFlagSecurityWarningsEnabled": false}' > /etc/opt/chrome/policies/managed/teslacinema.json

# Locales the LOCALE variable can pick from. A UTF-8 locale is mandatory: under the default "C" locale xdotool cannot type
# umlauts, accents or emoji at all. LOCALE also sets the language of Chrome's own menus.
RUN for l in en_US de_DE fr_FR es_ES it_IT nl_NL pt_BR pl_PL tr_TR sv_SE da_DK nb_NO fi_FI cs_CZ; do \
      localedef -i "$l" -c -f UTF-8 -A /usr/share/locale/locale.alias "$l.UTF-8"; \
    done

# Fluxbox's default style calls fbsetbg, which fails in this minimal image and pops up an xmessage error box over the
# screen. xmessage is used for nothing else here, so neutralise it.
RUN ln -sf /bin/true /usr/bin/xmessage

WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/ .
COPY --from=xhelper /src/xhelper /app/xhelper

ENV PORT=3000 \
    DATA_DIR=/data \
    DISPLAY_WIDTH=1920 \
    DISPLAY_HEIGHT=1080 \
    TARGET_FPS=24

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
