import os
import io
import json
import base64
import random
import string
import numpy as np
import requests
from typing import List, Dict, Optional
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
from datetime import datetime
import colorsys

# -------------------------
# Config
# -------------------------
ROOT = os.path.dirname(__file__)
MASK_DIR = os.path.join(ROOT, "..", "public", "masks")
IMAGES_DIR = os.path.join(ROOT, "..", "public", "images")
LOGS_DIR = os.path.join(ROOT, "..", "logs")
os.makedirs(MASK_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

TORCHSERVE_URL = "http://localhost:7779/predict"  # fixed

# -------------------------
# App Setup
# -------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # dev-friendly; tighten for production
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Models
# -------------------------
class Point(BaseModel):
    x: int
    y: int
    label: int = 1

class ClickRequest(BaseModel):
    chunk_id: int
    index: int
    image_name: str
    query_id: int
    width: int
    height: int
    points: List[Point]

class SaveRequest(BaseModel):
    image_name: str
    query_id: int
    mask_png_b64: str

class DeleteRequest(BaseModel):
    image_name: str
    query_id: int
    mask_name: str

class LogRequest(BaseModel):
    chunk_id: int
    index: int
    image_name: str
    query_id: int
    action: str  # "done" or "skip"

# -------------------------
# Helpers
# -------------------------
def random_id(n: int = 10) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))

def mask_dir_for(image_name: str, query_id: int) -> str:
    base, _ = os.path.splitext(image_name)
    mdir = os.path.join(MASK_DIR, f"{base}_{query_id}")
    os.makedirs(mdir, exist_ok=True)
    return mdir

def load_meta(mdir: str) -> list:
    path = os.path.join(mdir, "mask_metadata.json")
    if os.path.exists(path):
        try:
            with open(path, "r") as f:
                return json.load(f)
        except Exception:
            return []
    return []

def save_meta(mdir: str, names: list):
    path = os.path.join(mdir, "mask_metadata.json")
    with open(path, "w") as f:
        json.dump(names, f, indent=2)

def update_metadata(mdir: str, mask_name: str):
    names = load_meta(mdir)
    if mask_name not in names:
        names.append(mask_name)
    save_meta(mdir, names)

def call_torchserve(image_name: str, points: List[Dict]) -> Optional[str]:
    try:
        img_path = os.path.join(IMAGES_DIR, image_name)
        with open(img_path, "rb") as f:
            image_bytes = f.read()

        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        payload = {"image": image_b64, "points": points}
        resp = requests.post(TORCHSERVE_URL, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json().get("mask_png_b64")
    except Exception as e:
        print("TorchServe failed:", e)
        return None

# ---- Per-mask thumbnail helper (RED overlay) ----
def make_single_mask_thumbnail(image_name: str, mask_np: np.ndarray, thumb_w: int = 320) -> str:
    """
    Make a thumbnail that overlays ONE mask on the base image (red overlay).
    """
    img_path = os.path.join(IMAGES_DIR, image_name)
    base_img = Image.open(img_path).convert("RGBA")

    h, w = mask_np.shape[:2]
    if base_img.size != (w, h):
        base_img = base_img.resize((w, h), Image.BILINEAR)

    alpha = Image.fromarray((mask_np > 0).astype(np.uint8) * 100, mode="L")  # ~39% opacity
    color_img = Image.new("RGBA", (w, h), (255, 0, 0, 0))  # red overlay
    color_img.putalpha(alpha)
    composed = Image.alpha_composite(base_img, color_img)

    if composed.width > thumb_w:
        ratio = thumb_w / composed.width
        composed = composed.resize((thumb_w, int(composed.height * ratio)), Image.BILINEAR)

    buf = io.BytesIO()
    composed.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

# ---- Combined thumbnail (each mask different color) ----
def distinct_colors(n: int):
    if n <= 0:
        return []
    hues = [i / n for i in range(n)]
    return [
        tuple(int(c * 255) for c in colorsys.hsv_to_rgb(h, 0.8, 1.0))
        for h in hues
    ]

def make_combined_thumbnail(image_name: str, mask_paths: List[str], thumb_w: int = 320) -> str:
    img_path = os.path.join(IMAGES_DIR, image_name)
    base_img = Image.open(img_path).convert("RGBA")

    masks: List[np.ndarray] = []
    for p in mask_paths:
        try:
            masks.append(np.load(p))
        except Exception:
            pass

    if not masks:
        return ""

    h, w = masks[0].shape[:2]
    if base_img.size != (w, h):
        base_img = base_img.resize((w, h), Image.BILINEAR)

    colors = distinct_colors(len(masks))
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    for mask_np, color in zip(masks, colors):
        alpha = Image.fromarray((mask_np > 0).astype(np.uint8) * 110, mode="L")  # slightly stronger
        color_img = Image.new("RGBA", (w, h), color + (0,))
        color_img.putalpha(alpha)
        overlay = Image.alpha_composite(overlay, color_img)

    composed = Image.alpha_composite(base_img, overlay)

    if composed.width > thumb_w:
        ratio = thumb_w / composed.width
        composed = composed.resize((thumb_w, int(composed.height * ratio)), Image.BILINEAR)

    buf = io.BytesIO()
    composed.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")

# ---- Logging helpers ----
def _log_path(chunk_id: int) -> str:
    return os.path.join(LOGS_DIR, f"chunk_{chunk_id}.jsonl")

def append_log(entry: dict):
    path = _log_path(entry["chunk_id"])
    entry = {**entry, "ts": datetime.utcnow().isoformat() + "Z"}
    with open(path, "a") as f:
        f.write(json.dumps(entry) + "\n")

def load_processed(chunk_id: int) -> Dict[int, str]:
    """
    Return {index: action} for actions in {'done','skip'}.
    Later entries overwrite earlier ones.
    """
    path = _log_path(chunk_id)
    results: Dict[int, str] = {}
    if not os.path.exists(path):
        return results
    with open(path, "r") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("chunk_id") != chunk_id:
                continue
            idx = obj.get("index")
            act = obj.get("action")
            if isinstance(idx, int) and act in {"done", "skip"}:
                results[idx] = act
    return results

# -------------------------
# Endpoints
# -------------------------
@app.post("/click")
def click(req: ClickRequest):
    mask_b64 = call_torchserve(req.image_name, [p.dict() for p in req.points])
    return {"mask_png_b64": mask_b64}

@app.post("/preview")
def preview(req: ClickRequest):
    mask_b64 = call_torchserve(req.image_name, [p.dict() for p in req.points])
    return {"mask_png_b64": mask_b64}

@app.post("/save")
def save(req: SaveRequest):
    try:
        mask_bytes = base64.b64decode(req.mask_png_b64)
        mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
        mask_np = np.array(mask_img)

        mdir = mask_dir_for(req.image_name, req.query_id)
        mask_name = f"{random_id(10)}.npy"
        out_path = os.path.join(mdir, mask_name)
        np.save(out_path, mask_np)

        update_metadata(mdir, mask_name)
        return {"status": "ok", "mask_name": mask_name}
    except Exception as e:
        return {"error": str(e)}

@app.get("/masks")
def list_masks(image_name: str = Query(...), query_id: int = Query(...)):
    """
    Return:
      {
        "combined_thumb_png_b64": "...",   # all masks layered, different colors
        "masks": [{ name, thumb_png_b64 }, ...]  # individual thumbnails (red)
      }
    """
    mdir = mask_dir_for(image_name, query_id)
    names = load_meta(mdir)

    items = []
    mask_paths = []
    for n in names:
        mask_path = os.path.join(mdir, n)
        if not os.path.exists(mask_path):
            continue
        mask_paths.append(mask_path)
        try:
            mask_np = np.load(mask_path)
        except Exception:
            continue
        thumb_b64 = make_single_mask_thumbnail(image_name, mask_np)
        items.append({"name": n, "thumb_png_b64": thumb_b64})

    combined_b64 = make_combined_thumbnail(image_name, mask_paths) if mask_paths else ""

    return {"combined_thumb_png_b64": combined_b64, "masks": items}

@app.delete("/delete")
def delete(req: DeleteRequest):
    try:
        mdir = mask_dir_for(req.image_name, req.query_id)
        fpath = os.path.join(mdir, req.mask_name)
        if os.path.exists(fpath):
            os.remove(fpath)
        names = [n for n in load_meta(mdir) if n != req.mask_name]
        save_meta(mdir, names)
        return {"status": "deleted"}
    except Exception as e:
        return {"error": str(e)}

# ---- Logging endpoints ----
@app.post("/log")
def log_action(req: LogRequest):
    if req.action not in {"done", "skip"}:
        return {"error": "action must be 'done' or 'skip'"}
    append_log({
        "chunk_id": req.chunk_id,
        "index": req.index,
        "image_name": req.image_name,
        "query_id": req.query_id,
        "action": req.action,
    })
    return {"status": "ok"}

@app.get("/status")
def get_status(chunk_id: int = Query(...)):
    processed = load_processed(chunk_id)
    return {"processed": {str(k): v for k, v in processed.items()}}
