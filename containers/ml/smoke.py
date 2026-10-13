"""Smoke test for the `ml` image, run inside the container (`docker exec`) so the container can stay offline.

Usage: python smoke.py <face photo path> <container start epoch seconds>

Polls /predict with the photo until the server answers, which gives the cold start (container start to first
successful /predict). Then checks the request shapes the Worker client sends: image -> 768-d clip and at least one
face with a 512-d embedding; text -> 768-d clip; and the status codes the client maps to MlInputError.
"""

import json
import sys
import time

import requests

URL = "http://127.0.0.1:3003/predict"
CLIP = "ViT-B-16-SigLIP2__webli"
FACES = "buffalo_l"
IMAGE_ENTRIES = {
    "clip": {"visual": {"modelName": CLIP}},
    "facial-recognition": {
        "detection": {"modelName": FACES, "options": {"minScore": 0.7}},
        "recognition": {"modelName": FACES},
    },
}


def post(entries: dict, image: bytes | None = None, text: str | None = None, timeout: float = 120) -> requests.Response:
    files = {"image": ("blob", image)} if image is not None else None
    data = {"entries": json.dumps(entries), **({"text": text} if text is not None else {})}
    return requests.post(URL, data=data, files=files, timeout=timeout)


def main() -> None:
    photo = open(sys.argv[1], "rb").read()
    started = float(sys.argv[2])

    while True:
        try:
            res = post(IMAGE_ENTRIES, image=photo)
            if res.status_code == 200:
                break
            print(f"waiting: /predict {res.status_code}", flush=True)
        except requests.RequestException as e:
            print(f"waiting: {type(e).__name__}", flush=True)
        if time.time() - started > 600:
            sys.exit("no successful /predict within 600 s")
        time.sleep(0.5)
    cold = time.time() - started
    print(f"cold start (container start to first successful /predict): {cold:.1f} s", flush=True)

    body = res.json()
    clip = json.loads(body["clip"])
    faces = body["facial-recognition"]
    print(f"image {body['imageWidth']}x{body['imageHeight']}: clip {len(clip)}-d, {len(faces)} face(s)")
    for f in faces:
        emb = json.loads(f["embedding"])
        print(f"  face score {f['score']:.3f} box {f['boundingBox']} embedding {len(emb)}-d")
    assert len(clip) == 768, "clip visual must be 768-d"
    assert len(faces) >= 1, "expected at least one face"
    assert all(len(json.loads(f["embedding"])) == 512 for f in faces), "face embeddings must be 512-d"

    t = time.time()
    res = post(IMAGE_ENTRIES, image=photo)
    print(f"warm image /predict (clip + faces): {(time.time() - t) * 1000:.0f} ms, status {res.status_code}")

    t = time.time()
    res = post({"clip": {"textual": {"modelName": CLIP, "options": {}}}}, text="a portrait of a man in a suit")
    text = json.loads(res.json()["clip"])
    print(f"text /predict: {(time.time() - t) * 1000:.0f} ms, clip {len(text)}-d")
    assert len(text) == 768, "clip textual must be 768-d"
    sim = sum(a * b for a, b in zip(clip, text))
    print(f"image-text dot product (SigLIP2, normalised): {sim:.4f}")

    for label, kwargs in (
        ("garbage image bytes", {"entries": IMAGE_ENTRIES, "image": b"not an image at all"}),
        ("truncated JPEG", {"entries": IMAGE_ENTRIES, "image": photo[: len(photo) // 3]}),
        ("no image or text", {"entries": IMAGE_ENTRIES}),
        ("empty entries", {"entries": {}, "text": "x"}),
    ):
        r = post(**kwargs)
        print(f"{label}: status {r.status_code} body {r.text[:120]!r}")
    print("SMOKE OK")


if __name__ == "__main__":
    main()
