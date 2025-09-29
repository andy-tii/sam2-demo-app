import os
import io
import json
import base64
import random
import string
import numpy as np
from typing import List, Dict, Optional
from datetime import datetime

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

import torch
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

# -------------------------
# Config
# -------------------------
MASK_DIR = "./input/benchmark_from_sam2/masks"
IMAGES_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "images")
EMB_DIR = "/home/storage/andy/embeddings"  # <--- embeddings saved here
LOGS_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")

os.makedirs(MASK_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

CHECKPOINT_PATH = "/home/andy/sam_app/interactive-sam2/sam2/checkpoints/sam2.1_hiera_large.pt"
CONFIG_NAME = "configs/sam2.1/sam2.1_hiera_l.yaml"

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
# SAM2 model init (once)
# -------------------------
print("Loading SAM2 model...")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MODEL = build_sam2(CONFIG_NAME, CHECKPOINT_PATH).to(DEVICE)
print("✅ SAM2 model loaded.")

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
    base, _ = os.path.splitext(image_name)
    mdir = os.path.join(MASK_DIR, f"{base}_{query_id}")
    os.makedirs(mdir, exist_ok=True)
    return mdir

def load_embeddings(image_name: str) -> Optional[dict]:
    """
    Load precomputed embeddings (.npy) for an image.
    """
    base, _ = os.path.splitext(image_name)
    path = os.path.join(EMB_DIR, f"{base}_features.npy")
    if not os.path.exists(path):
        print(f"[WARN] No embeddings found for {image_name}")
        return None

    data = np.load(path, allow_pickle=True).item()
    feats = {
        "image_embed": torch.from_numpy(data["image_embed"]).to(DEVICE),
        "high_res_feats": [torch.from_numpy(f).to(DEVICE) for f in data["high_res_feats"]],
    }
    feats["image_size"] = tuple(data.get("image_size", (None, None)))
    return feats

def run_sam2(image_name: str, points: List[Dict]) -> Optional[str]:
    """
    Run SAM2 prediction using precomputed embeddings.
    """
    try:
        feats = load_embeddings(image_name)
        if feats is None:
            return None

        # Inject features directly
        predictor = SAM2ImagePredictor(MODEL)
        predictor._features = {
            "image_embed": feats["image_embed"],
            "high_res_feats": feats["high_res_feats"],
        }
        predictor._orig_hw = [(feats["image_size"][1], feats["image_size"][0])]  # (H,W)
        predictor._is_image_set = True

        if not points:
            return None

        pts = np.array([[p["x"], p["y"]] for p in points], dtype=np.float32)
        labels = np.array([p.get("label", 1) for p in points], dtype=np.int32)

        masks, scores, _ = predictor.predict(
            point_coords=pts,
            point_labels=labels,
            multimask_output=True,
        )
        best_mask = masks[np.argmax(scores)]

        # Convert binary mask to grayscale PNG
        mask_img = Image.fromarray((best_mask * 255).astype(np.uint8), mode="L")
        buf = io.BytesIO()
        mask_img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    except Exception as e:
        print("SAM2 decode failed:", e)
        return None

def make_preview_overlay(image_name: str, mask_b64: str) -> Optional[str]:
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
    mask_b64 = run_sam2(req.image_name, [p.dict() for p in req.points])
    return {"mask_png_b64": mask_b64}

@app.post("/preview")
def preview(req: ClickRequest):
    mask_b64 = run_sam2(req.image_name, [p.dict() for p in req.points])
    if not mask_b64:
        return {"mask_png_b64": None}
    overlay_b64 = make_preview_overlay(req.image_name, mask_b64)
    return {"mask_png_b64": overlay_b64}

@app.post("/save")
def save(req: SaveRequest):
    try:
        mdir = mask_dir_for(req.image_name, req.query_id)

        mask_bytes = base64.b64decode(req.mask_png_b64)
        mask_img = Image.open(io.BytesIO(mask_bytes)).convert("L")
        mask_np = np.array(mask_img)

        mask_name = f"{random_id(10)}.npy"
        out_path = os.path.join(mdir, mask_name)
        np.save(out_path, mask_np)

        # update metadata
        meta_path = os.path.join(mdir, "mask_metadata.json")
        if os.path.exists(meta_path):
            with open(meta_path, "r") as f:
                names = json.load(f)
        else:
            names = []
        if mask_name not in names:
            names.append(mask_name)
        with open(meta_path, "w") as f:
            json.dump(names, f, indent=2)

        return {"status": "ok", "saved": [mask_name]}
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
