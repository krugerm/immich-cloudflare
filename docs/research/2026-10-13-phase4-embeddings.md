# Phase 4 spike: image-text embeddings for smart search and duplicates

Date: 2026-10-13. Scope: research plus a CPU benchmark on a Linux x86_64 Docker host. No repository code changed.

## Summary

- EmbeddingGemma 2 exists (released 2026-10-06), is Apache 2.0, and is a true image-text model: images and text share one 768-dimensional space, with Matryoshka truncation to 512, 256 and 128. It ships as PyTorch weights (transformers 5.19, sentence-transformers 6.1) and as ONNX for Transformers.js. It found the right photo for all 5 test queries.
- On one CPU core it costs 13 to 16 s per image at its default vision budget (280 tokens) and 2.6 to 3.1 s at the minimum budget (70 tokens). Immich's default ViT-B-32__openai takes 105 ms and ViT-B-16-SigLIP2__webli takes 352 ms per image on the same core.
- Recommendation: use `ViT-B-16-SigLIP2__webli` (768 dims, multilingual, in Immich's supported list) for smart search and duplicate detection, store 768-dim cosine vectors in Vectorize, and run it in the separate `ml` Container. Keep EmbeddingGemma 2 out of Phase 4.

## 1. What EmbeddingGemma 2 is

Facts from the model card ([google/embeddinggemma-2](https://huggingface.co/google/embeddinggemma-2)), its config files, and the ONNX repo ([onnx-community/embeddinggemma-2-ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX)):

| Item | Value |
|---|---|
| Release | 2026-10-06 ([news report](https://vpsranking.com/news/ai/ai-2026-10-06-google-embeddinggemma-2/)) |
| Licence | Apache 2.0, repo not gated |
| Modalities | Text, image, video, audio, and interleaved mixes, in one shared space |
| Image-text retrieval | Yes. The card lists "Retrieval: semantic search across text, code, images, video, and audio" and shows a text query scored against image, audio and video embeddings. Measured here: 5/5 correct top-1. |
| Parameters | 740M total: 270M text (130M transformer + 140M embedding table), 170M vision encoder, 300M audio encoder. Text + vision only: 440M (439M measured) |
| Output dimension | 768 native; MRL truncation to 512, 256, 128 (re-normalise after truncation) |
| Image input | Gemma 4 image processor, 16 px patches, 3x3 pooling, aspect ratio kept. Default 280 soft tokens per image, configurable 70 to 1120. No fixed square resolution; budget sets the pixel count |
| Context | 8,192 tokens shared across all inputs |
| Text prompts | Query: `task: search result \| query: {q}`. Images take no prefix |
| Precision | fp32 or bf16. The card warns that fp16 gives NaN or degraded vectors |
| Runtimes | transformers 5.19.0 and sentence-transformers 6.1.0 (both on PyPI now); Transformers.js 4.3.1 with ONNX; GGUF (llama.cpp), MLX, LiteRT, Core ML community builds |
| ONNX files (text model / vision encoder / audio encoder) | fp32 1085 / 671 / 1173 MB; fp16 543 / 336 / 587 MB (unsafe per the precision note); q8 314 / 195 / 340 MB; q4 175 / 109 / 189 MB; q4f16 157 / 98 / 171 MB |
| Published quality (768d) | MIEB lite 64.64; MMEB v2 Image Hit@1 57.28; MMEB v2 overall 59.01 (56.24 at 256d, 45.65 at 128d); MTEB multilingual v2 61.36 |

The card publishes no COCO or Flickr30k recall, so a direct comparison with CLIP-family retrieval numbers is not possible from published data.

## 2. Benchmark on the Docker host

### Setup

- Host: AMD Ryzen 9 3900X, system Docker daemon. Every run used `--cpus 1` with one inference thread (ONNX Runtime intra-op and inter-op threads = 1; `torch.set_num_threads(1)`). A second pass ran the two Immich models at `--cpus 0.5`.
- Cloudflare instance types ([limits page](https://developers.cloudflare.com/containers/platform/limits/)): `standard-1` is 1/2 vCPU, 4 GiB, 8 GB disk; `standard-2` is 1 vCPU, 6 GiB, 12 GB disk. `--cpus 1` approximates `standard-2`, and `--cpus 0.5` approximates `standard-1`. A Cloudflare vCPU may be slower or faster than a 3900X core; treat the numbers as relative.
- Immich models ran in `ghcr.io/immich-app/immich-machine-learning:v3.3.1` through Immich's own `OpenClipVisualEncoder` and `OpenClipTextualEncoder` classes, so preprocessing, tokenisation and ONNX session settings match Immich. Input was JPEG bytes, so the time includes decode and resize.
- EmbeddingGemma 2 ran two ways: PyTorch fp32 via sentence-transformers 6.1.0 (torch 2.14.1 CPU, transformers 5.19.0, audio encoder disabled with `config_kwargs={"audio_config": None}`), and ONNX via Transformers.js 4.3.1 on Node 24 (onnxruntime-node). Transformers.js loaded the audio encoder session as well; it was set to q4 to limit the cost.
- Photos: 8 CC0 or public-domain photos from Wikimedia Commons, converted to Immich-style previews (long edge 1440 px, JPEG quality 80): [beach](https://commons.wikimedia.org/wiki/File:Parasols,_beach_furniture,_Beach,_Rincon_de_la_Victoria,_Andalusia,_Spain.jpg), [dog](https://commons.wikimedia.org/wiki/File:Labrador_Retriever_with_orange_ball.jpg), [birthday cake](https://commons.wikimedia.org/wiki/File:Birthday_cake_with_seven_candles.jpg) (the icing reads "Happy Birthday", which helps every model), [snow mountain](https://commons.wikimedia.org/wiki/File:Tall_snow-capped_mountain_peak_(Unsplash).jpg), [child on a bicycle](https://commons.wikimedia.org/wiki/File:Child_bicycle_Managing_ports_Altagracia.jpg), and three distractors: [cat](https://commons.wikimedia.org/wiki/File:Cute_gray_cat_sitting_in_bed.jpg), [forest hiker](https://commons.wikimedia.org/wiki/File:Forest-trees-hiker-hiking_(23700043303).jpg), [bike on a snowy street at night](https://commons.wikimedia.org/wiki/File:Bike_on_a_snowy_street_in_Quebec_City_at_night.jpg) (a hard negative for "snow mountain" and "child on a bicycle").
- Latency is the median over the 8 photos of the per-photo median of 5 runs (2 runs for the slow EmbeddingGemma 2 configurations), after one warm-up call. Text latency is the median over the 5 queries.
- Memory is peak RSS of the process (`ru_maxrss`), with both the image and text models loaded.

### Results at 1 vCPU (`--cpus 1`)

| Model and runtime | Dim | Image ms | Text ms | RSS after load | Peak RSS | Top-1 correct |
|---|---|---|---|---|---|---|
| ViT-B-32__openai, Immich ONNX fp32 | 512 | 105 | 59 | 254 MB | 755 MB | 5/5 |
| ViT-B-32-SigLIP2-256__webli, Immich ONNX fp32 | 768 | 139 | 116 | 584 MB | 1,359 MB | 5/5 |
| ViT-B-16-SigLIP2__webli, Immich ONNX fp32 | 768 | 352 | 110 | 582 MB | 1,063 MB | 5/5 |
| EmbeddingGemma 2, torch fp32, 280 tokens (default) | 768 | 16,405 | 113 | 2,422 MB | 2,954 MB | 5/5 |
| EmbeddingGemma 2, torch fp32, 70 tokens | 768 | 2,978 | 114 | 2,423 MB | 2,953 MB | 5/5 |
| EmbeddingGemma 2, Transformers.js q8, 280 tokens | 768 | 13,609 | 314 | 712 MB | 1,635 MB | 5/5 |
| EmbeddingGemma 2, Transformers.js q8, 70 tokens | 768 | 3,131 | 344 | 497 MB | 1,661 MB | 5/5 |
| EmbeddingGemma 2, Transformers.js q4, 280 tokens | 768 | 12,895 | 75 | 677 MB | 1,613 MB | 5/5 |
| EmbeddingGemma 2, Transformers.js q4, 70 tokens | 768 | 2,587 | 76 | 772 MB | 1,121 MB | 5/5 |
| EmbeddingGemma 2, Transformers.js fp32, 70 tokens | 768 | 2,775 | 51 | 2,001 MB | 2,842 MB | 5/5 |

EmbeddingGemma 2 at 256 dimensions (torch run, truncated and re-normalised) also scored 5/5.

### Results at 1/2 vCPU (`--cpus 0.5`, approximates `standard-1`)

| Model | Image ms | Text ms | Peak RSS |
|---|---|---|---|
| ViT-B-32__openai | 211 | 112 | 671 MB |
| ViT-B-16-SigLIP2__webli | 725 | 215 | 1,176 MB |

Latency doubles with half the CPU, as expected for single-threaded inference. EmbeddingGemma 2 was not rerun at 0.5 vCPU; by the same ratio it would take about 5 to 6 s per image at 70 tokens.

### Cold start

| Model | First load (ORT builds an optimised graph) | Later load (optimised graph cached on disk) |
|---|---|---|
| ViT-B-32__openai | visual 3.1 s + textual 2.1 s | 0.7 s + 0.3 s |
| ViT-B-16-SigLIP2__webli | visual 2.8 s + textual 6.0 s | 0.8 s + 2.4 s |
| EmbeddingGemma 2, torch fp32 | 3.2 s | 3.2 s |
| EmbeddingGemma 2, Transformers.js q8 / q4 | | 1.7 s / 1.9 s |

Immich writes the optimised ONNX graph next to the model on first load. A fresh Cloudflare Container starts with an empty writable layer, so it pays the first-load time on every cold start unless the cache directory sits on persistent storage. ONNX Runtime warns that this optimised graph contains hardware-specific transforms, so baking it into the image at build time is unsafe across CPU types. Model download time is excluded; the models should be in the image or on local disk.

### Throughput for an initial backfill (1 vCPU, one worker)

| Model | Images per hour | 50,000-photo library |
|---|---|---|
| ViT-B-32__openai | ~34,000 | ~1.5 h |
| ViT-B-32-SigLIP2-256__webli | ~26,000 | ~1.9 h |
| ViT-B-16-SigLIP2__webli | ~10,200 | ~4.9 h |
| EmbeddingGemma 2, q4, 70 tokens | ~1,400 | ~36 h |
| EmbeddingGemma 2, q4, 280 tokens | ~280 | ~180 h |

### Sanity checks

- Every model ranked the expected photo first for all five queries ("beach", "dog", "birthday cake", "snow mountain", "child on a bicycle"). The smallest top-1 margin was "snow mountain" for every model, against the forest-hiker and snowy-street photos. With eight photos this is a smoke test. It shows the pipelines work and that EmbeddingGemma 2 is image-text aligned; it does not rank the models.
- Raw score scales differ by model. SigLIP2 top-1 cosine scores were 0.10 to 0.15, ViT-B-32 0.25 to 0.33, EmbeddingGemma 2 0.69 to 0.75. Score thresholds, if any are used for search, must be set per model.
- Near-duplicate test: each of three photos was cropped by 4 % on every side, downscaled to 60 % and re-saved at JPEG quality 55. Cosine similarity to the original was 0.94 to 0.99 for all models, against a highest similarity of 0.66 to 0.75 between two different photos. Immich's default duplicate threshold is a cosine distance of 0.01 (`maxDistance: 0.01` in immich-server v3.3.1 `dtos/config.dto.js`), so these strong edits would mostly fall outside it. That threshold targets re-encoded copies and burst shots; it should be calibrated for the chosen model on real near-duplicates.

### Model and image sizes

| Artefact | Size |
|---|---|
| ViT-B-32__openai ONNX (visual + textual) | 352 MB + 254 MB |
| ViT-B-16-SigLIP2__webli ONNX (visual + textual) | 372 MB + 1,129 MB |
| ViT-B-32-SigLIP2-256__webli ONNX (visual + textual) | 378 MB + 1,129 MB |
| EmbeddingGemma 2 safetensors (all modalities) | 1,489 MB |
| EmbeddingGemma 2 ONNX q4, text + vision | 284 MB |
| `immich-machine-learning:v3.3.1` CPU image (no models) | 1.11 GB |
| python:3.12-slim + torch CPU + transformers + sentence-transformers | 2.01 GB |
| Transformers.js 4.3.1 `node_modules` | 735 MB (on top of the Node base image) |

The SigLIP2 text tower is large because of its 256k-token Gemma vocabulary. Immich's textual loader can memory-map that embedding table when the graph metadata names it; RSS after loading both towers was 0.58 GB, well below the 1.5 GB of weights, which suggests it does so here.

## 3. Published retrieval quality

### English (COCO and Flickr30k, zero-shot recall@1)

| Model | COCO T→I | COCO I→T | Flickr T→I | Flickr I→T | Source |
|---|---|---|---|---|---|
| ViT-B-32 OpenAI CLIP | 30.4 | 50.1 | 58.8 | 78.9 | [OpenCLIP retrieval results](https://github.com/mlfoundations/open_clip/blob/main/docs/openclip_retrieval_results.csv) |
| ViT-B-32 SigLIP 2 (256 px) | 47.2 | 63.7 | 75.5 | 89.3 | [SigLIP 2 paper, Table 1](https://arxiv.org/html/2502.14786) |
| ViT-B-16 SigLIP 2 (224 px) | 52.1 | 68.9 | 80.7 | 93.0 | SigLIP 2 paper, Table 1 |
| ViT-B-16 OpenAI CLIP, for reference | 33.1 | 52.4 | 62.1 | 81.9 | SigLIP 2 paper, Table 1 |
| EmbeddingGemma 2 | not published | | | | Model card gives MMEB v2 Image Hit@1 57.28 and MIEB lite 64.64 only |

COCO recall@5 for ViT-B-32 OpenAI is 55.9 (T→I) and 75.0 (I→T) per OpenCLIP.

### Multilingual

SigLIP 2 paper, XM3600 (36 languages) recall@1: B/32-256 38.3 T→I and 49.0 I→T; B/16-224 40.3 and 50.7. ViT-B-32 OpenAI is English-only; its OpenCLIP multilingual average is 0.134 against 0.749 for nllb-clip-base-siglip.

Immich's own table ([docs.immich.app, Searching → CLIP models](https://docs.immich.app/features/searching/); recall = mean of R@1/5/10 over Crossmodal-3600, XTD-10 and Flickr30k where available):

| Model | Immich memory (MiB) | Immich exec time (ms) | English | German | French | Spanish |
|---|---|---|---|---|---|---|
| ViT-B-32__openai (Immich default) | 1,004 | 2.26 | 69.9 | 24.1 | 38.3 | 32.6 |
| ViT-B-32-SigLIP2-256__webli | 3,061 | 3.31 | 82.3 | 81.5 | 80.2 | 80.7 |
| ViT-B-16-SigLIP2__webli | 3,038 | 5.81 | 84.9 | 84.3 | 82.9 | 83.6 |
| ViT-SO400M-16-SigLIP2-384__webli | 3,854 | 56.57 | 86.0 | 87.2 | 86.5 | 85.4 |

Immich's memory and time figures come from its own benchmark setup and are not comparable with the CPU numbers above. EmbeddingGemma 2 claims 100+ languages; no per-language image retrieval numbers are published.

## 4. Recommendation

### Model: `ViT-B-16-SigLIP2__webli`

- English recall 84.9 in Immich's table, against 69.9 for the current Immich default, and comparable quality in German, French and Spanish, where ViT-B-32__openai fails (24 to 38).
- 352 ms per image and 110 ms per query on 1 vCPU; peak RSS 1.1 GB, which fits `standard-1` (4 GiB) and `standard-2` (6 GiB).
- It is in Immich's supported model list, so the server can report `machineLearning.clip.modelName = "ViT-B-16-SigLIP2__webli"`. The admin settings page and clients then see a model name they know, which removes the need for the free-text `embeddinggemma2` name proposed in `2026-10-13-phase4-search-duplicates.md`.
- Same vector for smart search and duplicate detection, as Immich does.
- Fallback if backfill throughput or CPU cost matters more than the last 2.6 recall points: `ViT-B-32-SigLIP2-256__webli` (139 ms per image, same 768 dims and the same text latency). Vectors from the two models are not interchangeable; switching means re-embedding the library.

EmbeddingGemma 2 works and is the most capable model tested (video and audio search, interleaved inputs, MRL), but at 7 to 47 times the per-image CPU cost of ViT-B-16-SigLIP2 (25 to 156 times that of ViT-B-32) on a CPU-only Container it is a poor fit for a photo library backfill. It also lacks published COCO or Flickr numbers and is not an Immich model name. Revisit it if a GPU host or video search enters scope.

### Vectorize

- Dimension 768, metric cosine. Vectorize allows up to 1,536 dimensions ([Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)).
- L2-normalise vectors in the `ml` Container before upsert so cosine and dot product agree.
- Calibrate the duplicate threshold for SigLIP2 on real re-encoded copies and burst frames before reusing Immich's 0.01 default. The search-duplicates note already plans this calibration.

### Container placement: separate `ml` Container

- Image size: the media Container (libvips, ffmpeg, thumbnail generation) would grow by the Python inference runtime (onnxruntime, tokenizers, numpy, Pillow; not measured separately, Immich's full CPU image with all of it is 1.11 GB) plus 1.5 GB of SigLIP2 ONNX weights. A dedicated `ml` image of roughly 2 GB fits the 8 GB disk of `standard-1`.
- Memory: SigLIP2 needs about 1.1 GB peak. Sharing a 4 GiB instance with libvips and ffmpeg working on large originals and videos risks OOM kills that take down both jobs.
- Latency path: text queries are interactive (110 ms at 1 vCPU, 215 ms at 1/2 vCPU) and should not queue behind a video transcode. A separate Container can stay warm for search while the media Container scales with upload load.
- Cold start: 3 to 9 s on first load (ONNX graph optimisation), 1 to 3 s when the optimised graph is cached. Keep one `ml` instance warm for search, or accept a slow first query after idle.
- Instance type: `standard-2` (1 vCPU, 6 GiB) for the backfill, at about 10,000 images per hour per instance; `standard-1` (1/2 vCPU) is enough for steady-state uploads and search at half that rate.
- Runtime: reuse Immich's `immich_ml` encoder classes or the same preprocessing (bicubic squash to 224x224, mean/std 0.5; Gemma tokenizer, 64 tokens, padded) with onnxruntime in Python. That keeps vectors identical to what an Immich ML server would produce.

## Method notes and cleanup

- Scripts and raw JSON results are in a temporary working directory and were not committed.
- On the Docker host, the spike working directory (photos, previews, models, node_modules, results) was deleted and the built image `p4emb-eg2:spike` was removed. The pre-existing images `immich-machine-learning:v3.3.1` and `node:24` were used read-only and left in place, as were the `eg2spike:env` image and `eg2calib` container from an earlier session.
