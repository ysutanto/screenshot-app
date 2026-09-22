"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Rect,
  Ellipse,
  Text as KonvaText,
  Transformer,
} from "react-konva";
import type Konva from "konva";
import { nanoid } from "nanoid";
import type { ShapeData, TextShape, Tool } from "@/lib/shapes";
import Toolbar from "@/components/Toolbar";
import ShareBar from "@/components/ShareBar";

const TOOLBAR_HEIGHT = 48;
const SHAREBAR_HEIGHT = 40;
const DEFAULT_FONT_SIZE = 48;

export default function AnnotationCanvas({
  imageUrl,
  shareUrl,
  sourceUrl,
}: {
  imageUrl: string;
  shareUrl: string;
  sourceUrl?: string | null;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageStatus, setImageStatus] = useState<"loading" | "loaded" | "error">(
    "loading"
  );
  const [loadedImageUrl, setLoadedImageUrl] = useState(imageUrl);
  const [stageScale, setStageScale] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#ff3b30");
  const [fontSize, setFontSize] = useState(48);
  const [shapes, setShapes] = useState<ShapeData[]>([]);
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "saving" | "error" | null
  >(null);
  const isFirstLoad = useRef(true);
  // Set when annotations could not be loaded. Auto-save stays disabled while it
  // is true, so an empty canvas from a failed load never overwrites good data.
  const loadFailed = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editorBox, setEditorBox] = useState<{ left: number; top: number } | null>(
    null
  );

  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shapeRefs = useRef<Map<string, Konva.Node>>(new Map());
  const drawingRef = useRef<{ id: string; startX: number; startY: number } | null>(
    null
  );

  // Load annotations from server on mount
  useEffect(() => {
    const id = shareUrl.split("/").pop();
    fetch(`/api/annotations/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`annotations load failed: ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) setShapes(data);
      })
      .catch(() => {
        loadFailed.current = true;
        setSaveStatus("error");
      })
      .finally(() => {
        // Use setTimeout so the flag flips after React has processed setShapes,
        // preventing the loaded shapes from immediately triggering a re-save.
        setTimeout(() => { isFirstLoad.current = false; }, 0);
      });
  }, [shareUrl]);

  // Auto-save to server (debounced) whenever shapes change
  useEffect(() => {
    if (isFirstLoad.current || loadFailed.current) return;
    setSaveStatus("saving");
    const id = shareUrl.split("/").pop();
    const timer = setTimeout(() => {
      fetch(`/api/annotations/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shapes),
      })
        .then((r) => setSaveStatus(r.ok ? "saved" : "error"))
        .catch(() => setSaveStatus("error"));
    }, 800);
    return () => clearTimeout(timer);
  }, [shapes, shareUrl]);

  if (imageUrl !== loadedImageUrl) {
    setLoadedImageUrl(imageUrl);
    setImage(null);
    setImageStatus("loading");
  }

  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      setImage(img);
      setImageStatus("loaded");
    };
    img.onerror = () => setImageStatus("error");
    img.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    if (!image) return;
    function recalc() {
      if (!image) return;
      const maxWidth = window.innerWidth;
      const maxHeight = window.innerHeight - TOOLBAR_HEIGHT - SHAREBAR_HEIGHT;
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
      setStageScale(scale > 0 ? scale : 1);
    }
    recalc();
    window.addEventListener("resize", recalc);
    return () => window.removeEventListener("resize", recalc);
  }, [image]);

  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    if (!selectedId) {
      tr.nodes([]);
      tr.getLayer()?.batchDraw();
      return;
    }
    const node = shapeRefs.current.get(selectedId);
    if (node) {
      tr.nodes([node]);
      tr.getLayer()?.batchDraw();
    }
  }, [selectedId, shapes]);

  useEffect(() => {
    if (!editingTextId) return;
    const stage = stageRef.current;
    if (!stage) return;
    const box = stage.container().getBoundingClientRect();
    setEditorBox({ left: box.left, top: box.top });
    // Delay focus so the Konva mousedown's focus side-effect settles first
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [editingTextId]);

  // Delete selected shape with Delete or Backspace
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (editingTextId) return; // don't delete while typing
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!selectedId) return;
      setShapes((prev) => prev.filter((s) => s.id !== selectedId));
      setSelectedId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, editingTextId]);

  function handlePointerDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) {
    if (editingTextId) return; // let blur commit the text first
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;

    if (tool === "select") {
      if (e.target === stage) setSelectedId(null);
      return;
    }

    const id = nanoid();

    if (tool === "rect") {
      setShapes((prev) => [
        ...prev,
        { id, type: "rect", x: pos.x, y: pos.y, width: 0, height: 0, stroke: color },
      ]);
      drawingRef.current = { id, startX: pos.x, startY: pos.y };
      return;
    }

    if (tool === "circle") {
      setShapes((prev) => [
        ...prev,
        { id, type: "circle", x: pos.x, y: pos.y, radiusX: 0, radiusY: 0, stroke: color },
      ]);
      drawingRef.current = { id, startX: pos.x, startY: pos.y };
      return;
    }

    if (tool === "text") {
      setShapes((prev) => [
        ...prev,
        { id, type: "text", x: pos.x, y: pos.y, text: "", fill: color, fontSize },
      ]);
      setSelectedId(id);
      setEditingTextId(id);
      setTool("select");
    }
  }

  function handlePointerMove() {
    const drawing = drawingRef.current;
    const stage = stageRef.current;
    if (!drawing || !stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;

    setShapes((prev) =>
      prev.map((s) => {
        if (s.id !== drawing.id) return s;
        if (s.type === "rect") {
          return {
            ...s,
            x: Math.min(pos.x, drawing.startX),
            y: Math.min(pos.y, drawing.startY),
            width: Math.abs(pos.x - drawing.startX),
            height: Math.abs(pos.y - drawing.startY),
          };
        }
        if (s.type === "circle") {
          const dx = pos.x - drawing.startX;
          const dy = pos.y - drawing.startY;
          // Anchor top-left: center is always at midpoint of the drag bounding box
          return {
            ...s,
            x: drawing.startX + dx / 2,
            y: drawing.startY + dy / 2,
            radiusX: Math.abs(dx) / 2,
            radiusY: Math.abs(dy) / 2,
          };
        }
        return s;
      })
    );
  }

  function handlePointerUp() {
    const drawing = drawingRef.current;
    if (!drawing) return;
    drawingRef.current = null;
    setShapes((prev) =>
      prev.filter((s) => {
        if (s.id !== drawing.id) return true;
        if (s.type === "rect") return s.width > 4 && s.height > 4;
        if (s.type === "circle") return s.radiusX > 4 && s.radiusY > 4;
        return true;
      })
    );
  }

  function handleDragEnd(id: string, node: Konva.Node) {
    setShapes((prev) =>
      prev.map((s) => (s.id === id ? { ...s, x: node.x(), y: node.y() } : s))
    );
  }

  function handleTransformEnd(id: string, node: Konva.Node) {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    setShapes((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        if (s.type === "rect") {
          return {
            ...s,
            x: node.x(),
            y: node.y(),
            width: Math.max(5, s.width * scaleX),
            height: Math.max(5, s.height * scaleY),
          };
        }
        if (s.type === "circle") {
          return {
            ...s,
            x: node.x(),
            y: node.y(),
            radiusX: Math.max(5, s.radiusX * scaleX),
            radiusY: Math.max(5, s.radiusY * scaleY),
          };
        }
        return { ...s, x: node.x(), y: node.y() };
      })
    );
  }

  function commitText(id: string, text: string) {
    const trimmed = text.trim();
    setShapes((prev) =>
      trimmed
        ? prev.map((s) => (s.id === id && s.type === "text" ? { ...s, text: trimmed } : s))
        : prev.filter((s) => s.id !== id)
    );
    setEditingTextId(null);
  }

  function handleExport() {
    setSelectedId(null);
    requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (!stage) return;
      const uri = stage.toDataURL({ pixelRatio: 1 / stageScale });
      const link = document.createElement("a");
      link.download = "annotated-screenshot.png";
      link.href = uri;
      link.click();
    });
  }

  function registerRef(id: string) {
    return (node: Konva.Node | null) => {
      if (node) shapeRefs.current.set(id, node);
      else shapeRefs.current.delete(id);
    };
  }

  const selectedShape = shapes.find((s) => s.id === selectedId);
  const allowResize = selectedShape?.type === "rect" || selectedShape?.type === "circle";
  const editingShape = editingTextId
    ? (shapes.find((s) => s.id === editingTextId) as TextShape | undefined)
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        color={color}
        onColorChange={setColor}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        onExport={handleExport}
      />
      <div className="relative flex flex-1 items-center justify-center overflow-auto bg-neutral-950">
        {saveStatus && (
          <div
            className={`absolute right-3 top-3 z-10 rounded px-2 py-1 text-xs ${
              saveStatus === "error"
                ? "bg-red-950 text-red-300"
                : "bg-neutral-800 text-neutral-400"
            }`}
          >
            {saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "error"
                ? "Not saved — storage unavailable"
                : "Saved ✓"}
          </div>
        )}
        {imageStatus === "loading" && (
          <p className="text-neutral-400">Loading...</p>
        )}
        {imageStatus === "error" && (
          <p className="text-neutral-400">Screenshot not found.</p>
        )}
        {imageStatus === "loaded" && image && (
          <Stage
            ref={stageRef}
            width={image.width * stageScale}
            height={image.height * stageScale}
            scaleX={stageScale}
            scaleY={stageScale}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onTouchStart={handlePointerDown}
            onTouchMove={handlePointerMove}
            onTouchEnd={handlePointerUp}
          >
            <Layer>
              <KonvaImage image={image} listening={false} />
            </Layer>
            <Layer>
              {shapes.map((s) => {
                const common = {
                  draggable: tool === "select",
                  onClick: () => tool === "select" && setSelectedId(s.id),
                  onTap: () => tool === "select" && setSelectedId(s.id),
                  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) =>
                    handleDragEnd(s.id, e.target),
                  onTransformEnd: (e: Konva.KonvaEventObject<Event>) =>
                    handleTransformEnd(s.id, e.target),
                  ref: registerRef(s.id),
                };
                if (s.type === "rect") {
                  return (
                    <Rect
                      key={s.id}
                      {...common}
                      x={s.x}
                      y={s.y}
                      width={s.width}
                      height={s.height}
                      stroke={s.stroke}
                      strokeWidth={3}
                    />
                  );
                }
                if (s.type === "circle") {
                  return (
                    <Ellipse
                      key={s.id}
                      {...common}
                      x={s.x}
                      y={s.y}
                      radiusX={s.radiusX}
                      radiusY={s.radiusY}
                      stroke={s.stroke}
                      strokeWidth={3}
                    />
                  );
                }
                return (
                  <KonvaText
                    key={s.id}
                    {...common}
                    x={s.x}
                    y={s.y}
                    text={s.text || " "}
                    fill={s.fill}
                    fontSize={s.fontSize ?? DEFAULT_FONT_SIZE}
                    onClick={() => {
                      if (tool !== "select") return;
                      if (selectedId === s.id) {
                        setEditingTextId(s.id);
                      } else {
                        setSelectedId(s.id);
                      }
                    }}
                    onTap={() => {
                      if (tool !== "select") return;
                      if (selectedId === s.id) {
                        setEditingTextId(s.id);
                      } else {
                        setSelectedId(s.id);
                      }
                    }}
                    onDblClick={() => { setSelectedId(s.id); setEditingTextId(s.id); }}
                    onDblTap={() => { setSelectedId(s.id); setEditingTextId(s.id); }}
                  />
                );
              })}
              <Transformer
                ref={transformerRef}
                resizeEnabled={allowResize}
                rotateEnabled={false}
              />
            </Layer>
          </Stage>
        )}
        {editingShape && editorBox && (
          <textarea
            key={editingShape.id}
            ref={textareaRef}
            defaultValue={editingShape.text}
            style={{
              position: "fixed",
              left: editorBox.left + editingShape.x * stageScale,
              top: editorBox.top + editingShape.y * stageScale,
              fontSize: (editingShape.fontSize ?? DEFAULT_FONT_SIZE) * stageScale,
              color: editingShape.fill,
              background: "transparent",
              border: "1px dashed #999",
              outline: "none",
              resize: "none",
              minWidth: 120,
              zIndex: 50,
            }}
            onBlur={(e) => commitText(editingShape.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              }
              if (e.key === "Escape") {
                commitText(editingShape.id, editingShape.text || "");
              }
            }}
          />
        )}
      </div>
      <ShareBar shareUrl={shareUrl} sourceUrl={sourceUrl} />
    </div>
  );
}
