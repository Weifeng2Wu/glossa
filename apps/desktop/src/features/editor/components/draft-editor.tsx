"use client";

import {
  CodeIcon,
  ColumnsIcon,
  EyeIcon,
  LinkSimpleIcon,
  NoteIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { motion, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import {
  type ComponentProps,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/features/i18n";
import {
  readTranslationConfig,
  TRANSLATION_STORAGE,
  type TranslationConfig,
} from "@/features/translation";
import type { MarkdownLinkKind } from "@/lib/markdown-links";
import { resolveMarkdownImage } from "../lib/markdown";
import { pdfToolbarPosition } from "../lib/pdf-toolbar-position";
import { useMarkdownImageDrop } from "../lib/use-markdown-image-drop";
import { usePreviewTextSelection } from "../lib/use-preview-selection";
import { MonacoEditor } from "./lazy";
import type { MonacoEditorActions } from "./monaco-editor";
import { PdfTranslationPanel } from "./pdf-translation-panel";

const MarkdownContent = dynamic(() =>
  import("@/components/markdown/markdown-content").then((module) => module.MarkdownContent),
);

type ViewMode = "source" | "split" | "preview";

export function DraftEditor({
  filePath,
  projectPath,
  backlinks = [],
  onBacklinkClick,
  onWikiLinkClick,
  ...props
}: ComponentProps<typeof MonacoEditor> & {
  filePath: string;
  projectPath: string;
  backlinks?: string[];
  onBacklinkClick?: (path: string) => void;
  onWikiLinkClick?: (target: string, kind?: MarkdownLinkKind) => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [mode, setMode] = useState<ViewMode>("split");
  const indicatorId = `draft-view-${useId()}`;
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const selectionToolbarRef = useRef<HTMLDivElement>(null);
  const editorActionsRef = useRef<MonacoEditorActions | null>(null);
  const [translation, setTranslation] = useState<{
    text: string;
    config: TranslationConfig;
  } | null>(null);
  const [selectionPosition, setSelectionPosition] = useState({ left: 8, top: 44 });
  const content = useDeferredValue(props.content ?? "");
  const contentRef = useRef(props.content ?? "");
  contentRef.current = props.content ?? "";
  const onContentChangeRef = useRef(props.onContentChange);
  onContentChangeRef.current = props.onContentChange;

  const { selection: previewSelection, clear: clearPreviewSelection } = usePreviewTextSelection({
    containerRef,
    previewRef,
    enabled: mode !== "source",
  });

  const startTranslation = useCallback(() => {
    if (!previewSelection) return;
    setTranslation({ text: previewSelection.text, config: readTranslationConfig() });
    clearPreviewSelection();
  }, [clearPreviewSelection, previewSelection]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const toolbar = selectionToolbarRef.current;
    if (!previewSelection || !container || !toolbar) return;
    const panel = container.getBoundingClientRect();
    const size = toolbar.getBoundingClientRect();
    const next = pdfToolbarPosition(
      previewSelection.anchor,
      panel,
      { width: size.width || 96, height: size.height || 36 },
      44,
    );
    setSelectionPosition((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [previewSelection]);

  useEffect(() => {
    if (!translation) return;
    const handleConfigChange = () => {
      setTranslation((current) =>
        current ? { ...current, config: readTranslationConfig() } : null,
      );
    };
    window.addEventListener(TRANSLATION_STORAGE, handleConfigChange);
    return () => window.removeEventListener(TRANSLATION_STORAGE, handleConfigChange);
  }, [translation]);

  useEffect(() => {
    if (!previewSelection && !translation) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (translation) setTranslation(null);
        else clearPreviewSelection();
        return;
      }
      if (
        !previewSelection ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLowerCase() !== "t"
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true'], .monaco-editor") ||
        target?.isContentEditable
      )
        return;
      event.preventDefault();
      startTranslation();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [clearPreviewSelection, previewSelection, startTranslation, translation]);

  const insertDroppedImage = useCallback((snippet: string, point?: { x: number; y: number }) => {
    if (editorActionsRef.current?.insert(snippet, point)) return;
    const current = contentRef.current;
    const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    onContentChangeRef.current?.(`${current}${separator}${snippet}`);
  }, []);

  const handleImageDropError = useCallback(
    (error: unknown) => {
      toast(t("markdown.imageInsertFailed", { error: String(error) }), "error");
    },
    [t, toast],
  );

  const imageDrop = useMarkdownImageDrop({
    containerRef,
    filePath,
    projectPath,
    enabled: !props.readOnly && Boolean(projectPath),
    onInsert: insertDroppedImage,
    onError: handleImageDropError,
  });

  const resolveImage = useCallback(
    (source: string) => {
      const path = resolveMarkdownImage(source, filePath, projectPath);
      if (!path || /^https?:\/\//i.test(path)) return path;
      return isTauri() ? convertFileSrc(path) : undefined;
    },
    [filePath, projectPath],
  );
  const views = [
    { mode: "source", icon: CodeIcon, label: t("markdown.source") },
    { mode: "split", icon: ColumnsIcon, label: t("markdown.split") },
    { mode: "preview", icon: EyeIcon, label: t("markdown.preview") },
  ] as const;
  return (
    <section
      ref={containerRef}
      data-markdown-image-drop={!props.readOnly && Boolean(projectPath) ? "true" : undefined}
      onDragEnterCapture={imageDrop.onDragEnterCapture}
      onDragOverCapture={imageDrop.onDragOverCapture}
      onDragLeaveCapture={imageDrop.onDragLeaveCapture}
      onDropCapture={imageDrop.onDropCapture}
      className="relative flex h-full min-h-0 flex-col bg-background"
      aria-label={t("markdown.draft")}
    >
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="section-label truncate">{t("markdown.draft")}</span>
        <fieldset
          aria-label={t("markdown.viewMode")}
          className="flex shrink-0 rounded-md bg-surface-secondary p-0.5"
        >
          {views.map(({ mode: view, icon: Icon, label }) => (
            <Tooltip key={view} label={label}>
              <button
                type="button"
                className={`relative flex h-6 w-8 items-center justify-center rounded transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent ${
                  mode === view ? "text-foreground" : "text-muted hover:text-foreground"
                }`}
                aria-label={label}
                aria-pressed={mode === view}
                onClick={() => setMode(view)}
              >
                {mode === view && (
                  <motion.span
                    layoutId={indicatorId}
                    transition={
                      reducedMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 520, damping: 42 }
                    }
                    className="absolute inset-0 rounded border border-border bg-background shadow-sm"
                  />
                )}
                <Icon className="relative size-4" aria-hidden="true" />
              </button>
            </Tooltip>
          ))}
        </fieldset>
      </div>
      <div
        className={`grid min-h-0 flex-1 ${mode === "split" ? "grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1" : "grid-cols-1"}`}
      >
        <div className={`min-h-0 min-w-0 ${mode === "preview" ? "hidden" : ""}`}>
          <MonacoEditor
            {...props}
            editorActionsRef={editorActionsRef}
            goToLine={mode === "preview" ? undefined : props.goToLine}
            language="markdown"
            className="h-full"
          />
        </div>
        {mode !== "source" && (
          <section
            ref={previewRef}
            aria-label={t("markdown.preview")}
            className={`min-h-0 min-w-0 overflow-auto overscroll-contain ${mode === "split" ? "border-t border-border md:border-t-0 md:border-l" : ""}`}
          >
            <article
              className="motion-fade mx-auto w-full px-6 py-8 lg:px-10"
              aria-busy={content !== props.content}
            >
              {content.trim() ? (
                <MarkdownContent
                  text={content}
                  variant="document"
                  resolveImage={resolveImage}
                  onWikiLinkClick={onWikiLinkClick}
                  revealLine={props.goToLine}
                />
              ) : (
                <p className="mx-auto max-w-[72ch] text-sm text-muted">{t("markdown.empty")}</p>
              )}
            </article>
          </section>
        )}
      </div>
      {previewSelection && (
        <div
          ref={selectionToolbarRef}
          role="toolbar"
          aria-label={t("translation.action")}
          className="motion-pop absolute z-20 flex select-none items-center rounded-lg border border-border bg-background p-1 text-foreground shadow-lg"
          style={selectionPosition}
          onPointerDown={(event) => {
            if (event.button === 0 && event.pointerType !== "touch") event.preventDefault();
          }}
        >
          <Tooltip label={t("translation.action")} keys="T" side="top">
            <button
              type="button"
              className="toolbar-icon-button flex items-center gap-1.5 px-2 text-xs"
              aria-label={t("translation.action")}
              aria-keyshortcuts="T"
              onClick={startTranslation}
            >
              <TranslateIcon aria-hidden="true" className="size-4" />
              <span>{t("translation.action")}</span>
            </button>
          </Tooltip>
        </div>
      )}
      {translation && (
        <PdfTranslationPanel
          top={44}
          text={translation.text}
          config={translation.config}
          onClose={() => setTranslation(null)}
        />
      )}
      {backlinks.length > 0 && (
        <nav
          aria-label={t("markdown.backlinks")}
          className="flex max-h-28 shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 overflow-y-auto border-t border-border bg-surface px-3 py-1.5"
        >
          <span className="section-label mr-1 flex shrink-0 items-center gap-1">
            <LinkSimpleIcon className="size-3.5" aria-hidden="true" />
            {t("markdown.backlinks")}
            <span className="tabular-nums">{backlinks.length}</span>
          </span>
          {backlinks.map((path) => (
            <button
              type="button"
              key={path}
              className="list-row flex h-7 max-w-[240px] shrink-0 items-center gap-1.5 rounded px-2 text-[13px] text-foreground-secondary hover:text-foreground"
              onClick={() => onBacklinkClick?.(path)}
              title={path}
            >
              <NoteIcon className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate">
                {path
                  .split(/[\\/]/)
                  .pop()
                  ?.replace(/\.(md|markdown|mdown)$/i, "") ?? path}
              </span>
            </button>
          ))}
        </nav>
      )}
      {imageDrop.dragging && (
        <div className="motion-fade pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border border-dashed border-accent bg-background/80 text-sm text-foreground">
          {t("markdown.dropImages")}
        </div>
      )}
    </section>
  );
}
