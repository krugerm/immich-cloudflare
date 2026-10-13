"""Build step for the `ml` image: download the models into Immich's model cache, then check the server loads them.

Runs once during `docker build`, inside the Immich machine-learning image. It uses Immich's own model classes to
download, so the cache layout (/cache/<task>/<model>/<type>/model.onnx) is the one the server reads. The check starts
the real server with the runtime environment of the image, posts an image and a text query to /predict and asserts the
embedding sizes. Files the check writes (ONNX graphs prepared for the build host's CPU) are removed afterwards: they
are tied to that CPU, and the server prepares them again on first load.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests
from PIL import Image

from immich_ml.config import settings
from immich_ml.models.clip.textual import OpenClipTextualEncoder
from immich_ml.models.clip.visual import OpenClipVisualEncoder
from immich_ml.models.facial_recognition.detection import FaceDetector
from immich_ml.models.facial_recognition.recognition import FaceRecognizer

CLIP = "ViT-B-16-SigLIP2__webli"
FACES = "buffalo_l"
CACHE = Path(settings.cache_folder)
PORT = int(os.environ.get("IMMICH_PORT", "3003"))


def download(textual_only: bool) -> None:
    models = [(OpenClipTextualEncoder, CLIP)] if textual_only else [
        (OpenClipVisualEncoder, CLIP),
        (OpenClipTextualEncoder, CLIP),
        (FaceDetector, FACES),
        (FaceRecognizer, FACES),
    ]
    for cls, name in models:
        model = cls(name)
        model.download()
        assert model.cached, f"{cls.__name__} {name}: no model file at {model.model_path}"
        print(f"baked {model.model_task.value}/{name}/{model.model_type.value}: {model.model_path}", flush=True)
    # Hugging Face's own cache (HF_HOME=/cache/hf-cache) holds only download logs and staging once the files are in
    # the model directories.
    shutil.rmtree(os.environ.get("HF_HOME", CACHE / "hf-cache"), ignore_errors=True)


def files() -> set[Path]:
    return {p for p in CACHE.rglob("*")}


def predict(entries: dict, data: dict | None = None, files: dict | None = None) -> dict:
    res = requests.post(
        f"http://127.0.0.1:{PORT}/predict",
        data={"entries": json.dumps(entries), **(data or {})},
        files=files,
        timeout=300,
    )
    assert res.status_code == 200, f"/predict {res.status_code}: {res.text}"
    return res.json()


def check(textual_only: bool) -> None:
    env = {**os.environ, "HF_HUB_OFFLINE": "1"}
    server = subprocess.Popen([sys.executable, "-m", "immich_ml"], env=env)
    try:
        deadline = time.time() + 600
        while True:
            assert server.poll() is None, "ml server exited during the build check"
            try:
                if requests.get(f"http://127.0.0.1:{PORT}/ping", timeout=5).text == "pong":
                    break
            except requests.RequestException:
                pass
            assert time.time() < deadline, "ml server did not answer /ping"
            time.sleep(1)

        text = predict({"clip": {"textual": {"modelName": CLIP, "options": {}}}}, data={"text": "a photo of a beach"})
        assert len(json.loads(text["clip"])) == 768, "clip textual size"
        if textual_only:
            print("build check: clip textual 768", flush=True)
            return

        buf = io.BytesIO()
        Image.new("RGB", (640, 480), (90, 140, 200)).save(buf, "JPEG")
        image = predict(
            {
                "clip": {"visual": {"modelName": CLIP}},
                "facial-recognition": {
                    "detection": {"modelName": FACES, "options": {"minScore": 0.7}},
                    "recognition": {"modelName": FACES},
                },
            },
            files={"image": ("blob", buf.getvalue())},
        )
        clip = json.loads(image["clip"])
        assert len(clip) == 768, f"clip visual has {len(clip)} values"
        assert isinstance(image["facial-recognition"], list), image
        assert (image["imageWidth"], image["imageHeight"]) == (640, 480), image
        print("build check: clip visual 768, clip textual 768, facial-recognition loaded", flush=True)
    finally:
        server.terminate()
        server.wait(timeout=60)


def main() -> None:
    # `bake.py textual`: the search image, text encoder only; no argument: all four models.
    textual_only = sys.argv[1:] == ["textual"]
    download(textual_only)
    baked = files()
    check(textual_only)
    # Remove what the check added (CPU-specific prepared graphs), deepest paths first.
    for p in sorted(files() - baked, key=lambda p: len(p.parts), reverse=True):
        if p.is_dir():
            p.rmdir()
        else:
            p.unlink()
    assert files() == baked, f"cache differs from the baked state: {sorted(files() ^ baked)}"
    print("cache back to the baked state", flush=True)


if __name__ == "__main__":
    main()
