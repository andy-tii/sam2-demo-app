import os
import base64
from typing import List, Dict

import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# -------------------------
# Config
# -------------------------
TORCHSERVE_URL = "http://localhost:7779/predict"  # don't change per your note

# -------------------------
# App Setup
# -------------------------
app = FastAPI()

# Allow CORS for all (React dev server, ngrok, etc.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # you can restrict later if needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Request Models
# -------------------------
class Point(BaseModel):
    x: int
    y: int
    label: int = 1  # default positive

class ClickRequest(BaseModel):
    chunk_id: int
    index: int
    image_name: str
    width: int
    height: int
    points: List[Point]

# -------------------------
# Helpers
# -------------------------
def call_torchserve(image_name: str, points: List[Dict]) -> str | None:
    """
    Forward request to TorchServe with image path and points.
    Expects TorchServe handler to return {"mask_png_b64": "..."}.
    """
    try:
        img_path = os.path.join("..", "public", "images", image_name)
        with open(img_path, "rb") as f:
            image_bytes = f.read()

        image_b64 = base64.b64encode(image_bytes).decode("utf-8")

        payload = {"image": image_b64, "points": points}
        resp = requests.post(TORCHSERVE_URL, json=payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data.get("mask_png_b64")
    except Exception as e:
        print("TorchServe call failed:", e)
        return None

# -------------------------
# Endpoints
# -------------------------
@app.post("/click")
async def click(data: ClickRequest):
    try:
        mask_b64 = call_torchserve(data.image_name, [p.dict() for p in data.points])
        return {"mask_png_b64": mask_b64}
    except Exception as e:
        return {"error": str(e)}

@app.post("/preview")
async def preview(data: ClickRequest):
    try:
        mask_b64 = call_torchserve(data.image_name, [p.dict() for p in data.points])
        return {"mask_png_b64": mask_b64}
    except Exception as e:
        return {"error": str(e)}

# -------------------------
# Run
# -------------------------
# Run with: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
