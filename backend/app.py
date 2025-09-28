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

# -------------------------
# Config
# -------------------------
# Fixed mask root path
MASK_DIR = "./input/benchmark_from_sam2/masks"
IMAGES_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "images")
LOGS_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")

os.makedirs(MASK_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

TORCHSERVE_URL = "http://localhost:7779/predict"  # fixed

# -------------------------
# App Setup
# -------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev-friendly; tighten for production
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
    """
    Each image/query gets its own subdir inside MASK_DIR
    """
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

def make_preview_overlay(image_name: str, mask_b64: str) -> Optional[str]:
    """
    Overlay mask (red transparent) on the original image for preview only.
    """
    try:
        mask_bytes = base64.b64decode(mask_b64)
        mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
        mask_np = np.array(mask_img)

        img_path = os.path.join(IMAGES_DIR, image_name)
        base_img = Image.open(img_path).convert("RGBA")
        base_img = base_img.resize(mask_img.size, Image.BILINEAR)

        alpha = Image.fromarray((mask_np > 0).astype(np.uint8) * 120, mode="L")
        red_img = Image.new("RGBA", base_img.size, (255, 0, 0, 0))
        red_img.putalpha(alpha)

        composed = Image.alpha_composite(base_img, red_img)

        buf = io.BytesIO()
        composed.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as e:
        print("Preview overlay failed:", e)
        return None

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
    """
    Generate a mask for a clicked point (single point).
    Returns raw mask (not red overlay).
    """
    mask_b64 = call_torchserve(req.image_name, [p.dict() for p in req.points])
    return {"mask_png_b64": mask_b64}

@app.post("/preview")
def preview(req: ClickRequest):
    """
    Generate a red overlay preview for hover.
    """
    mask_b64 = call_torchserve(req.image_name, [p.dict() for p in req.points])
    if not mask_b64:
        return {"mask_png_b64": None}
    overlay_b64 = make_preview_overlay(req.image_name, mask_b64)
    return {"mask_png_b64": overlay_b64}

@app.post("/save")
def save(req: SaveRequest):
    """
    Save multiple masks at once.
    """
    try:
        mdir = mask_dir_for(req.image_name, req.query_id)
        
        saved_names = []
        mask_b64=req.mask_png_b64
        mask_bytes = base64.b64decode(mask_b64)
        mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
        mask_np = np.array(mask_img)
        mask_name = f"{random_id(10)}.npy"
        out_path = os.path.join(mdir, mask_name)
        np.save(out_path, mask_np)

        update_metadata(mdir, mask_name)
        saved_names.append(mask_name)

        return {"status": "ok", "saved": saved_names}
    except Exception as e:
        return {"error": str(e)}

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
