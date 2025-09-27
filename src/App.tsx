import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import metadata from "./data/metadata.json";

type DispPt = { x: number; y: number };
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

type SavedThumb = { name: string; thumb_png_b64: string };
type Status = "Ready" | "Loading image..." | "Processing..." | "Previewing...";

const MAX_DISPLAY_W = 1200;
const MAX_DISPLAY_H = 700;

export default function App() {
  const imgRef = useRef<HTMLImageElement | null>(null);

  // navigation
  const [chunkId, setChunkId] = useState<number>(0);
  const [exampleIdx, setExampleIdx] = useState<number>(0);
  const [currentExample, setCurrentExample] = useState<Example | null>(null);

  // overlays & points
  const [mask, setMask] = useState<string | null>(null);               // committed mask
  const [previewMask, setPreviewMask] = useState<string | null>(null); // hover preview
  const [dots, setDots] = useState<DispPt[]>([]);
  const [points, setPoints] = useState<ImgPt[]>([]);                   // NATURAL coords

  // sizing & loading
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState<number>(1);
  const [imageKey, setImageKey] = useState<number>(0);
  const [status, setStatus] = useState<Status>("Ready");

  // saved thumbs
  const [savedThumbs, setSavedThumbs] = useState<SavedThumb[]>([]);
  const [combinedThumb, setCombinedThumb] = useState<string>("");

  // processed map: { idx: "done" | "skip" }
  const [processed, setProcessed] = useState<Record<number, "done" | "skip">>({});

  // hover timer
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // NEW: jump + tooltip state
  const [jumpValue, setJumpValue] = useState<string>("");
  const [showHelp, setShowHelp] = useState<boolean>(false);

  // --- helpers for processed navigation ---
  const fetchProcessed = async (cid: number) => {
  try {
    const res = await axios.get("/status", { params: { chunk_id: cid } });
    const obj = (res.data?.processed || {}) as Record<string, "done" | "skip">;
    const map: Record<number, "done" | "skip"> = {};
    for (const k of Object.keys(obj)) map[parseInt(k, 10)] = obj[k];
    setProcessed(map);

    // optional: auto-jump once after loading status for this chunk
    if (map[exampleIdx]) {
      setTimeout(() => jumpToNextUnprocessed(true), 0);
    }
  } catch {
    setProcessed({});
  }
};

  const nextUnprocessedIndex = (start: number): number | null => {
    const list: Example[] = (metadata as any)[chunkId.toString()] || [];
    for (let i = start; i < list.length; i++) {
      if (!(i in processed)) return i;
    }
    return null;
  };

  const jumpToNextUnprocessed = (preferAfterCurrent = true) => {
    const list: Example[] = (metadata as any)[chunkId.toString()] || [];
    if (!list.length) return;
    const start = preferAfterCurrent ? exampleIdx + 1 : 0;
    let idx = nextUnprocessedIndex(start);
    if (idx === null) idx = nextUnprocessedIndex(0); // wrap-around
    if (idx !== null) setExampleIdx(idx);
  };

  // NEW: go to example helper
  const goToExample = () => {
    const list: Example[] = (metadata as any)[chunkId.toString()] || [];
    if (!list.length) return;
    let n = parseInt(jumpValue, 10);
    if (Number.isNaN(n)) return;
    n = Math.max(1, Math.min(n, list.length));
    setExampleIdx(n - 1); // convert to 0-based
  };

  // load examples when navigation changes
  useEffect(() => {
    fetchProcessed(chunkId); // refresh status on chunk change
  }, [chunkId]);

  // when exampleIdx or processed changes, skip processed automatically
  useEffect(() => {
  const list: Example[] = (metadata as any)[chunkId.toString()] || [];
  const ex = list[exampleIdx] || null;
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

  setSavedThumbs([]);
  setCombinedThumb("");
}, [exampleIdx]); // processed in deps ensures auto-skip on first load

  // -------- sizing helpers --------
  const computeDisplayFromNatural = (nw: number, nh: number) => {
    const s = Math.min(1, MAX_DISPLAY_W / nw, MAX_DISPLAY_H / nh);
    return { w: Math.round(nw * s), h: Math.round(nh * s), s };
  };

  // ------------- coords helpers -------------
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

  // ---------- API helpers ----------
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

  async function requestPreview(allPointsPlusHover: ImgPt[]) {
    try {
      const r = await axios.post("/preview", {
        chunk_id: chunkId,
        index: exampleIdx,
        image_name: currentExample?.image_name,
        query_id: currentExample?.query_id,
        width: naturalSize?.w,
        height: naturalSize?.h,
        points: allPointsPlusHover.map((p) => ({ ...p, label: 1 })),
      });
      return r.data;
    } catch {
      const r = await axios.post("/click?preview=1", {
        chunk_id: chunkId,
        index: exampleIdx,
        image_name: currentExample?.image_name,
        query_id: currentExample?.query_id,
        width: naturalSize?.w,
        height: naturalSize?.h,
        points: allPointsPlusHover.map((p) => ({ ...p, label: 1 })),
      });
      return r.data;
    }
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

  async function fetchSavedThumbs(imageName: string, queryId: number) {
    try {
      const res = await axios.get("/masks", { params: { image_name: imageName, query_id: queryId } });
      setSavedThumbs(res.data?.masks || []);
      setCombinedThumb(res.data?.combined_thumb_png_b64 || "");
    } catch (e) {
      console.error("Fetch masks failed:", e);
      setSavedThumbs([]);
      setCombinedThumb("");
    }
  }

  async function deleteMask(imageName: string, queryId: number, maskName: string) {
    try {
      await axios.delete("/delete", { data: { image_name: imageName, query_id: queryId, mask_name: maskName } });
      setSavedThumbs((prev) => prev.filter((m) => m.name !== maskName));
      fetchSavedThumbs(imageName, queryId); // refresh combined too
    } catch (e) {
      console.error("Delete mask failed:", e);
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

  // ------------- click (toggle) -------------
  const onImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status === "Processing..." || !naturalSize || !displaySize) return;

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
      if (data.mask_png_b64) setMask(`data:image/png;base64,${data.mask_png_b64}`);
      else setMask(null);
    } catch (err) {
      console.error("Commit request failed:", err);
      setMask(null);
    } finally {
      setStatus("Ready");
    }
  };

  // ------------- hover (idle preview) -------------
  const onMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentExample || status === "Processing..." || !naturalSize || !displaySize) return;

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
        if (data.mask_png_b64) setPreviewMask(`data:image/png;base64,${data.mask_png_b64}`);
      } catch (err) {
        console.error("Preview request failed:", err);
      } finally {
        if (status !== "Processing...") setStatus("Ready");
      }
    }, 300);
  };

  const onMouseLeave = () => {
    setPreviewMask(null);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (status === "Previewing...") setStatus("Ready");
  };

  const clearPoints = () => {
    if (status === "Processing...") return;
    setDots([]);
    setPoints([]);
    setMask(null);
    setPreviewMask(null);
  };

  // ---------- UI ----------
  const chunk: Example[] = (metadata as any)[chunkId.toString()] || [];
  const example = currentExample;
  const maxExamples = chunk.length;

  return (
    <div style={{ fontFamily: "sans-serif", minHeight: "100vh", display: "grid", gridTemplateRows: "auto 1fr auto" }}>
      {/* Top bar (centered controls) */}
      <div
        style={{
          paddingTop: 15,
          padding: 12,
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <label>
            Chunk:&nbsp;
            <select
              value={chunkId}
              onChange={(e) => {
                if (status === "Processing...") return;
                setChunkId(parseInt(e.target.value, 10));
                setExampleIdx(0);
                setJumpValue("");
              }}
              disabled={status === "Processing..."}
              style={{ minWidth: 180 }}   // widen the dropdown if you like
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
          </label>

          <button
            disabled={exampleIdx === 0 || status === "Processing..."}
            onClick={() => setExampleIdx((i) => i - 1)}
          >
            ⬅ Previous
          </button>

          <button
            disabled={!chunk.length || exampleIdx >= chunk.length - 1 || status === "Processing..."}
            onClick={() => setExampleIdx((i) => i + 1)}
          >
            Next ➡
          </button>

          <button onClick={clearPoints} disabled={!example || status === "Processing..."}>
            Clear points
          </button>

          {/* NEW: Go to example # */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
            <input
              type="number"
              min={1}
              max={Math.max(1, maxExamples || 1)}
              value={jumpValue}
              onChange={(e) => setJumpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") goToExample();
              }}
              placeholder="Example #"
              style={{ width: 96, padding: "4px 6px" }}
              disabled={!maxExamples || status === "Processing..."}
              aria-label="Go to example number"
            />
            <button
              onClick={goToExample}
              disabled={!maxExamples || status === "Processing..."}
              style={{ padding: "4px 10px" }}
              title="Jump to the given example number"
            >
              Go
            </button>

            {/* NEW: Hover help "?" */}
            <div
              style={{ position: "relative", display: "inline-block" }}
              onMouseEnter={() => setShowHelp(true)}
              onMouseLeave={() => setShowHelp(false)}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: "1px solid #9ca3af",
                  color: "#374151",
                  fontWeight: 700,
                  cursor: "help",
                  userSelect: "none",
                }}
                aria-label="Help"
              >
                ?
              </span>

              {showHelp && (
                <div
                  role="tooltip"
                  style={{
                    position: "absolute",
                    top: "130%",
                    right: 0,
                    width: "min(90vw, 520px)",
                    maxWidth: 520,
                    background: "#111827",
                    color: "white",
                    padding: "12px 14px",
                    fontSize: 13,
                    borderRadius: 8,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
                    zIndex: 1000,
                    lineHeight: 1.5,
                    textAlign: "left",
                  }}
                >
                  <p style={{ margin: "0 0 8px 0" }}>
                    Move the mouse to preview the masks.
                  </p>
                  <p style={{ margin: "0 0 8px 0" }}>
                    Click the points again to remove the selected points.
                  </p>
                  <p style={{ margin: "0 0 8px 0" }}>
                    You need to click <strong>Save Mask</strong> to save masks.
                  </p>
                  <p style={{ margin: 0 }}>
                    One query may have multiple masks. When you click <strong>Save Mask</strong>, it will appear on the right. The top thumbnail combines all saved masks.
                  </p>
                  <p style={{ margin: 0 }}>
                    Double-click on sub-masks to delete the masks
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Body: 2/3 image | 1/3 query */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr",
          gap: 16,
          padding: 16,
          alignItems: "start",
        }}
      >
        {/* Image column */}
        <div style={{ display: "flex", justifyContent: "center" }}>
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
                src={`/images/${example.image_name}`}
                alt={example.image_name}
                style={{
                  textAlign: "center" ,
                  width: displaySize ? "100%" : undefined,
                  height: displaySize ? "100%" : undefined,
                  objectFit: "contain",
                  border: "1px solid #ccc",
                  borderRadius: 0,
                  display: "block",
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

                  if (example?.image_name != null && example?.query_id != null) {
                    fetchSavedThumbs(example.image_name, example.query_id);
                  }
                }}
                onClick={onImageClick}
                onMouseMove={onMouseMove}
                onMouseLeave={onMouseLeave}
              />

              {/* committed mask */}
              {mask && displaySize && (
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

              {/* hover preview mask */}
              {previewMask && displaySize && (
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

              {/* red dots */}
              {dots.map((p, i) => (
                <div
                  key={`dot-${i}`}
                  style={{
                    position: "absolute",
                    left: p.x - 4,
                    top: p.y - 4,
                    width: 8,
                    height: 8,
                    borderRadius: "100%",
                    background: "red",
                    border: "1px solid white",
                    pointerEvents: "none",
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Query column */}
        <div style={{ textAlign: "center" }}>
          {example?.query && (
            <div style={{ display: "inline-block", textAlign: "left", width: "100%" }}>
              <strong>Query {chunk.length ? `${exampleIdx + 1}/${chunk.length}` : ""}</strong>
              <div style={{ marginTop: 6, marginBottom: 12 }}>{example.query}</div>

              {/* Actions row */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  onClick={async () => {
                    if (!mask || !currentExample) return;
                    setStatus("Processing...");
                    try {
                      await requestSave(mask, currentExample.image_name, currentExample.query_id);
                      setMask(null);
                      setPreviewMask(null);
                      setDots([]);
                      setPoints([]);
                      fetchSavedThumbs(currentExample.image_name, currentExample.query_id);
                    } catch (err) {
                      console.error("Save failed:", err);
                    } finally {
                      setStatus("Ready");
                    }
                  }}
                  disabled={!mask || status !== "Ready"}
                  style={{
                    padding: "6px 12px",
                    backgroundColor: "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                    cursor: mask && status === "Ready" ? "pointer" : "not-allowed",
                  }}
                >
                  Save Mask
                </button>

                {/* Finish (mark done and go next) */}
                <button
                  onClick={async () => {
                    if (!currentExample) return;
                    setStatus("Processing...");
                    try {
                      await logAction("done");
                      jumpToNextUnprocessed(true);
                    } catch (e) {
                      console.error("Finish log failed:", e);
                    } finally {
                      setStatus("Ready");
                    }
                  }}
                  disabled={!example || status !== "Ready"}
                  style={{
                    padding: "6px 12px",
                    backgroundColor: "#059669",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                    cursor: example && status === "Ready" ? "pointer" : "not-allowed",
                  }}
                  title="Mark this query as done and move to the next unprocessed one"
                >
                  Finish ✓
                </button>

                {/* Skip (mark skip and go next) */}
                <button
                  onClick={async () => {
                    if (!currentExample) return;
                    setStatus("Processing...");
                    try {
                      await logAction("skip");
                      jumpToNextUnprocessed(true);
                    } catch (e) {
                      console.error("Skip log failed:", e);
                    } finally {
                      setStatus("Ready");
                    }
                  }}
                  disabled={!example || status !== "Ready"}
                  style={{
                    padding: "6px 12px",
                    backgroundColor: "#6b7280",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                    cursor: example && status === "Ready" ? "pointer" : "not-allowed",
                  }}
                  title="Skip this query and move to the next unprocessed one"
                >
                  Skip ↷
                </button>
              </div>

              {/* Saved masks display */}
              <div style={{ marginTop: 16 }}>
                <strong>Saved masks</strong>

                {/* TOP-CENTER combined thumbnail */}
                {combinedThumb && (
                  <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>
                        All masks (combined)
                      </div>
                      <img
                        src={`data:image/png;base64,${combinedThumb}`}
                        alt="Combined masks"
                        style={{
                          maxWidth: 480,
                          width: "100%",
                          height: "auto",
                          border: "1px solid #ddd",
                          display: "block",
                          margin: "0 auto",
                          background: "#fff",
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Grid of individual thumbnails */}
                {savedThumbs.length === 0 ? (
                  <div style={{ marginTop: 12, color: "#6b7280" }}>No masks yet.</div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 8,
                      marginTop: 12,
                      width: "50%",
                    }}
                  >
                    {savedThumbs.map((m) => (
                      <div
                        key={m.name}
                        title="Double click to delete"
                        onDoubleClick={() =>
                          currentExample &&
                          deleteMask(currentExample.image_name, currentExample.query_id, m.name)
                        }
                        style={{
                          border: "1px solid #ddd",
                          padding: 4,
                          cursor: "pointer",
                          background: "#fafafa",
                        }}
                      >
                        <img
                          src={`data:image/png;base64,${m.thumb_png_b64}`}
                          alt={m.name}
                          style={{ width: "100%", height: "auto", display: "block" }}
                        />
                        <div
                          style={{
                            fontSize: 12,
                            textAlign: "center",
                            marginTop: 4,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.name}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {(status === "Loading image..." || status === "Processing...") && (
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
