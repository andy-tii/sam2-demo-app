import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
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
const HOVER_DELAY_MS = 100;
const CLICK_MASK_DISPLAY_MS = 200;

// Create axios instance with timeout
const api = axios.create({
  timeout: 10000,
});

export default function App() {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortController = useRef<AbortController | null>(null);

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

  // Memoize computed values
  const chunk = useMemo(() => {
    return (metadata as any)[chunkId.toString()] || [];
  }, [chunkId]);

  const maxExamples = chunk.length;

  const sortedChunkIds = useMemo(() => {
    return Object.keys(metadata)
      .map(Number)
      .sort((a, b) => a - b);
  }, []);

  // Optimize coordinate calculation
  const getCoords = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
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
  }, [naturalSize, displaySize, scale]);

  // Optimize display size calculation
  const computeDisplayFromNatural = useCallback((nw: number, nh: number) => {
    const s = Math.min(1, MAX_DISPLAY_W / nw, MAX_DISPLAY_H / nh);
    return { w: Math.round(nw * s), h: Math.round(nh * s), s };
  }, []);

  // Optimized API helpers with abort controller
  const requestCommit = useCallback(async (pt: ImgPt) => {
    if (abortController.current) {
      abortController.current.abort();
    }
    abortController.current = new AbortController();

    const res = await api.post("/click", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      width: naturalSize?.w,
      height: naturalSize?.h,
      points: [{ ...pt, label: 1 }],
    }, { signal: abortController.current.signal });
    
    return res.data;
  }, [chunkId, exampleIdx, currentExample, naturalSize]);

  const requestPreview = useCallback(async (pt: ImgPt) => {
    if (abortController.current) {
      abortController.current.abort();
    }
    abortController.current = new AbortController();

    const res = await api.post("/preview", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      width: naturalSize?.w,
      height: naturalSize?.h,
      points: [{ ...pt, label: 1 }],
    }, { signal: abortController.current.signal });
    
    return res.data;
  }, [chunkId, exampleIdx, currentExample, naturalSize]);

  const requestSave = useCallback(async (mask: string, imageName: string, queryId: number) => {
    const b64 = mask.replace(/^data:image\/png;base64,/, "");
    const res = await api.post("/save", {
      image_name: imageName,
      query_id: queryId,
      mask_png_b64: b64,
    });
    return res.data;
  }, []);

  const logAction = useCallback(async (action: "done" | "skip") => {
    await api.post("/log", {
      chunk_id: chunkId,
      index: exampleIdx,
      image_name: currentExample?.image_name,
      query_id: currentExample?.query_id,
      action,
    });
    setProcessed((prev) => ({ ...prev, [exampleIdx]: action }));
  }, [chunkId, exampleIdx, currentExample]);

  const fetchProcessed = useCallback(async (cid: number) => {
    try {
      const res = await api.get("/status", { params: { chunk_id: cid } });
      const obj = (res.data?.processed || {}) as Record<string, "done" | "skip">;
      const map: Record<number, "done" | "skip"> = {};
      for (const k of Object.keys(obj)) {
        map[parseInt(k, 10)] = obj[k];
      }
      setProcessed(map);
    } catch (error) {
      if (!axios.isCancel(error)) {
        setProcessed({});
      }
    }
  }, []);

  const jumpToNextUnprocessed = useCallback(() => {
    if (!chunk.length) return;
    
    // Check examples after current index first
    for (let i = exampleIdx + 1; i < chunk.length; i++) {
      if (!(i in processed)) {
        setExampleIdx(i);
        return;
      }
    }
    
    // Then check from beginning
    for (let i = 0; i < chunk.length; i++) {
      if (!(i in processed)) {
        setExampleIdx(i);
        return;
      }
    }
  }, [chunk.length, exampleIdx, processed]);

  const goToExample = useCallback(() => {
    if (!chunk.length) return;
    
    const n = parseInt(jumpValue, 10);
    if (Number.isNaN(n)) return;
    
    const clampedN = Math.max(1, Math.min(n, chunk.length));
    setExampleIdx(clampedN - 1);
  }, [jumpValue, chunk.length]);

  // Debounced mouse move handler
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
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

    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
    }

    hoverTimer.current = setTimeout(async () => {
      setStatus("Previewing...");
      try {
        const data = await requestPreview({ x: imgX, y: imgY });
        if (data.mask_png_b64) {
          setPreviewMask(`data:image/png;base64,${data.mask_png_b64}`);
        }
      } catch (error) {
        if (!axios.isCancel(error)) {
          console.error("Preview request failed:", error);
        }
      } finally {
        setStatus(prev => prev !== "Processing..." ? "Ready" : prev);
      }
    }, HOVER_DELAY_MS);
  }, [currentExample, status, naturalSize, displaySize, getCoords, requestPreview]);

  const onMouseLeave = useCallback(() => {
    setPreviewMask(null);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (status === "Previewing...") {
      setStatus("Ready");
    }
  }, [status]);

  const onImageClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
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
    } catch (error) {
      if (!axios.isCancel(error)) {
        console.error("Click request failed:", error);
      }
    } finally {
      setStatus("Ready");
    }
  }, [currentExample, status, naturalSize, displaySize, getCoords, requestCommit]);

  // Optimized handlers
  const handleChunkChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    if (status === "Processing...") return;
    setChunkId(parseInt(e.target.value, 10));
    setExampleIdx(0);
    setJumpValue("");
  }, [status]);

  const handlePrevious = useCallback(() => {
    if (exampleIdx > 0 && status !== "Processing...") {
      setExampleIdx(i => i - 1);
    }
  }, [exampleIdx, status]);

  const handleNext = useCallback(() => {
    if (exampleIdx < chunk.length - 1 && status !== "Processing...") {
      setExampleIdx(i => i + 1);
    }
  }, [exampleIdx, chunk.length, status]);

  const handleFinish = useCallback(async () => {
    if (!currentExample || masks.length === 0) return;
    
    setStatus("Processing...");
    try {
      // Process saves in parallel for better performance
      await Promise.all(
        masks.map(mask => requestSave(mask, currentExample.image_name, currentExample.query_id))
      );
      await logAction("done");
      setMasks([]);
      jumpToNextUnprocessed();
    } catch (error) {
      console.error("Finish operation failed:", error);
    } finally {
      setStatus("Ready");
    }
  }, [currentExample, masks, requestSave, logAction, jumpToNextUnprocessed]);

  const handleSkip = useCallback(async () => {
    if (!currentExample) return;
    
    setStatus("Processing...");
    try {
      await logAction("skip");
      setMasks([]);
      jumpToNextUnprocessed();
    } catch (error) {
      console.error("Skip operation failed:", error);
    } finally {
      setStatus("Ready");
    }
  }, [currentExample, logAction, jumpToNextUnprocessed]);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const target = e.currentTarget;
    const nw = target.naturalWidth;
    const nh = target.naturalHeight;
    setNaturalSize({ w: nw, h: nh });
    
    const { w, h, s } = computeDisplayFromNatural(nw, nh);
    setDisplaySize({ w, h });
    setScale(s);
    setStatus("Ready");
  }, [computeDisplayFromNatural]);

  // Effects
  useEffect(() => {
    fetchProcessed(chunkId);
  }, [chunkId, fetchProcessed]);

  useEffect(() => {
    let idx = exampleIdx;
    if (idx >= chunk.length) {
      idx = 0;
      setExampleIdx(0);
    }
    
    const ex = chunk[idx] || null;
    setCurrentExample(ex);

    // Reset state
    setMasks([]);
    setTempMask(null);
    setPreviewMask(null);
    setShowAllMasks(false);
    setNaturalSize(null);
    setDisplaySize(null);
    setScale(1);
    setStatus("Loading image...");
    setImageKey((k) => k + 1);

    // Clear any pending timers
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }

    // Abort any pending requests
    if (abortController.current) {
      abortController.current.abort();
    }
  }, [chunkId, exampleIdx, chunk]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in input fields
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        return;
      }

      // Ignore if processing
      if (status === "Processing...") {
        return;
      }

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'enter':
          e.preventDefault();
          if (currentExample && masks.length > 0 && status === "Ready") {
            handleFinish();
          }
          break;
        
        case 's':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (currentExample && status === "Ready") {
              handleSkip();
            }
          }
          break;
        
        case 'c':
          e.preventDefault();
          if (currentExample && masks.length > 0) {
            setMasks([]);
          }
          break;
        
        case 'v':
          e.preventDefault();
          if (currentExample && masks.length > 0) {
            setShowAllMasks(v => !v);
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentExample, masks.length, status, handleFinish, handleSkip]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
      }
      if (abortController.current) {
        abortController.current.abort();
      }
    };
  }, []);

  const isProcessing = status === "Processing...";
  const canNavigate = !isProcessing && chunk.length > 0;

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
                onChange={handleChunkChange}
                disabled={isProcessing}
              >
                {sortedChunkIds.map((cid) => {
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
              disabled={exampleIdx === 0 || !canNavigate}
              onClick={handlePrevious}
            >
              ← Previous
            </button>
            
            <button
              className="btn btn-outline-primary"
              disabled={exampleIdx >= chunk.length - 1 || !canNavigate}
              onClick={handleNext}
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
                disabled={!canNavigate}
                min={1}
                max={maxExamples}
              />
              <button
                className="btn btn-success"
                onClick={goToExample}
                disabled={!canNavigate}
              >
                Go
              </button>
            </div>
          </div>
          
          <div className="border rounded px-3 py-2 bg-white text-end">
            <div>
              Progress: <strong>Query {maxExamples ? `${exampleIdx + 1}/${maxExamples}` : ""}</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Controls above image */}
      {currentExample && (
        <div className="container my-2">
          <div className="d-flex flex-wrap justify-content-between align-items-center border rounded p-2 bg-light">
            <div>
              <div><strong>Query:</strong> {currentExample.query}</div>
              <div><strong>Query ID:</strong> {currentExample.query_id}</div>
              <div><strong>Level:</strong> {CHUNK_LABELS[String(chunkId)] ?? chunkId}</div>
            </div>
            
            <div className="d-flex gap-2 align-items-center">
              <div><strong>Masks selected:</strong> {masks.length}</div>
              
              <button
                className="btn btn-info"
                onClick={() => setShowAllMasks(v => !v)}
                disabled={!currentExample || masks.length === 0}
                title="Toggle mask view (V)"
              >
                {showAllMasks ? "Hide Masks" : "View Masks"}
              </button>
              
              <button
                className="btn btn-warning"
                onClick={() => setMasks([])}
                disabled={!currentExample || masks.length === 0}
                title="Clear all masks (C)"
              >
                Clear All ✕
              </button>
              
              <button
                className="btn btn-success"
                onClick={handleFinish}
                disabled={!currentExample || masks.length === 0 || status !== "Ready"}
                title="Finish and save (Space/Enter)"
              >
                Finish ✓
              </button>
              
              <button
                className="btn btn-secondary"
                onClick={handleSkip}
                disabled={!currentExample || status !== "Ready"}
                title="Skip this item (Ctrl+S)"
              >
                Skip ↷
              </button>
            </div>
          </div>
          
          {/* Keyboard shortcuts help */}
          <div className="mt-2 text-muted small">
            <strong>Keyboard shortcuts:</strong> Space/Enter: Finish | Ctrl+S: Skip | C: Clear masks | V: Toggle mask view
          </div>
        </div>
      )}

      {/* Body with image */}
      <div className="container flex-grow-1 mb-3">
        <div className="row g-3">
          <div className="col-lg-12 d-flex justify-content-center">
            {currentExample && (
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
                  src={`/images/${currentExample.image_name}`}
                  alt={currentExample.image_name}
                  className="img-fluid border"
                  style={{
                    width: displaySize ? "100%" : undefined,
                    height: displaySize ? "100%" : undefined,
                    objectFit: "contain",
                    opacity: isProcessing ? 0.6 : 1,
                    pointerEvents: isProcessing ? "none" : "auto",
                    transition: "opacity 0.2s ease",
                  }}
                  onLoad={handleImageLoad}
                  onClick={onImageClick}
                  onMouseMove={onMouseMove}
                  onMouseLeave={onMouseLeave}
                  loading="eager"
                />

                {/* Temp mask flash */}
                {tempMask && displaySize && (
                  <img
                    src={tempMask}
                    alt="mask"
                    className="position-absolute top-0 start-0 w-100 h-100"
                    style={{ 
                      objectFit: "contain", 
                      pointerEvents: "none",
                      transition: "opacity 0.2s ease"
                    }}
                  />
                )}

                {/* Hover preview */}
                {previewMask && displaySize && (
                  <img
                    src={previewMask}
                    alt="preview-mask"
                    className="position-absolute top-0 start-0 w-100 h-100"
                    style={{ 
                      objectFit: "contain", 
                      pointerEvents: "none", 
                      opacity: 0.7,
                      transition: "opacity 0.15s ease"
                    }}
                  />
                )}

                {/* Show all masks */}
                {showAllMasks &&
                  masks.map((mask, i) => (
                    <img
                      key={`mask-${i}`}
                      src={mask}
                      alt={`mask-${i}`}
                      className="position-absolute top-0 start-0 w-100 h-100"
                      style={{ 
                        objectFit: "contain", 
                        pointerEvents: "none", 
                        opacity: 0.5,
                        transition: "opacity 0.2s ease"
                      }}
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
          className="position-fixed top-0 start-0 w-100 h-100 d-flex justify-content-center align-items-center"
          style={{ 
            zIndex: 9999, 
            fontSize: 22, 
            fontWeight: 800, 
            color: "#1f2937", 
            cursor: "wait",
            backgroundColor: "rgba(255, 255, 255, 0.8)",
            backdropFilter: "blur(2px)"
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}