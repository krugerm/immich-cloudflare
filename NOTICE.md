# Notices and attribution

This project is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`). It builds on the third-party work listed below. Each item keeps its own licence.

## Not affiliated with Immich

This project is independent. It is not affiliated with, sponsored by or endorsed by the Immich project or FUTO. "Immich" is the name and trademark of its owners and is used here only to describe API compatibility.

## Immich

- Source: https://github.com/immich-app/immich
- Licence: AGPL-3.0

Used in this project:

- Server behaviour is ported from the Immich server source (logic re-implemented in TypeScript for Cloudflare Workers).
- `vendor/immich-openapi.json` is the Immich OpenAPI specification, vendored unchanged. `src/gen/immich.d.ts` is generated from it.
- `scripts/build-web.sh` builds the Immich web app from a pinned upstream commit into `public/`. The build output is not committed.
- `containers/ml/Dockerfile` builds on the `ghcr.io/immich-app/immich-machine-learning` image.

## GeoNames

- Source: https://www.geonames.org
- Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)

`scripts/geodata/build.mjs` downloads `cities500`, `admin1CodesASCII`, `admin2Codes` and `countryInfo` at deploy time and imports them into D1 for reverse geocoding. The data is not committed to this repository.

## Time zone lookup

- `@photostructure/tz-lookup` (https://github.com/photostructure/tz-lookup), licence CC0-1.0.
- Its boundary data derives from timezone-boundary-builder (https://github.com/evansiroky/timezone-boundary-builder), licence ODbL 1.0.

## Machine-learning models

The `ml` container image downloads these models at build time. They are not committed to this repository.

### ViT-B-16-SigLIP2__webli (smart search, duplicate detection)

- Model: Google SigLIP 2, ViT-B/16 trained on WebLI, in the ONNX export published by Immich at https://huggingface.co/immich-app/ViT-B-16-SigLIP2__webli
- Licence: Apache-2.0, as stated on Google's release (https://huggingface.co/google/siglip2-base-patch16-224) and the timm release (https://huggingface.co/timm/ViT-B-16-SigLIP2). The Immich export's model card does not state a licence.

### InsightFace buffalo_l (face detection and recognition)

- Model: InsightFace `buffalo_l` pack (SCRFD detector and ArcFace R50 recogniser), in the export published by Immich at https://huggingface.co/immich-app/buffalo_l
- Licence: the InsightFace library code is MIT, but the pretrained models are licensed for non-commercial research purposes only. See https://github.com/deepinsight/insightface/tree/master/python-package#license and https://github.com/deepinsight/insightface#license. InsightFace asks anyone who needs other terms for the `buffalo_l` pack to contact recognition-oss-pack@insightface.ai.

If you deploy this project with face recognition enabled, you are responsible for complying with the InsightFace model terms. Commercial use of `buffalo_l` needs a separate licence from InsightFace.
