import io
import base64
import uuid
from typing import List, Dict

import numpy as np
from fastapi import FastAPI, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

import torch
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor

# -----------------------
# Config
# -----------------------
CHECKPOINT_PATH = "/home/andy/sam_app/interactive-sam2/sam2/checkpoints/sam2.1_hiera_large.pt"
CONFIG_NAME = "configs/sam2.1/sam2.1_hiera_l.yaml"

# -----------------------
# App setup
# -----------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------
# Engine
# -----------------------
class Session:
    def __init__(self, predictor: SAM2ImagePredictor, image_array: np.ndarray):
        self.predictor = predictor
        self.image_array = image_array

class Engine:
    def __init__(self):
        print("Loading SAM2 model...")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = build_sam2(CONFIG_NAME, CHECKPOINT_PATH)
        self.model = model.to(device)
        self.sessions: Dict[str, Session] = {}

    def create_session(self, pil_img: Image.Image) -> str:
        arr = np.array(pil_img.convert("RGB"))
        predictor = SAM2ImagePredictor(self.model)
        predictor.set_image(arr)
        sid = str(uuid.uuid4())
        self.sessions[sid] = Session(predictor, arr)
        return sid

    def predict_from_points(self, sid: str, points: List[Dict[str, int]]):
        if sid not in self.sessions:
            raise ValueError("Invalid session id")
        session = self.sessions[sid]
        predictor = session.predictor

        if not points:
            return None

        pts = np.array([[p["x"], p["y"]] for p in points], dtype=np.float32)
        labels = np.ones(len(points), dtype=np.int32)

        masks, scores, logits = predictor.predict(
            point_coords=pts,
            point_labels=labels,
            multimask_output=True
        )
        best_mask = masks[np.argmax(scores)]

        # Convert mask to transparent RGBA overlay
        mask_img = Image.fromarray((best_mask * 255).astype(np.uint8), mode="L")
        rgba = Image.new("RGBA", mask_img.size, (0, 0, 0, 0))
        rgba.paste((0, 255, 0, 120), mask=mask_img)

        buf = io.BytesIO()
        rgba.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")

ENGINE = Engine()

# -----------------------
# API Models
# -----------------------
class ClickData(BaseModel):
    session_id: str
    points: List[Dict[str, int]]

# -----------------------
# Endpoints
# -----------------------
@app.post("/upload")
async def upload(file: UploadFile):
    try:
        img = Image.open(file.file).convert("RGB")
    except Exception:
        return {"error": "Invalid image"}
    sid = ENGINE.create_session(img)
    w, h = img.size
    return {"session_id": sid, "width": w, "height": h}

@app.post("/click")
async def click(data: ClickData):
    try:
        mask_b64 = ENGINE.predict_from_points(data.session_id, data.points)
        if mask_b64 is None:
            return {"error": "no points provided"}
    except Exception as e:
        return {"error": str(e)}
    return {"mask_png_b64": mask_b64}
