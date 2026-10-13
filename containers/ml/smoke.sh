#!/usr/bin/env bash
# Build the `ml` image and smoke-test it offline at the standard-2 shape (1 vCPU, 6 GB).
# Run on a Docker host from a directory holding this folder's files: bash smoke.sh [image tag]
set -euo pipefail
TAG="${1:-immich-cf-ml-p4a}"
NAME="$TAG-smoke"
DOCKER="docker"
# Public-domain official portrait (US government work), one face, at preview size (long edge 1440 px).
PHOTO_URL="https://commons.wikimedia.org/wiki/Special:FilePath/President_Barack_Obama.jpg?width=1440"

echo "== build"
time $DOCKER build -t "$TAG" .
$DOCKER image inspect "$TAG" --format 'image size: {{.Size}} bytes'
$DOCKER image ls "$TAG"

echo "== photo"
curl -fsSL -A "immich-cf-smoke/1.0" -o face.jpg "$PHOTO_URL"
python3 -c "import sys;print('face.jpg', len(open('face.jpg','rb').read()), 'bytes')"

echo "== run (no network, --cpus 1, --memory 6g)"
$DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
START=$(date +%s.%N)
$DOCKER run -d --name "$NAME" --network none --cpus 1 --memory 6g "$TAG" >/dev/null
$DOCKER cp smoke.py "$NAME:/tmp/smoke.py"
$DOCKER cp face.jpg "$NAME:/tmp/face.jpg"
status=0
$DOCKER exec "$NAME" python /tmp/smoke.py /tmp/face.jpg "$START" || status=$?
$DOCKER stats --no-stream --format 'memory: {{.MemUsage}}' "$NAME"
echo "== server log (model loads before startup; after it only the error traces of the bad-input checks)"
$DOCKER logs "$NAME" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -E 'Loading|Preparing|startup complete|Error' | cut -c1-120
$DOCKER rm -f "$NAME" >/dev/null
exit $status
