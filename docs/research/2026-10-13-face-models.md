# Face detection and recognition models for an Immich-compatible server (October 2026)

Scope: batch face ML in a Cloudflare Container (x86_64, CPU only, a few GB RAM, ONNX Runtime), tens of thousands of family photos with children at many ages. Baseline is Immich's default `buffalo_l` (SCRFD-10G-KPS detector + ArcFace IResNet50 trained on WebFace600K, 512-d).

## Recommendation

1. **Primary: keep the buffalo_l pair** (`det_10g.onnx` SCRFD-10G-KPS + `w600k_r50.onnx` ArcFace R50, 512-d, L2-normalised, cosine). It is within 0.4 percentage points of the best open model on IJB-C at FAR 1e-4, it has the best published AgeDB-30 score of any candidate here (98.23), it is CPU-friendly, and Immich's clustering defaults (maxDistance 0.5, minScore 0.7, minFaces 3) were tuned against it. Use Immich's own HF repo (`immich-app/buffalo_l`) so file layout and preprocessing match upstream.
2. **Optional upgrade, same licence class: SCRFD-10G-KPS + AdaFace IR101 trained on WebFace12M** (512-d). Best documented gain on low-quality faces (TinyFace rank-1 72.4 vs 71.0 for ArcFace on the same data and backbone), IJB-C 1e-4 97.66 to 97.72. Costs about 2x the recogniser compute of R50, and the distance threshold must be re-tuned on your own labelled pairs. Only worth it if the library has many small, blurry or dark faces and you accept leaving Immich's default.
3. **Fallback with permissive labels: YuNet (MIT, OpenCV Zoo) + AdaFace IR101 WebFace12M (code and published ONNX labelled MIT).** YuNet misses more small faces (WIDER hard AP 0.708 to 0.750 vs 0.83 for SCRFD-10G) and is trained for faces about 10 to 300 px, so run it on a downscaled image plus a tiled pass for group shots. If you want a smaller recogniser, SFace (Apache-2.0, MobileFaceNet, LFW 99.40) is the most permissively licensed option, at a clear accuracy cost.
4. **Not worth departing from buffalo_l for accuracy alone.** The top of the field is saturated (IJB-C 1e-4 97.2 to 97.8 for every serious 2022 to 2025 model). None of the candidates publishes a child or long-age-gap result that beats ArcFace R50, and every high-accuracy recogniser is trained on research-only data (WebFace, Glint360K, MS1M), so no option is clean for commercial use. Switching models forces a full re-embed and threshold recalibration.

## Licence reality for face recognisers

| Item | Licence of weights as published | Training data terms | Practical status |
|---|---|---|---|
| InsightFace packs (buffalo_*, antelopev2, raccoon_*) | "non-commercial research purposes only" for all pretrained models; library code MIT | WebFace600K (subset of WebFace260M), Glint360K | Fine for personal use. Immich's README states its permission does not extend to redistribution or commercial use by third parties. |
| AdaFace / CVLFace weights | Repo MIT; HF cards carry no separate licence field | WebFace4M/12M (WebFace260M terms: research use), MS1MV2/V3 (MS-Celeb-1M, withdrawn by Microsoft in 2019) | MIT label on weights, data terms unresolved. Low risk for personal use. |
| LVFace (ByteDance, ICCV 2025) | Code MIT; README says the downloadable models are "for non-commercial research purposes only" | Glint360K | Non-commercial. |
| EdgeFace (Idiap) | CC BY-NC-SA 4.0 | WebFace260M subset | Non-commercial, share-alike. |
| TransFace (ICCV 2023) | Repo licence not stated for weights | MS1MV2, Glint360K | Treat as research-only. |
| SFace (OpenCV Zoo) | Apache-2.0 | CASIA-WebFace / VGGFace2 / MS1M variants per paper | Most permissive label available; data still web-scraped. |
| YuNet | MIT | WIDER FACE | Permissive label. |
| SCRFD weights | InsightFace non-commercial (UniFace's docs list SCRFD and ArcFace as MIT; that covers code, not the InsightFace weights) | WIDER FACE | Non-commercial. |
| YOLOv5/v8-face (derronqi, akanametov, yakhyo ONNX) | GPL-3.0 / AGPL-3.0 (Ultralytics lineage) | WIDER FACE | Copyleft; avoid inside a closed container image you might distribute. |

No open recogniser trained on licence-clean data reaches buffalo_l accuracy. Synthetic-data models (DigiFace-1M, IDiff-Face lines) remain several points behind and DigiFace-1M itself is non-commercial.

## Detectors

WIDER FACE validation AP (Easy / Medium / Hard), single-scale unless noted.

| Detector | Easy | Medium | Hard | Params | FLOPs | Landmarks | ONNX | Licence | Notes |
|---|---|---|---|---|---|---|---|---|---|
| SCRFD-10G-KPS (buffalo_l, antelopev2) | 95.40 | 94.01 | 82.80 | 4.23M | 10G at VGA | 5 | yes | InsightFace non-commercial | 5.0 ms on V100 per SCRFD README; tens of ms on a few CPU cores at 640x640 (estimate). |
| SCRFD-34G | 96.06 | 94.92 | 85.29 | 9.80M | 34G | no KPS release | yes | same | +2.5 pts Hard, 3.4x compute, no landmark head, so alignment needs a second model. Not worth it. |
| SCRFD-2.5G-KPS (buffalo_m) | 93.80 | 92.02 | 77.13 | 0.82M | 2.5G | 5 | yes | same | Use if CPU budget is tight. |
| SCRFD-500M-KPS (buffalo_s) | 90.97 | 88.44 | 69.49 | 0.57M | 0.5G | 5 | yes | same | Loses small faces. |
| YuNet (2023mar, 2026may dynamic-shape export) | 88.4 | 86.6 | 75.0 | ~0.08M | <1G | 5 | yes | MIT | Faces about 10 to 300 px by training design; dynamic-shape ONNX added 2026-05. |
| RetinaFace R50 (original) | 94.92 | 91.90 | 64.17 | 29.5M | 37.6G | 5 | yes (community) | MIT code (biubug6/yakhyo) | Strictly worse than SCRFD-10G at 4x compute. |
| RetinaFace MobileNet0.25 | 87.78 | 81.16 | 47.32 | 0.44M | 0.8G | 5 | yes | MIT | Weak on small faces. |
| YOLOv8-face / YOLOv11-face | comparable to SCRFD-10G on Easy/Medium per community repos | | | | | 5 (v8-face pose variants) | yes | GPL/AGPL-3.0 | No clear gain; copyleft. |
| MediaPipe BlazeFace short-range | not benchmarked on WIDER | | | ~0.1M | tiny | 6 (eyes, nose, mouth, ear tragions) | yes | Apache-2.0 | Tuned for selfie-distance faces within about 2 m; no mouth corners, so it cannot drive the 5-point ArcFace alignment. Unsuitable for a photo library. |

Detector conclusion: SCRFD-10G-KPS is still the best accuracy per FLOP with built-in 5-point landmarks. Nothing published in 2024 to 2026 displaces it for CPU batch work. YuNet is the permissive substitute.

## Recognisers

IJB-B/IJB-C are TAR at FAR=1e-4. AgeDB-30 and CALFW are the cross-age verification sets. Numbers are the authors' published figures.

| Model | Train data | IJB-B | IJB-C | LFW | CFP-FP | AgeDB-30 | CALFW | Params / compute | Dim | ONNX | Licence (weights) | Maturity |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **buffalo_l: ArcFace IResNet50** | WebFace600K | n/r | 97.25 | 99.83 | 99.33 | **98.23** | n/r | 43.6M params; about half of R100 compute | 512 | yes (Immich HF) | InsightFace NC | Immich default since 2023; widest field use |
| antelopev2: ArcFace IResNet100 (glintr100) | Glint360K | n/r | 97.13 (ONNX zoo) / 97.55 (arcface_torch) | 99.82 | 99.14 | 98.45 | n/r | 65M params, about 24 GFLOPs | 512 | yes (Immich HF) | InsightFace NC | Supported by Immich; issue #21651 reports detection failures with this pack on 1.140.1 |
| buffalo_s: MobileFaceNet | WebFace600K | n/r | 95.02 | 99.70 | 98.00 | 96.58 | n/r | 2.0M, 0.45 GFLOPs | 512 | yes | InsightFace NC | Supported by Immich |
| AdaFace IR101 | WebFace12M | 96.41 to 96.55 | 97.66 to 97.72 | 99.82 | 99.24 | 98.00 | 96.12 | about 65M, about 24 GFLOPs | 512 (unnormalised; norm encodes quality) | yes (yakhyo/adaface-onnx, CVLFace HF) | MIT label | CVPR 2022 oral; widely reused |
| AdaFace IR101 | WebFace4M | 96.03 to 96.10 | 97.39 to 97.46 | 99.83 | 99.27 | 97.90 | 96.05 | same | 512 | yes | MIT label | |
| AdaFace IR50 | WebFace4M | 95.44 to 95.49 | 96.98 to 97.01 | 99.78 | 98.99 | 97.78 | 95.98 | same class as buffalo_l R50 | 512 | convertible | MIT label | |
| AdaFace ViT-B + KP-RPE (CVLFace) | WebFace12M | 96.55 | 97.82 | 99.82 | 99.30 | 98.10 | 95.93 | ViT-B, needs landmarks as input | 512 | HF safetensors, ONNX export not published | MIT label | CVPR 2024; less tested in production |
| LVFace-B (ICCV 2025) | Glint360K | 96.51 | 97.70 | n/r | n/r | n/r | n/r | ViT-B | 512 | yes (HF) | non-commercial | New; ranked at top of MFR-Ongoing per authors |
| LVFace-S / -T | Glint360K | 96.14 / 95.41 | 97.31 / 96.67 | | | | | ViT-S / ViT-T | 512 | yes | non-commercial | |
| TransFace-L | MS1MV2 | n/r | 96.59 | | | | | ViT-L, heavy | 512 | no | unstated | ICCV 2023 |
| TopoFR (NeurIPS 2024) | MS1MV2 / Glint360K | similar band (about 97.0 to 97.5 IJB-C on Glint360K R100 per paper) | | | | | | R50 to R200 | 512 | no official ONNX | unstated | Research code only |
| EdgeFace-S (gamma 0.5) | WebFace260M subset | n/r | 95.63 | 99.78 | 95.74 | 97.03 | 95.55 | 3.65M, 306 MFLOPs | 512 | yes (yakhyo/edgeface-onnx) | CC BY-NC-SA 4.0 | IEEE T-BIOM 2024 |
| EdgeFace-XS (gamma 0.6) | same | 92.67 | 94.85 | 99.73 | 94.71 | 96.08 | 95.28 | 1.77M, 154 MFLOPs | 512 | yes | CC BY-NC-SA 4.0 | IJCB 2023 efficient-FR winner (<2M) |
| EdgeFace-Base | same | n/r | n/r | 99.83 | 97.01 | 97.60 | 96.07 | 18.2M, 1.4 GFLOPs | 512 | yes | CC BY-NC-SA 4.0 | |
| SFace (MobileFaceNet) | per paper | n/r | n/r | 99.40 (OpenCV eval) | n/r | n/r | n/r | about 1M | 128 | yes, int8 variant too | Apache-2.0 | In OpenCV since 2021 |
| MagFace IR100 | MS1MV2 | 94.51 | 95.97 | 99.83 | 98.46 | 98.17 | 96.15 | about 24 GFLOPs | 512 | community | Apache-2.0 code | Superseded by AdaFace |
| ElasticFace-Arc+ R100 | MS1MV2 | 95.43 | 96.65 | 99.82 | 98.73 | 98.28 | 96.18 | about 24 GFLOPs | 512 | no | CC BY-NC-SA | Superseded |
| GhostFaceNet | MS1MV3 | n/r | about 96 | 99.77 | about 99 | about 98 | | 60 to 215 MFLOPs | 512 | Keras/TF | MIT code | Niche |

n/r: not reported by the source used. MagFace, ElasticFace, GhostFaceNet and TopoFR figures are from their papers as summarised in third-party tables and were not re-fetched for this report; treat them as approximate.

### General vision foundation models (CLIP, SigLIP2, DINOv2)

They are not identity embedders. Their embeddings cluster by pose, lighting, scene and age group before identity. Face-specific margin-loss models outperform them by tens of points on IJB-C. Immich already runs SigLIP2/CLIP for smart search; reusing it for people would merge siblings and split one person across ages. Not a candidate.

### InsightFace 2.x "raccoon" packs (new, 2026-09)

InsightFace 2.0/2.1 added `raccoon_s` and `raccoon_l` packs (36 MB and 255 MB, released 2026-09-03 on the `model-zoo` release) used by its PrivateFrame video-redaction app, plus `cheetah_*` person packs whose recognition entries match Raccoon. No accuracy tables are published for them, they ship under the same non-commercial terms, and Immich does not support them. Do not adopt until numbers are published.

## Cross-age and children

- AgeDB-30 spread across the top models is small: buffalo_l 98.23, antelopev2 98.45, AdaFace IR101 WF12M 98.00, ViT-KPRPE 98.10. CALFW is about 96.0 to 96.1 for all of them. No candidate shows a cross-age advantage large enough to matter.
- Published child studies show every adult-trained model degrades with younger age and larger time gaps. Hossain et al. 2026 (infants and toddlers): ArcFace TAR at FAR 0.1% about 27 to 31% at 0 to 6 months rising to about 62 to 65% at 2.5 to 3 years; MagFace slightly better in most bands. The YFA study (ages 3 to 18) found MagFace usable for gaps up to about three years. No study found compares AdaFace or LVFace on children.
- Practical consequence for clustering: one child photographed from birth to age 10 will split into several clusters with any model at maxDistance 0.5. Plan for the Immich "merge people" flow and for assigning faces to an existing person; raising maxDistance to fix this merges siblings first.

## CPU cost estimate for the Container

No source reports per-face CPU latency for these exact ONNX files. Estimates from FLOPs on ONNX Runtime with 2 to 4 x86 vCPUs (measure before committing):

| Stage | Model | Estimated time |
|---|---|---|
| Detection per image (640 x 640) | SCRFD-10G-KPS | 40 to 100 ms |
| Detection per image | YuNet | 5 to 15 ms (plus tiles if used) |
| Recognition per face (112 x 112) | ArcFace R50 | 15 to 40 ms |
| Recognition per face | IResNet100 / AdaFace IR101 / LVFace-B | 30 to 80 ms |
| Recognition per face | EdgeFace-S / SFace | 2 to 5 ms |

At 50,000 photos with about 1.5 faces each, buffalo_l costs about 2 to 4 CPU-hours for a full pass; an R100-class recogniser adds about 1 to 2 hours. Memory: buffalo_l detector + recogniser ONNX is about 190 MB on disk (the full pack includes 2d106, 3d68 and genderage models Immich does not use) and stays under 1 GB resident. Batch recognition inputs (for example 32 aligned crops per call) to amortise ORT overhead.

## Immich compatibility

- Immich main still ships exactly four face packs: `antelopev2`, `buffalo_l`, `buffalo_m`, `buffalo_s` (`machine-learning/immich_ml/models/constants.py`). The HF collection `immich-app/facial-recognition` was last updated November 2023. Discussion #25851 requesting a new face backend with more models is closed without a merge.
- All four packs produce 512-d normalised ArcFace embeddings and use the same `face_search` vector(512) column. AdaFace, LVFace, EdgeFace and TransFace are also 512-d, so the schema fits. SFace is 128-d and does not.
- The clustering contract is model-specific in practice. Immich's maxDistance 0.5 (cosine distance) and minScore 0.7 (detector confidence) were tuned for SCRFD + ArcFace. Another recogniser has a different impostor/genuine distance distribution, so 0.5 can over-merge or over-split. AdaFace embeddings must be L2-normalised before storage (their raw norm encodes image quality; that norm can be kept as a separate quality score to filter low-quality faces before clustering).
- Embeddings from different models are not comparable. A model switch means deleting all faces and re-running detection, recognition and clustering, which also discards manual person assignments unless they are re-attached by face bounding-box overlap.
- Bounding boxes and thumbnails: every detector listed returns boxes in image pixels plus 5 landmarks (except BlazeFace). Immich stores box coordinates with the image width/height they refer to and generates the person thumbnail by cropping the preview image with a margin; this is detector-agnostic.

## Why not switch now

- Accuracy gain at the top end is 0.4 to 0.6 points TAR at FAR 1e-4 on IJB-C, smaller on AgeDB (buffalo_l is already the best there), and unverified on family photos.
- Licence does not improve: every model that beats buffalo_l carries a non-commercial or research-data restriction.
- Cost: recalibration of thresholds, a full re-embed, and divergence from Immich defaults that the mobile and web clients and users' expectations are built around.
- A cheaper path to better people clustering on a family library: keep buffalo_l, filter faces below a minimum box size (for example 48 px) and low detection score, and lean on manual merge for children across ages.

## Sources

- InsightFace model zoo and pack table: https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md
- InsightFace Python package model docs (buffalo_l accuracy table, raccoon packs, licence): https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md
- InsightFace model-zoo release assets (raccoon/cheetah, 2026-09/10): https://github.com/deepinsight/insightface/releases/tag/model-zoo
- arcface_torch IJB-C table (Glint360K R100 97.55): https://github.com/deepinsight/insightface/tree/master/recognition/arcface_torch
- SCRFD README: https://github.com/deepinsight/insightface/tree/master/detection/scrfd
- Immich facial recognition docs: https://docs.immich.app/features/facial-recognition
- Immich supported model list: https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/constants.py
- Immich antelopev2 repo: https://huggingface.co/immich-app/antelopev2
- Immich issue on antelopev2 detection: https://github.com/immich-app/immich/issues/21651
- Immich discussion on new face backend: https://github.com/immich-app/immich/discussions/25851
- AdaFace: https://github.com/mk-minchul/AdaFace (licence: https://github.com/mk-minchul/AdaFace/blob/master/LICENSE)
- CVLFace (AdaFace IR/ViT/KP-RPE results): https://github.com/mk-minchul/CVLface
- LVFace: https://github.com/bytedance/LVFace and https://huggingface.co/bytedance-research/LVFace
- TransFace: https://github.com/DanJun6737/TransFace
- EdgeFace: https://huggingface.co/Idiap/EdgeFace-Base and https://arxiv.org/abs/2307.01838
- UniFace model zoo and licence table: https://yakhyo.github.io/uniface/models/ and https://yakhyo.github.io/uniface/license-attribution/
- YuNet: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- SFace: https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface
- YOLO-face (GPL/AGPL lineage): https://github.com/akanametov/yolo-face
- Infant and toddler FR study (2026): https://arxiv.org/abs/2601.01680
- Child FR synthetic benchmark: https://arxiv.org/abs/2304.11685
- Face recognition in children, longitudinal (YFA): https://par.nsf.gov/servlets/purl/10577455
