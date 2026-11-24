"use client";

import { CodeIcon, ColumnsIcon, EyeIcon, LinkSimpleIcon, NoteIcon } from "@phosphor-icons/react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { motion, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import {
  type ComponentProps,
  useCallback,
  useDeferredValue,
  useId,
  useRef,
  useState,
} from "react";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/features/i18n";
import type { MarkdownLinkKind } from "@/lib/markdown-links";
import { resolveMarkdownImage } from "../lib/markdown";
import { useMarkdownImageDrop } from "../lib/use-markdown-image-drop";
import { MonacoEditor } from "./lazy";
import type { MonacoEditorActions } from "./monaco-editor";

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
  const editorActionsRef = useRef<MonacoEditorActions | null>(null);
  const content = useDeferredValue(props.content ?? "");
  const contentRef = useRef(props.content ?? "");
  contentRef.current = props.content ?? "";
  const onContentChangeRef = useRef(props.onContentChange);
  onContentChangeRef.current = props.onContentChange;

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
