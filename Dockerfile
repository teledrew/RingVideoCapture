# Node version is pinned in the image so the host's Node install is irrelevant.
# Default 22 (LTS) because ring-client-api@14 declares engines ^20 || ^22 || ^24.
# Override for a different runtime, e.g.:
#   docker build --build-arg NODE_VERSION=24 -t ring-recorder .
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim

# ffmpeg transcodes the WebRTC live stream to MP4. Installing the distro build
# avoids the ffmpeg-for-homebridge static download, which fails on some
# architectures and bloats the image.
# gosu drops privileges cleanly in the entrypoint (no signal-forwarding issues
# that `su`/`sudo` introduce, so SIGTERM still reaches node for clean shutdown).
RUN apt-get update \
  && apt-get install --no-install-recommends -y ffmpeg ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so dependency layers cache independently of source edits.
COPY package.json package-lock.json* ./

# Use `npm ci` when a lockfile is present, otherwise fall back to `npm install`.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /recordings /data \
  && chown -R node:node /recordings /data /app

# Starts as root so the entrypoint can align the runtime uid/gid with the host
# (PUID/PGID), then drops to the unprivileged `node` user via gosu before
# running the app. Pass `--user` to skip this and run unprivileged throughout.
VOLUME ["/recordings", "/data"]

ENV NODE_ENV=production \
    OUTPUT_DIR=/recordings \
    TOKEN_PATH=/data/refresh-token \
    FFMPEG_PATH=ffmpeg \
    PUID=1000 \
    PGID=1000

ENTRYPOINT ["docker-entrypoint.sh"]

# Exec form so the process receives SIGTERM directly and can shut down cleanly.
CMD ["node", "src/index.js"]
