import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import metadata from "./data/metadata.json";

type DispPt = { x: number; y: number };
type ImgPt = { x: number; y: number };
type Example = {
  image_name: string;
  image_path: string;
  objects?: string[];
};

type Status = "Ready" | "Loading image..." | "Processing..." | "Previewing...";

const MAX_DISPLAY_W = 900;
const MAX_DISPLAY_H = 700;

export default function App() {
  const imgRef = useRef<HTMLImageElement | null>(null);

  // navigation
  const [chunkId, setChunkId] = useState<number>(0);
  const [exampleIdx, setExampleIdx] = useState<number>(0);
  const [currentExample, setCurrentExample] = useState<Example | null>(null);

  // overlays & points
  const [mask, setMask] = useState<string | null>(null);
  const [previewMask, setPreviewMask] = useState<string | null>(null);
  const [dots, setDots] = useState<DispPt[]>([]);
  const [points, setPoints] = useState<ImgPt[]>([]);

  // sizing & loading
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [imageKey, setImageKey] = useState<number>(0);
  const [status, setStatus] = useState<Status>("Ready");

  // hover timer
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const chunk = (metadata as any)[chunkId.toString()];
    if (!chunk) return;
    const ex = chunk[exampleIdx] || null;
    setCurrentExample(ex);

    setMask(null);
    setPreviewMask(null);
    setDots([]);
    setPoints([]);
    setNaturalSize(null);
    setDisplaySize(null);
    setScale(1);
    setStatus("Loading image...");
    setImageKey((k) => k + 1);
  }, [chunkId, exampleIdx]);

  const computeDisplayFromNatural = (nw: number, nh: number) => {
    const s = Math.min(1, MAX_DISPLAY_W / nw, MAX_DISPLAY_H / nh);
    return { w: Math.round(nw * s), h: Math.round(nh * s), s };
  };

  const getCoords = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !naturalSize || !displaySize)
      return { imgX: -1, imgY: -1, dispX: 0, dispY: 0 };

    const rect = img.getBoundingClientRect();
    const dispX = e.clientX - rect.left;
    const dispY = e.clientY - rect.top;

    if (dispX < 0 || dispY < 0 || dispX > rect.width || dispY > rect.height) {
      return { imgX: -1, imgY: -1, dispX, dispY };
    }

    const imgX = Math.round(dispX / scale);
    const imgY = Math.round(dispY / scale);

    return { imgX, imgY, dispX, dispY };
  };

  const findNearbyIndex = (dispX: number, dispY: number, tol = 8) =>
    dots.findIndex((p) => Math.hypot(p.x - dispX, p.y - dispY) <= tol);

  // ---------- API helpers with axios ----------
  async function requestCommit(newPoints: ImgPt[]) {
    const res = await axios.post("/click", {
      chunk_id: chunkId,
      index: exampleIdx,
      points: newPoints,
      width: naturalSize?.w,
      height: naturalSize?.h,
      image_name: currentExample?.image_name,
    });
    return res.data;
  }

  async function requestPreview(allPointsPlusHover: ImgPt[]) {
    try {
      const r = await axios.post("/preview", {
        chunk_id: chunkId,
        index: exampleIdx,
        points: allPointsPlusHover,
        width: naturalSize?.w,
        height: naturalSize?.h,
        image_name: currentExample?.image_name,
      });
      return r.data;
    } catch (_) {
      const res = await axios.post("/click?preview=1", {
        chunk_id: chunkId,
        index: exampleIdx,
        points: allPointsPlusHover,
        width: naturalSize?.w,
        height: naturalSize?.h,
        image_name: currentExample?.image_name,
      });
      return res.data;
    }
  }

  // ------------- click toggle -------------
  const onImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status !== "Ready" || !naturalSize || !displaySize) return;

    const { imgX, imgY, dispX, dispY } = getCoords(e);
    if (imgX < 0 || imgY < 0) return;

    setPreviewMask(null);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }

    const idx = findNearbyIndex(dispX, dispY);
    const newPoints = [...points];
    const newDots = [...dots];

    if (idx !== -1) {
      newPoints.splice(idx, 1);
      newDots.splice(idx, 1);
    } else {
      newPoints.push({ x: imgX, y: imgY });
      newDots.push({ x: dispX, y: dispY });
    }

    setPoints(newPoints);
    setDots(newDots);

    if (newPoints.length === 0) {
      setMask(null);
      return;
    }

    setStatus("Processing...");
    try {
      const data = await requestCommit(newPoints);
      if (data.mask_png_b64) {
        setMask(`data:image/png;base64,${data.mask_png_b64}`);
      } else {
        setMask(null);
      }
    } catch (err) {
      console.error("Commit request failed:", err);
      setMask(null);
    } finally {
      setStatus("Ready");
    }
  };

  // ------------- hover preview -------------
  const onMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status !== "Ready" || !naturalSize || !displaySize) return;

    const { imgX, imgY } = getCoords(e);
    if (imgX < 0 || imgY < 0) {
      setPreviewMask(null);
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      }
      return;
    }

    setPreviewMask(null);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      setStatus("Previewing...");
      try {
        const data = await requestPreview([...points, { x: imgX, y: imgY }]);
        if (data.mask_png_b64) {
          setPreviewMask(`data:image/png;base64,${data.mask_png_b64}`);
        }
      } catch (err) {
        console.error("Preview request failed:", err);
      } finally {
        setStatus("Ready");
      }
    }, 500);
  };

  const onMouseLeave = () => {
    setPreviewMask(null);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const clearPoints = () => {
    if (status !== "Ready") return;
    setDots([]);
    setPoints([]);
    setMask(null);
    setPreviewMask(null);
  };

  // ---------- UI ----------
  const chunk = (metadata as any)[chunkId.toString()] || [];
  const example = currentExample;

  return (
    <div style={{ fontFamily: "sans-serif", minHeight: "100vh", display: "grid", gridTemplateRows: "auto 1fr auto" }}>
      {/* Top bar */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          alignItems: "start",
          gap: 16,
          padding: 16,
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            {example ? example.image_name : "No image"}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <label>
              Chunk:&nbsp;
              <select
                value={chunkId}
                onChange={(e) => {
                  if (status !== "Ready") return;
                  setChunkId(parseInt(e.target.value));
                  setExampleIdx(0);
                }}
                disabled={status !== "Ready"}
              >
                {Object.keys(metadata).map((cid) => (
                  <option key={cid} value={parseInt(cid)}>
                    {cid}
                  </option>
                ))}
              </select>
            </label>

            <button disabled={exampleIdx === 0 || status !== "Ready"} onClick={() => setExampleIdx((i) => i - 1)}>
              ⬅ Previous
            </button>
            <button
              disabled={!chunk.length || exampleIdx >= chunk.length - 1 || status !== "Ready"}
              onClick={() => setExampleIdx((i) => i + 1)}
            >
              Next ➡
            </button>

            <button onClick={clearPoints} disabled={!example || status !== "Ready"}>
              Clear points
            </button>

            <span style={{ color: "#6b7280" }}>{chunk.length ? `${exampleIdx + 1}/${chunk.length}` : ""}</span>
          </div>

          <div style={{ fontWeight: 700, color: "#d97706" }}>{status}</div>
        </div>

        <div style={{ textAlign: "right" }}>
          {example?.objects && (
            <div style={{ display: "inline-block", textAlign: "left" }}>
              <strong>Objects</strong>
              <ul style={{ marginTop: 6, marginBottom: 0 }}>
                {example.objects.map((obj, i) => (
                  <li key={i}>{obj}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Bottom: image viewer */}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", padding: 16 }}>
        {example && (
          <div
            style={{
              position: "relative",
              display: "inline-block",
              width: displaySize ? `${displaySize.w}px` : "auto",
              height: displaySize ? `${displaySize.h}px` : "auto",
            }}
          >
            <img
              key={imageKey}
              ref={imgRef}
              src={`/images/${encodeURIComponent(example.image_name)}`}
              alt={example.image_name}
              style={{
                width: displaySize ? "100%" : undefined,
                height: displaySize ? "100%" : undefined,
                objectFit: "contain",
                border: "1px solid #ccc",
                borderRadius: 0,
                display: "block",
              }}
              onLoad={(e) => {
                const t = e.currentTarget;
                const nw = t.naturalWidth;
                const nh = t.naturalHeight;
                setNaturalSize({ w: nw, h: nh });
                const { w, h, s } = computeDisplayFromNatural(nw, nh);
                setDisplaySize({ w, h });
                setScale(s);
                setStatus("Ready");
              }}
              onClick={onImageClick}
              onMouseMove={onMouseMove}
              onMouseLeave={onMouseLeave}
            />

            {status === "Ready" && mask && displaySize && (
              <img
                src={mask}
                alt="mask"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  pointerEvents: "none",
                }}
              />
            )}

            {status === "Ready" && previewMask && displaySize && (
              <img
                src={previewMask}
                alt="preview-mask"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  pointerEvents: "none",
                }}
              />
            )}

            {status === "Ready" &&
              dots.map((p, i) => (
                <div
                  key={`dot-${i}`}
                  style={{
                    position: "absolute",
                    left: p.x - 4,
                    top: p.y - 4,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "red",
                    border: "1px solid white",
                    pointerEvents: "none",
                  }}
                />
              ))}
          </div>
        )}
      </div>

      <div />

      {(status === "Uploading..." || status === "Processing...") && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(255,255,255,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            fontSize: 22,
            fontWeight: 800,
            color: "#1f2937",
            cursor: "wait",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
