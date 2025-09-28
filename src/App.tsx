import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import metadata from "./data/metadata.json";
import "bootstrap/dist/css/bootstrap.min.css";

type ImgPt = { x: number; y: number };
type Example = {
  image_name: string;
  image_path: string;
  query: string;
  query_id: number;
};

const CHUNK_LABELS: Record<string, string> = {
  0: "phuc",
  1: "yasser",
  2: "ankit",
  3: "sanath",
  4: "wamiq",
  5: "sofian",
  6: "andy",
};

type Status = "Ready" | "Loading image..." | "Processing..." | "Previewing...";

const MAX_DISPLAY_W = 1200;
const MAX_DISPLAY_H = 900;

// Configurable timers
const HOVER_DELAY_MS = 100; // hover wait
const CLICK_MASK_DISPLAY_MS = 200; // mask flash

export default function App() {
  const imgRef = useRef<HTMLImageElement | null>(null);

  // navigation
  const [chunkId, setChunkId] = useState<number>(0);
  const [exampleIdx, setExampleIdx] = useState<number>(0);
  const [currentExample, setCurrentExample] = useState<Example | null>(null);

  // masks
  const [masks, setMasks] = useState<string[]>([]);
  const [tempMask, setTempMask] = useState<string | null>(null);
  const [previewMask, setPreviewMask] = useState<string | null>(null);
  const [showAllMasks, setShowAllMasks] = useState<boolean>(false);

  // sizing
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [imageKey, setImageKey] = useState<number>(0);

  const [status, setStatus] = useState<Status>("Ready");
  const [processed, setProcessed] = useState<Record<number, "done" | "skip">>({});
  const [jumpValue, setJumpValue] = useState<string>("");

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- helpers ---
  const fetchProcessed = async (cid: number) => {
    try {
      const res = await axios.get("/status", { params: { chunk_id: cid } });
      const obj = (res.data?.processed || {}) as Record<string, "done" | "skip">;
      const map: Record<number, "done" | "skip"> = {};
      for (const k of Object.keys(obj)) map[parseInt(k, 10)] = obj[k];
      setProcessed(map);
    } catch {
      setProcessed({});
    }
  };

  const jumpToNextUnprocessed = () => {
    const list: Example[] = (metadata as any)[chunkId.toString()] || [];
    if (!list.length) return;
    for (let i = exampleIdx + 1; i < list.length; i++) {
      if (!(i in processed)) {
        setExampleIdx(i);
        return;
      }
    }
    for (let i = 0; i < list.length; i++) {
      if (!(i in processed)) {
        setExampleIdx(i);
        return;
      }
    }
  };

  const goToExample = () => {
    const list: Example[] = (metadata as any)[chunkId.toString()] || [];
    if (!list.length) return;
    let n = parseInt(jumpValue, 10);
    if (Number.isNaN(n)) return;
    n = Math.max(1, Math.min(n, list.length));
    setExampleIdx(n - 1);
  };

  // effects
  useEffect(() => {
    fetchProcessed(chunkId);
  }, [chunkId]);

  useEffect(() => {
    const list: Example[] = (metadata as any)[chunkId.toString()] || [];
    let idx = exampleIdx;
    if (idx >= list.length) {
      idx = 0;
      setExampleIdx(0);
    }
    const ex = list[idx] || null;
    setCurrentExample(ex);

    setMasks([]);
    setTempMask(null);
    setPreviewMask(null);
    setShowAllMasks(false);
    setNaturalSize(null);
    setDisplaySize(null);
    setScale(1);
    setStatus("Loading image...");
    setImageKey((k) => k + 1);
  }, [chunkId, exampleIdx]);

  // helpers
  const computeDisplayFromNatural = (nw: number, nh: number) => {
    const s = Math.min(1, MAX_DISPLAY_W / nw, MAX_DISPLAY_H / nh);
    return { w: Math.round(nw * s), h: Math.round(nh * s), s };
  };

  const getCoords = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !naturalSize || !displaySize) return { imgX: -1, imgY: -1 };
    const rect = img.getBoundingClientRect();
    const dispX = e.clientX - rect.left;
    const dispY = e.clientY - rect.top;
    if (dispX < 0 || dispY < 0 || dispX > rect.width || dispY > rect.height) {
      return { imgX: -1, imgY: -1 };
    }
    const imgX = Math.round(dispX / scale);
    const imgY = Math.round(dispY / scale);
    return { imgX, imgY };
  };

  // API helpers
  async function requestCommit(pt: ImgPt) {
    const res = await axios.post("/click", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      width: naturalSize?.w,
      height: naturalSize?.h,
      points: [{ ...pt, label: 1 }],
    });
    return res.data;
  }

  async function requestPreview(pt: ImgPt) {
    const res = await axios.post("/preview", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      width: naturalSize?.w,
      height: naturalSize?.h,
      points: [{ ...pt, label: 1 }],
    });
    return res.data;
  }

  async function requestSave(mask: string, imageName: string, queryId: number) {
    const b64 = mask.replace(/^data:image\/png;base64,/, "");
    const res = await axios.post("/save", {
      image_name: imageName,
      query_id: queryId,
      mask_png_b64: b64,
    });
    return res.data;
  }

  async function logAction(action: "done" | "skip") {
    await axios.post("/log", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      action,
    });
    setProcessed((prev) => ({ ...prev, [exampleIdx]: action }));
  }

  // click
  const onImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status === "Processing..." || !naturalSize || !displaySize) return;
    const { imgX, imgY } = getCoords(e);
    if (imgX < 0 || imgY < 0) return;
    setStatus("Processing...");
    try {
      const data = await requestCommit({ x: imgX, y: imgY });
      if (data.mask_png_b64) {
        const maskData = `data:image/png;base64,${data.mask_png_b64}`;
        setMasks((prev) => [...prev, maskData]);
        setTempMask(maskData);
        setTimeout(() => setTempMask(null), CLICK_MASK_DISPLAY_MS);
      }
    } finally {
      setStatus("Ready");
    }
  };

  // hover
  const onMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status === "Processing..." || !naturalSize || !displaySize) return;
    const { imgX, imgY } = getCoords(e);
    if (imgX < 0 || imgY < 0) {
      setPreviewMask(null);
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      return;
    }
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(async () => {
      setStatus("Previewing...");
      try {
        const data = await requestPreview({ x: imgX, y: imgY });
        if (data.mask_png_b64) {
          setPreviewMask(`data:image/png;base64,${data.mask_png_b64}`);
        }
      } finally {
        if (status !== "Processing...") setStatus("Ready");
      }
    }, HOVER_DELAY_MS);
  };

  const onMouseLeave = () => {
    setPreviewMask(null);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (status === "Previewing...") setStatus("Ready");
  };

  // ---------- UI ----------
  const chunk: Example[] = (metadata as any)[chunkId.toString()] || [];
  const example = currentExample;
  const maxExamples = chunk.length;

  return (
    <div className="d-flex flex-column min-vh-100">
      {/* Top toolbar */}
      <div className="border-bottom bg-light py-2">
        <div className="container d-flex justify-content-between align-items-center">
          <div className="d-flex flex-wrap align-items-center gap-2">
            <div className="d-flex align-items-center me-2">
              <span className="me-2">Chunk</span>
              <select
                className="form-select"
                style={{ minWidth: 160 }}
                value={chunkId}
                onChange={(e) => {
                  if (status === "Processing...") return;
                  setChunkId(parseInt(e.target.value, 10));
                  setExampleIdx(0);
                  setJumpValue("");
                }}
                disabled={status === "Processing..."}
              >
                {Object.keys(metadata)
                  .map(Number)
                  .sort((a, b) => a - b)
                  .map((cid) => {
                    const label = CHUNK_LABELS[String(cid)] ?? `Chunk ${cid}`;
                    return (
                      <option key={cid} value={cid}>
                        {label}
                      </option>
                    );
                  })}
              </select>
            </div>
            <button
              className="btn btn-outline-primary"
              disabled={exampleIdx === 0 || status === "Processing..."}
              onClick={() => setExampleIdx((i) => i - 1)}
            >
              ← Previous
            </button>
            <button
              className="btn btn-outline-primary"
              disabled={!chunk.length || exampleIdx >= chunk.length - 1 || status === "Processing..."}
              onClick={() => setExampleIdx((i) => i + 1)}
            >
              Next →
            </button>
            <div className="input-group ms-2" style={{ width: 160 }}>
              <span className="input-group-text">Jump</span>
              <input
                type="number"
                className="form-control"
                value={jumpValue}
                onChange={(e) => setJumpValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && goToExample()}
                disabled={!maxExamples || status === "Processing..."}
              />
              <button className="btn btn-success" onClick={goToExample} disabled={!maxExamples || status === "Processing..."}>
                Go
              </button>
            </div>
          </div>
          <div className="border rounded px-3 py-2 bg-white text-end">
            <div>
              Progress: <strong>Query {chunk.length ? `${exampleIdx + 1}/${chunk.length}` : ""}</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Controls above image */}
      {example && (
        <div className="container my-2">
          <div className="d-flex flex-wrap justify-content-between align-items-center border rounded p-2 bg-light">
            <div>
              <div><strong>Query:</strong> {example.query}</div>
              <div><strong>Query ID:</strong> {example.query_id}</div>
              <div><strong>Level:</strong> {CHUNK_LABELS[String(chunkId)] ?? chunkId}</div>
            </div>
            <div className="d-flex gap-2 align-items-center">
              <div><strong>Masks selected:</strong> {masks.length}</div>
              <button
                className="btn btn-info"
                onClick={() => setShowAllMasks((v) => !v)}
                disabled={!example || masks.length === 0}
              >
                {showAllMasks ? "Hide Masks" : "View Masks"}
              </button>
              <button
                className="btn btn-warning"
                onClick={() => setMasks([])}
                disabled={!example || masks.length === 0}
              >
                Clear All ✕
              </button>
              <button
                className="btn btn-success"
                onClick={async () => {
                  if (!currentExample || masks.length === 0) return;
                  setStatus("Processing...");
                  try {
                    for (const m of masks) {
                      await requestSave(m, currentExample.image_name, currentExample.query_id);
                    }
                    await logAction("done");
                    setMasks([]);
                    jumpToNextUnprocessed();
                  } finally {
                    setStatus("Ready");
                  }
                }}
                disabled={!example || masks.length === 0 || status !== "Ready"}
              >
                Finish ✓
              </button>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  if (!currentExample) return;
                  setStatus("Processing...");
                  try {
                    await logAction("skip");
                    setMasks([]);
                    jumpToNextUnprocessed();
                  } finally {
                    setStatus("Ready");
                  }
                }}
                disabled={!example || status !== "Ready"}
              >
                Skip ↷
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Body with image */}
      <div className="container flex-grow-1 mb-3">
        <div className="row g-3">
          <div className="col-lg-12 d-flex justify-content-center">
            {example && (
              <div
                style={{
                  position: "relative",
                  width: displaySize ? `${displaySize.w}px` : "auto",
                  height: displaySize ? `${displaySize.h}px` : "auto",
                }}
              >
                <img
                  key={imageKey}
                  ref={imgRef}
                  src={`/images/${example.image_name}`}
                  alt={example.image_name}
                  className="img-fluid border"
                  style={{
                    width: displaySize ? "100%" : undefined,
                    height: displaySize ? "100%" : undefined,
                    objectFit: "contain",
                    opacity: status === "Processing..." ? 0.6 : 1,
                    pointerEvents: status === "Processing..." ? "none" : "auto",
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

                {/* temp mask flash */}
                {tempMask && displaySize && (
                  <img
                    src={tempMask}
                    alt="mask"
                    className="position-absolute top-0 start-0 w-100 h-100"
                    style={{ objectFit: "contain", pointerEvents: "none" }}
                  />
                )}

                {/* hover preview */}
                {previewMask && displaySize && (
                  <img
                    src={previewMask}
                    alt="preview-mask"
                    className="position-absolute top-0 start-0 w-100 h-100"
                    style={{ objectFit: "contain", pointerEvents: "none", opacity: 0.7 }}
                  />
                )}

                {/* show all masks */}
                {showAllMasks &&
                  masks.map((m, i) => (
                    <img
                      key={`mask-${i}`}
                      src={m}
                      alt={`mask-${i}`}
                      className="position-absolute top-0 start-0 w-100 h-100"
                      style={{ objectFit: "contain", pointerEvents: "none", opacity: 0.5 }}
                    />
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status overlay */}
      {(status === "Loading image..." || status === "Processing..." || status === "Previewing...") && (
        <div
          className="position-fixed top-0 start-0 w-100 h-100 d-flex justify-content-center align-items-center bg-white bg-opacity-50"
          style={{ zIndex: 9999, fontSize: 22, fontWeight: 800, color: "#1f2937", cursor: "wait" }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
