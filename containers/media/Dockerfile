FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg libimage-exiftool-perl libraw-bin libvips-tools nodejs ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

# The HDR poster path needs zscale (libzimg). Fail the build if this ffmpeg lacks it, or a tool is missing
# (prlimit from util-linux caps decoder memory).
RUN ffmpeg -hide_banner -filters 2>/dev/null | grep -q zscale \
 && command -v dcraw_emu && command -v vipsthumbnail && command -v vipsheader && command -v exiftool \
 && command -v prlimit

WORKDIR /app
COPY package.json server.mjs ./
COPY test/ ./test/

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
