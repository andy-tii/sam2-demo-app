import React, { useEffect, useRef, useState } from "react";

type DispPt = { x: number; y: number }; // display-space coords (for drawing dots)
type ImgPt = { x: number; y: number };  // image-space coords (for backend)

export default function App() {
  const imgRef = useRef<HTMLImageElement | null>(null);

  // session + data
  const [imageUrl, setImageUrl] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");

  // overlays
  const [masks, setMasks] = useState<string[]>([]);          // committed mask (latest composite)
  const [previewMask, setPreviewMask] = useState<string| null>(null); // hover preview mask

  // points
  const [dots, setDots] = useState<DispPt[]>([]);
  const [points, setPoints] = useState<ImgPt[]>([]);

  // status: single row
  const [status, setStatus] = useState<"" | "uploading" | "processing" | "preview">("");

  // hover preview timer
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // simple pan (right-click & drag)
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragInfo = useRef<{ dragging: boolean; startX: number; startY: number; panX: number; panY: number } | null>(null);

  // ---- Upload ----
  const onFileChange = async (file?: File) => {
    if (!file) return;

    setStatus("uploading");
    const localUrl = URL.createObjectURL(file);
    setImageUrl(localUrl);
    setMasks([]);
    setPreviewMask(null);
    setDots([]);
    setPoints([]);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("http://localhost:8000/upload", { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSessionId(data.session_id);
    } catch (err) {
      console.error("Upload failed:", err);
      alert("Upload failed. Check console for details.");
      setSessionId("");
    } finally {
      setStatus("");
    }
  };

  // ---- Coords helpers ----
  const getCoords = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return { imgX: 0, imgY: 0, dispX: 0, dispY: 0 };

    // rect reflects CSS transforms, so this works even when panned
    const rect = img.getBoundingClientRect();
    const dispX = e.clientX - rect.left;
    const dispY = e.clientY - rect.top;

    // if cursor is outside image bounds, bail out (no preview)
    if (dispX < 0 || dispY < 0 || dispX > rect.width || dispY > rect.height) {
      return { imgX: -1, imgY: -1, dispX, dispY };
    }

    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;

    return {
      imgX: Math.round(dispX * scaleX),
      imgY: Math.round(dispY * scaleY),
      dispX,
      dispY,
    };
  };

  const findNearbyIndex = (dispX: number, dispY: number, tol = 8) =>
    dots.findIndex((p) => Math.hypot(p.x - dispX, p.y - dispY) <= tol);

  // ---- Click (toggle point) ----
  const onImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || status === "uploading") return;

    // ignore right-click for panning
    if (e.button === 2) return;

    const { imgX, imgY, dispX, dispY } = getCoords(e);
    // ignore clicks outside the image
    if (imgX < 0 || imgY < 0) return;

    // toggle logic
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
    setPreviewMask(null); // clear any hover preview on commit

    if (newPoints.length === 0) {
      setMasks([]);
      return;
    }

    setStatus("processing");
    try {
      const res = await fetch("http://localhost:8000/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, points: newPoints }),
      });
      const data = await res.json();
      if (data.mask_png_b64) {
        setMasks([`data:image/png;base64,${data.mask_png_b64}`]);
      }
    } catch (err) {
      console.error("Click request failed:", err);
      setMasks([]);
    } finally {
      setStatus("");
    }
  };

  // ---- Hover preview (3s idle) ----
  const onMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || status === "uploading") return;

    const { imgX, imgY } = getCoords(e);

    // outside the image: cancel preview & timer
    if (imgX < 0 || imgY < 0) {
      setPreviewMask(null);
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      }
      return;
    }

    // inside image: reset timer, clear previous preview
    setPreviewMask(null);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      triggerPreview(imgX, imgY);
    }, 100);
  };

  const onMouseLeave = () => {
    // mouse left the image: cancel preview & timer
    setPreviewMask(null);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const triggerPreview = async (x: number, y: number) => {
    if (!sessionId) return;
    setStatus("preview");
    try {
      const res = await fetch("http://localhost:8000/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, points: [...points, { x, y }] }),
      });
      const data = await res.json();
      if (data.mask_png_b64) {
        setPreviewMask(`data:image/png;base64,${data.mask_png_b64}`);
      }
    } catch (err) {
      console.error("Preview request failed:", err);
    } finally {
      // only clear preview status if we are still previewing (avoid stepping on processing)
      setStatus((s) => (s === "preview" ? "" : s));
    }
  };

  // ---- Clear ----
  const clearPoints = () => {
    setDots([]);
    setPoints([]);
    setMasks([]);
    setPreviewMask(null);
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  // ---- Pan (right-click & drag) ----
  const onContextMenu = (e: React.MouseEvent) => {
    // prevent the browser menu so right-click can pan
    e.preventDefault();
  };

  const onMouseDownPan = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 2) return; // right mouse button
    dragInfo.current = { dragging: true, startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  };

  const onMouseMovePan = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragInfo.current?.dragging) return;
    const dx = e.clientX - dragInfo.current.startX;
    const dy = e.clientY - dragInfo.current.startY;
    setPan({ x: dragInfo.current.panX + dx, y: dragInfo.current.panY + dy });
  };

  const endPan = () => {
    if (dragInfo.current) dragInfo.current.dragging = false;
  };

  useEffect(() => {
    // cleanup timer on unmount
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  // ---- UI ----
  return (
    <div style={{ fontFamily: "sans-serif", textAlign: "center", padding: 20 }}>
      {/* Header */}
      <h1 style={{ marginBottom: 8 }}>SAM2</h1>

      {/* Single status row */}
      <div style={{ minHeight: 22, marginBottom: 10, color: status ? "#d97706" : "#6b7280", fontWeight: 600 }}>
        {status === "uploading" && "Uploading..."}
        {status === "processing" && "Processing mask..."}
        {status === "preview" && "Previewing..."}
        {!status && "Ready"}
      </div>

      {/* Controls row */}
      <div style={{ marginBottom: 12, display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
        <input
          type="file"
          accept="image/*"
          disabled={status === "uploading"}
          onChange={(e) => onFileChange(e.target.files?.[0])}
        />
        <button onClick={clearPoints} disabled={!imageUrl || status === "uploading"}>
          Clear points
        </button>
        <span style={{ fontSize: 12, color: "#6b7280" }}>(Right-click & drag to move image)</span>
      </div>

      {/* Centered body */}
      <div
        onContextMenu={onContextMenu}
        onMouseDown={onMouseDownPan}
        onMouseMove={onMouseMovePan}
        onMouseUp={endPan}
        onMouseLeave={endPan}
        style={{ display: "flex", justifyContent: "center", userSelect: "none" }}
      >
        {imageUrl && (
          <div
            style={{
              position: "relative",
              display: "inline-block",
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0)`,
              cursor: dragInfo.current?.dragging ? "grabbing" : "default",
            }}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt="uploaded"
              style={{ maxWidth: "100%", border: "1px solid #ccc" }}
              onClick={onImageClick}
              onMouseMove={onMouseMove}
              onMouseLeave={onMouseLeave}
            />

            {/* committed mask */}
            {masks.length > 0 &&
              masks.map((m, i) => (
                <img
                  key={`mask-${i}`}
                  src={m}
                  alt={`mask-${i}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "auto",
                    pointerEvents: "none",
                  }}
                />
              ))}

            {/* hover preview mask */}
            {previewMask && (
              <img
                src={previewMask}
                alt="preview-mask"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "auto",
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
    </div>
  );
}
