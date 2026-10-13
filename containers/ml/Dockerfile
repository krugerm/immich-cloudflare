# The `ml` container: Immich's own machine-learning server with ViT-B-16-SigLIP2__webli (smart search, duplicates)
# and buffalo_l (faces) baked into its model cache. The container has no internet at runtime.
#
# Two targets: `search` (the text encoder only, for smart-search queries: a smaller image that starts sooner) and the
# default last stage `full` (all four models, for the asset-ml jobs).
FROM ghcr.io/immich-app/immich-machine-learning:v3.3.1 AS common

# Runtime settings (Immich reads MACHINE_LEARNING_* and IMMICH_*):
# - models stay loaded (TTL 0 turns off unloading and the idle shutdown); the container's sleepAfter handles idling
# - one gunicorn worker on port 3003
# - single-threaded ONNX runs for a 1 vCPU instance; two request threads let a search run beside an image job
ENV MACHINE_LEARNING_MODEL_TTL=0 \
    MACHINE_LEARNING_WORKERS=1 \
    IMMICH_PORT=3003 \
    MACHINE_LEARNING_MODEL_INTRA_OP_THREADS=1 \
    MACHINE_LEARNING_MODEL_INTER_OP_THREADS=1 \
    MACHINE_LEARNING_REQUEST_THREADS=2
COPY bake.py /usr/src/bake.py

# Text queries only: the textual model preloads at startup, so the first search does not pay the load.
FROM common AS search
ENV MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL=ViT-B-16-SigLIP2__webli
# Download the model from Hugging Face (build time only) and check the server loads and runs it.
RUN python /usr/src/bake.py textual && rm /usr/src/bake.py
# Never reach for Hugging Face at runtime.
ENV HF_HUB_OFFLINE=1
EXPOSE 3003

# Image jobs: all four models preload at startup, so the first /predict does not pay the load.
FROM common AS full
ENV MACHINE_LEARNING_PRELOAD__CLIP__VISUAL=ViT-B-16-SigLIP2__webli \
    MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL=ViT-B-16-SigLIP2__webli \
    MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__DETECTION=buffalo_l \
    MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__RECOGNITION=buffalo_l
RUN python /usr/src/bake.py && rm /usr/src/bake.py
ENV HF_HUB_OFFLINE=1
EXPOSE 3003
