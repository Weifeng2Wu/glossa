"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { PdfToolbarAnchor } from "./pdf-toolbar-position";

export type PreviewTextSelection = {
  text: string;
  anchor: PdfToolbarAnchor;
};

type Options = {
  containerRef: RefObject<HTMLElement | null>;
  previewRef: RefObject<HTMLElement | null>;
  enabled: boolean;
};

function readPreviewSelection(
  container: HTMLElement | null,
  preview: HTMLElement | null,
): PreviewTextSelection | null {
  if (!container || !preview || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!preview.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rawRect = range.getBoundingClientRect();
  const rect =
    rawRect.width > 0 || rawRect.height > 0 ? rawRect : (range.getClientRects()[0] ?? null);
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  const previewRect = preview.getBoundingClientRect();
  if (
    rect.bottom < previewRect.top ||
    rect.top > previewRect.bottom ||
    rect.right < previewRect.left ||
    rect.left > previewRect.right
  )
    return null;
  const panelRect = container.getBoundingClientRect();
  return {
    text,
    anchor: {
      left: rect.left - panelRect.left,
      right: rect.right - panelRect.left,
      top: rect.top - panelRect.top,
      bottom: rect.bottom - panelRect.top,
    },
  };
}

export function usePreviewTextSelection({ containerRef, previewRef, enabled }: Options) {
  const [selection, setSelection] = useState<PreviewTextSelection | null>(null);
  const selectingRef = useRef(false);

  const sync = useCallback(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    setSelection(readPreviewSelection(containerRef.current, previewRef.current));
  }, [containerRef, enabled, previewRef]);

  const clear = useCallback(() => {
    setSelection(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    const preview = previewRef.current;
    if (!preview) return;

    const handlePointerDown = () => {
      selectingRef.current = true;
      setSelection(null);
    };
    const handlePointerUp = () => {
      if (!selectingRef.current) return;
      selectingRef.current = false;
      sync();
    };
    const handleSelectionChange = () => {
      if (selectingRef.current) return;
      sync();
    };
    const handleScroll = () => {
      if (selectingRef.current) return;
      sync();
    };

    preview.addEventListener("pointerdown", handlePointerDown);
    preview.addEventListener("scroll", handleScroll, { passive: true });
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      selectingRef.current = false;
      preview.removeEventListener("pointerdown", handlePointerDown);
      preview.removeEventListener("scroll", handleScroll);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [enabled, previewRef, sync]);

  return { selection, clear };
}
