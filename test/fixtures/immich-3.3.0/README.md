Captured from Immich v3.3.1 (server image tag; vendor/immich-openapi.json is the 3.3.0-rc.0 spec at the pinned commit) on a Linux x86_64 Docker host, 2026-10-12.
Server: docker compose in ~/immich-ref, bound to 127.0.0.1:2290, admin ref@example.com / refpass123.
Files are raw API responses; web-requests.txt is the de-duplicated /api request list from loading the web timeline and opening one photo.
Leave ~/immich-ref running until Task 16 (golden sync test) is done, then `docker compose down -v`.
