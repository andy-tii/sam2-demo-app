import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import metadata from "./data/metadata.json";
import "bootstrap/dist/css/bootstrap.min.css";

type DispPt = { x: number; y: number };
type ImgPt = { x: number; y: number };
type Example = {
  image_name: string;
  image_path: string;
  query: string;
  query_id: number;
  level?: string;
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

type Status = "Ready" | "Loading image..." | "Processing...";

const MAX_DISPLAY_W = 1200;
const MAX_DISPLAY_H = 1200;

export default function App() {
  const imgRef = useRef<HTMLImageElement | null>(null);

  // navigation
  const [chunkId, setChunkId] = useState<number>(0);
  const [exampleIdx, setExampleIdx] = useState<number>(0);

  // overlays & points
  const [mask, setMask] = useState<string | null>(null);
  const [dots, setDots] = useState<DispPt[]>([]);
  const [points, setPoints] = useState<ImgPt[]>([]);

  // sizing & loading
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [imageKey, setImageKey] = useState<number>(0);
  const [status, setStatus] = useState<Status>("Ready");

  // combined thumbnail
  const [combinedThumb, setCombinedThumb] = useState<string>("");

  // processed map
  const [processed, setProcessed] = useState<Record<number, "done" | "skip">>({});

  // jump
  const [jumpValue, setJumpValue] = useState<string>("");

  // --- derived values ---
  const chunk: Example[] = (metadata as any)[chunkId.toString()] || [];
  const currentExample = chunk[exampleIdx] ?? null;

  // --- helpers ---
  const fetchProcessed = async (cid: number) => {
    try {
      const res = await axios.get("/status", { params: { chunk_id: cid } });
      const obj = (res.data?.processed || {}) as Record<string, "done" | "skip">;
      const map: Record<number, "done" | "skip"> = {};
      for (const k of Object.keys(obj)) map[parseInt(k, 10)] = obj[k];
      setProcessed(map);

      if (map[exampleIdx]) {
        setTimeout(() => jumpToNextUnprocessed(true), 0);
      }
    } catch {
      setProcessed({});
    }
  };

  const nextUnprocessedIndex = (start: number): number | null => {
    for (let i = start; i < chunk.length; i++) {
      if (!(i in processed)) return i;
    }
    return null;
  };

  const jumpToNextUnprocessed = (preferAfterCurrent = true) => {
    if (!chunk.length) return;
    const start = preferAfterCurrent ? exampleIdx + 1 : 0;
    let idx = nextUnprocessedIndex(start);
    if (idx === null) idx = nextUnprocessedIndex(0);
    if (idx !== null) setExampleIdx(idx);
  };

  const goToExample = () => {
    if (!chunk.length) return;
    let n = parseInt(jumpValue, 10);
    if (Number.isNaN(n)) return;
    n = Math.max(1, Math.min(n, chunk.length));
    setExampleIdx(n - 1);
  };

  // effects
  useEffect(() => {
    fetchProcessed(chunkId);
    setExampleIdx(0); // reset index when switching chunk
  }, [chunkId]);

  useEffect(() => {
    // reset state when navigation changes
    setMask(null);
    setDots([]);
    setPoints([]);
    setNaturalSize(null);
    setDisplaySize(null);
    setScale(1);
    setStatus(currentExample ? "Loading image..." : "Ready");
    setImageKey((k) => k + 1);
    setCombinedThumb("");
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

  // --- API calls ---
  async function requestCommit(newPoints: ImgPt[]) {
    const res = await axios.post("/click", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      width: naturalSize?.w,
      height: naturalSize?.h,
      points: newPoints.map((p) => ({ ...p, label: 1 })),
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

  async function fetchCombinedThumb(imageName: string, queryId: number) {
    try {
      const res = await axios.get("/masks", { params: { image_name: imageName, query_id: queryId } });
      setCombinedThumb(res.data?.combined_thumb_png_b64 || "");
    } catch {
      setCombinedThumb("");
    }
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

  // --- clicks ---
  const onImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status === "Processing..." || !naturalSize || !displaySize) return;

    const { imgX, imgY, dispX, dispY } = getCoords(e);
    if (imgX < 0 || imgY < 0) return;

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
      if (data.mask_png_b64) setMask(`data:image/png;base64,${data.mask_png_b64}`);
      else setMask(null);
    } catch {
      setMask(null);
    } finally {
      setStatus("Ready");
    }
  };

  const clearPoints = () => {
    if (status === "Processing...") return;
    setDots([]);
    setPoints([]);
    setMask(null);
  };

  // --- keyboard shortcuts ---
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!currentExample) return;

      if ((e.key === "z" || e.key === " ") && status === "Ready") {
        e.preventDefault();
        if (mask) {
          setStatus("Processing...");
          try {
            await requestSave(mask, currentExample.image_name, currentExample.query_id);
            setMask(null);
            setDots([]);
            setPoints([]);
            fetchCombinedThumb(currentExample.image_name, currentExample.query_id);
          } finally {
            setStatus("Ready");
          }
        }
      } else if ((e.key === "x" || e.key === "Enter") && status === "Ready") {
        e.preventDefault();
        setStatus("Processing...");
        try {
          await logAction("done");
          jumpToNextUnprocessed(true);
        } finally {
          setStatus("Ready");
        }
      } else if (e.key === "c" && status === "Ready") {
        e.preventDefault();
        clearPoints();
      } else if (e.key === "v" && status === "Ready") {
        e.preventDefault();
        setStatus("Processing...");
        try {
          await logAction("skip");
          jumpToNextUnprocessed(true);
        } finally {
          setStatus("Ready");
        }
      } else if (e.key === "ArrowLeft" && exampleIdx > 0 && status === "Ready") {
        e.preventDefault();
        setExampleIdx((i) => i - 1);
      } else if (e.key === "ArrowRight" && exampleIdx < chunk.length - 1 && status === "Ready") {
        e.preventDefault();
        setExampleIdx((i) => i + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [status, mask, currentExample, exampleIdx, chunkId]);

  // --- render ---
  return (
    <div className="container-fluid min-vh-100 d-flex flex-column">
      <div className="row flex-grow-1 p-3">
        {/* LEFT: Image */}
        <div className="col-md-7 d-flex justify-content-center align-items-start">
          {currentExample && (
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
                src={`/images/${currentExample.image_name}`}
                alt={currentExample.image_name}
                className="img-fluid border"
                style={{
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
                  if (currentExample?.image_name && currentExample?.query_id != null) {
                    fetchCombinedThumb(currentExample.image_name, currentExample.query_id);
                  }
                }}
                onClick={onImageClick}
              />

              {mask && <img src={mask} alt="mask" className="position-absolute top-0 start-0 w-100 h-100" style={{ objectFit: "contain", pointerEvents: "none" }} />}

              {dots.map((p, i) => (
                <div key={i} className="position-absolute bg-danger border border-white rounded-circle" style={{ left: p.x - 4, top: p.y - 4, width: 8, height: 8, pointerEvents: "none" }} />
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: Query + Controls */}
        <div className="col-md-5">
          <div className="border-bottom py-2 d-flex justify-content-center bg-light">
            <div className="d-flex flex-wrap gap-2 align-items-center">
              <select
                className="form-select"
                style={{ minWidth: 180 }}
                value={chunkId}
                disabled={status === "Processing..."}
                onChange={(e) => {
                  if (status === "Processing...") return;
                  setChunkId(parseInt(e.target.value, 10));
                  setJumpValue("");
                }}
              >
                {Object.keys(metadata)
                  .map(Number)
                  .sort((a, b) => a - b)
                  .map((cid) => (
                    <option key={cid} value={cid}>
                      {CHUNK_LABELS[String(cid)] ?? `Chunk ${cid}`}
                    </option>
                  ))}
              </select>

              <button className="btn btn-outline-secondary" disabled={exampleIdx === 0 || status === "Processing..."} onClick={() => setExampleIdx((i) => i - 1)}>
                ⬅ Previous
              </button>

              <button className="btn btn-outline-secondary" disabled={!chunk.length || exampleIdx >= chunk.length - 1 || status === "Processing..."} onClick={() => setExampleIdx((i) => i + 1)}>
                Next ➡
              </button>

            </div>
          </div>

          {currentExample && (
            <>
              <div className="alert alert-info py-2 small">
                <strong>Shortcuts:</strong>{" "}
                [Z / Space] Save Mask &nbsp; | &nbsp; [X / Enter] Finish ✓ &nbsp; | &nbsp;
                [C] Clear Points &nbsp; | &nbsp; [V] Skip ↷ &nbsp; | &nbsp; [←] Previous &nbsp; | &nbsp; [→] Next
              </div>
              <div className="d-flex flex-wrap gap-2 mb-3">
                <button
                  className="btn btn-primary"
                  disabled={!mask || status !== "Ready"}
                  onClick={async () => {
                    if (!mask || !currentExample) return;
                    setStatus("Processing...");
                    try {
                      await requestSave(mask, currentExample.image_name, currentExample.query_id);
                      setMask(null);
                      setDots([]);
                      setPoints([]);
                      fetchCombinedThumb(currentExample.image_name, currentExample.query_id);
                    } finally {
                      setStatus("Ready");
                    }
                  }}
                >
                  Save Mask
                </button>

                <button
                  className="btn btn-success"
                  disabled={!currentExample || status !== "Ready"}
                  onClick={async () => {
                    setStatus("Processing...");
                    try {
                      await logAction("done");
                      jumpToNextUnprocessed(true);
                    } finally {
                      setStatus("Ready");
                    }
                  }}
                >
                  Finish ✓
                </button>

                <button
                  className="btn btn-secondary"
                  disabled={!currentExample || status !== "Ready"}
                  onClick={async () => {
                    setStatus("Processing...");
                    try {
                      await logAction("skip");
                      jumpToNextUnprocessed(true);
                    } finally {
                      setStatus("Ready");
                    }
                  }}
                >
                  Skip ↷
                </button>
                 <button className="btn btn-warning" onClick={clearPoints} disabled={!currentExample || status === "Processing..."}>
                Clear points
              </button>
              </div>
              <h5>
                Query {chunk.length ? `${exampleIdx + 1}/${chunk.length}` : ""}
              </h5>
              <h2>
                Object: <span className="text-danger">{currentExample.query}</span>
              </h2>
              <h5>
                Level: <span className="text-danger">{(currentExample as any).level}</span>
              </h5>

              {/* Combined masks */}
              <h6>Saved masks</h6>
              {combinedThumb ? (
                <div className="mb-3 text-center">
                  <small className="text-muted d-block mb-1">All masks (combined)</small>
                  <img
                    src={`data:image/png;base64,${combinedThumb}`}
                    alt="Combined masks"
                    className="border"
                    style={{ maxWidth: "600px", width: "100%" }}
                  />
                </div>
              ) : (
                <p className="text-muted">No masks yet.</p>
              )}
            </>
          )}
        </div>
      </div>

      {(status === "Loading image..." || status === "Processing...") && (
        <div className="position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center bg-white bg-opacity-75" style={{ zIndex: 2000 }}>
          <div className="fw-bold fs-4">{status}</div>
        </div>
      )}
    </div>
  );
}
