"use client";

import { invoke, isTauri } from "@tauri-apps/api/core";
import { type DragEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { isMarkdownImagePath, markdownImageSnippet } from "./markdown";

export const MARKDOWN_IMAGE_DRAG_EVENT = "glossa-markdown-image-drag";
export const MARKDOWN_IMAGE_DROP_EVENT = "glossa-markdown-image-drop";

export type MarkdownImageDropDetail = {
  path: string;
  clientX: number;
  clientY: number;
};

type ImportedImage = {
  relativePath: string;
};

type InsertPoint = { x: number; y: number };

type Options = {
  containerRef: RefObject<HTMLElement | null>;
  filePath: string;
  projectPath: string;
  enabled: boolean;
  onInsert: (text: string, point?: InsertPoint) => void;
  onError?: (error: unknown) => void;
};

function pointInsideElement(element: HTMLElement | null, x: number, y: number): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function logicalPoint(position: { x: number; y: number }): InsertPoint {
  const scale = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

function hasHtmlImageFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return Array.from(dataTransfer.files).some(
      (file) => file.type.startsWith("image/") || isMarkdownImagePath(file.name),
    );
  }
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    return Array.from(dataTransfer.items).some(
      (item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")),
    );
  }
  return Array.from(dataTransfer.types ?? []).includes("Files");
}

function imageExtensionFromMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico";
    case "image/avif":
      return "avif";
    default:
      return "png";
  }
}

export function useMarkdownImageDrop({
  containerRef,
  filePath,
  projectPath,
  enabled,
  onInsert,
  onError,
}: Options) {
  const [dragging, setDragging] = useState(false);
  const insertRef = useRef(onInsert);
  const errorRef = useRef(onError);
  const filePathRef = useRef(filePath);
  const projectPathRef = useRef(projectPath);
  const nativeDragHasImagesRef = useRef(false);
  const lastNativeDropAtRef = useRef(0);
  const htmlDragDepthRef = useRef(0);

  insertRef.current = onInsert;
  errorRef.current = onError;
  filePathRef.current = filePath;
  projectPathRef.current = projectPath;

  // 1. OS-level file drag-and-drop via Tauri WebView events
  useEffect(() => {
    if (!enabled || !projectPath || !isTauri()) return;
    let active = true;
    let stop: (() => void) | undefined;
    const imagePaths = (paths: string[]) => paths.filter(isMarkdownImagePath);

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          if (payload.type === "enter") {
            const hasImages = imagePaths(payload.paths).length > 0;
            nativeDragHasImagesRef.current = hasImages;
            const point = logicalPoint(payload.position);
            setDragging(hasImages && pointInsideElement(containerRef.current, point.x, point.y));
          } else if (payload.type === "over") {
            if (!nativeDragHasImagesRef.current) return;
            const point = logicalPoint(payload.position);
            setDragging(pointInsideElement(containerRef.current, point.x, point.y));
          } else if (payload.type === "leave") {
            nativeDragHasImagesRef.current = false;
            setDragging(false);
          } else if (payload.type === "drop") {
            nativeDragHasImagesRef.current = false;
            setDragging(false);
            const dropped = imagePaths(payload.paths);
            if (!dropped.length) return;
            const point = logicalPoint(payload.position);
            if (!pointInsideElement(containerRef.current, point.x, point.y)) return;
            lastNativeDropAtRef.current = Date.now();
            const currentProject = projectPathRef.current;
            const currentFile = filePathRef.current;
            void (async () => {
              try {
                const snippets: string[] = [];
                for (const sourcePath of dropped) {
                  const imported = await invoke<ImportedImage>("import_project_image", {
                    sourcePath,
                    expectedProject: currentProject,
                  });
                  snippets.push(
                    markdownImageSnippet(currentFile, imported.relativePath, currentProject),
                  );
                }
                if (snippets.length && active) {
                  insertRef.current(snippets.join("\n"), point);
                }
              } catch (error) {
                if (active) errorRef.current?.(error);
              }
            })();
          }
        }),
      )
      .then((unlisten) => {
        if (active) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});

    return () => {
      active = false;
      nativeDragHasImagesRef.current = false;
      setDragging(false);
      stop?.();
    };
  }, [containerRef, enabled, projectPath]);

  // 2. Sidebar FileTree mouse-based drag-and-drop events
  useEffect(() => {
    const element = containerRef.current;
    if (!enabled || !element) return;
    const handleTreeDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setDragging(Boolean(detail?.active));
    };
    const handleTreeDrop = (event: Event) => {
      setDragging(false);
      const detail = (event as CustomEvent<MarkdownImageDropDetail>).detail;
      if (!detail?.path || !isMarkdownImagePath(detail.path)) return;
      const snippet = markdownImageSnippet(filePathRef.current, detail.path, projectPathRef.current);
      insertRef.current(snippet, { x: detail.clientX, y: detail.clientY });
    };
    element.addEventListener(MARKDOWN_IMAGE_DRAG_EVENT, handleTreeDrag);
    element.addEventListener(MARKDOWN_IMAGE_DROP_EVENT, handleTreeDrop);
    return () => {
      element.removeEventListener(MARKDOWN_IMAGE_DRAG_EVENT, handleTreeDrag);
      element.removeEventListener(MARKDOWN_IMAGE_DROP_EVENT, handleTreeDrop);
    };
  }, [containerRef, enabled]);

  // 3. HTML5 drag-and-drop fallback (e.g. dragging images from a browser or non-Tauri mode)
  const onDragEnterCapture = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasHtmlImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      htmlDragDepthRef.current += 1;
      setDragging(true);
    },
    [enabled],
  );

  const onDragOverCapture = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasHtmlImageFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragLeaveCapture = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || htmlDragDepthRef.current === 0) return;
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        htmlDragDepthRef.current = 0;
        setDragging(false);
      } else {
        htmlDragDepthRef.current = Math.max(0, htmlDragDepthRef.current - 1);
        if (htmlDragDepthRef.current === 0) setDragging(false);
      }
    },
    [enabled],
  );

  const onDropCapture = useCallback(
    (event: DragEvent<HTMLElement>) => {
      htmlDragDepthRef.current = 0;
      setDragging(false);
      if (!enabled || !projectPathRef.current) return;
      if (Date.now() - lastNativeDropAtRef.current < 200) return;
      const files = Array.from(event.dataTransfer?.files ?? []).filter(
        (file) => file.type.startsWith("image/") || isMarkdownImagePath(file.name),
      );
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const point = { x: event.clientX, y: event.clientY };
      const currentProject = projectPathRef.current;
      const currentFile = filePathRef.current;
      void (async () => {
        try {
          if (!isTauri()) {
            const snippets = files.map((file) => {
              const name =
                file.name && isMarkdownImagePath(file.name)
                  ? file.name
                  : `image.${imageExtensionFromMime(file.type)}`;
              return markdownImageSnippet(currentFile, `images/${name}`, currentProject);
            });
            insertRef.current(snippets.join("\n"), point);
            return;
          }
          const snippets: string[] = [];
          for (const file of files) {
            const buffer = await file.arrayBuffer();
            const name =
              file.name && isMarkdownImagePath(file.name)
                ? file.name
                : `image.${imageExtensionFromMime(file.type)}`;
            const imported = await invoke<ImportedImage>("import_project_image_bytes", {
              name,
              bytes: Array.from(new Uint8Array(buffer)),
              expectedProject: currentProject,
            });
            snippets.push(markdownImageSnippet(currentFile, imported.relativePath, currentProject));
          }
          if (snippets.length) insertRef.current(snippets.join("\n"), point);
        } catch (error) {
          errorRef.current?.(error);
        }
      })();
    },
    [enabled],
  );

  return {
    dragging,
    onDragEnterCapture,
    onDragOverCapture,
    onDragLeaveCapture,
    onDropCapture,
  };
}
