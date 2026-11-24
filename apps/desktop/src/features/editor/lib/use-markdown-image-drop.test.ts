// @vitest-environment jsdom

import { invoke, isTauri } from "@tauri-apps/api/core";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARKDOWN_IMAGE_DRAG_EVENT,
  MARKDOWN_IMAGE_DROP_EVENT,
  useMarkdownImageDrop,
} from "./use-markdown-image-drop";

type DragPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

let dragListener: ((event: { payload: DragPayload }) => void) | null = null;
const unlistenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (listener: (event: { payload: DragPayload }) => void) => {
      dragListener = listener;
      return unlistenMock;
    }),
  }),
}));

describe("useMarkdownImageDrop", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    dragListener = null;
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  function mount(props: {
    filePath?: string;
    projectPath?: string;
    enabled?: boolean;
    onInsert?: (text: string, point?: { x: number; y: number }) => void;
    onError?: (error: unknown) => void;
  }) {
    const onInsert = props.onInsert ?? vi.fn();
    const onError = props.onError ?? vi.fn();
    function Harness() {
      const containerRef = useRef<HTMLDivElement>(null);
      const drop = useMarkdownImageDrop({
        containerRef,
        filePath: props.filePath ?? "drafts/paper.md",
        projectPath: props.projectPath ?? "/project",
        enabled: props.enabled ?? true,
        onInsert,
        onError,
      });
      return createElement("div", {
        ref: containerRef,
        "data-testid": "drop-zone",
        "data-dragging": String(drop.dragging),
        onDragEnterCapture: drop.onDragEnterCapture,
        onDragOverCapture: drop.onDragOverCapture,
        onDragLeaveCapture: drop.onDragLeaveCapture,
        onDropCapture: drop.onDropCapture,
      });
    }
    return { Harness, onInsert, onError };
  }

  it("imports external OS images dropped inside the Markdown pane using logical coordinates", async () => {
    vi.mocked(invoke).mockResolvedValue({ relativePath: "images/figure.png" });
    const { Harness, onInsert } = mount({});
    await act(async () => {
      root.render(createElement(Harness));
    });
    const zone = host.querySelector<HTMLDivElement>('[data-testid="drop-zone"]');
    expect(zone).not.toBeNull();
    vi.spyOn(zone as HTMLDivElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 50, 400, 300),
    );

    // Physical (300, 200) at DPR 2 => logical (150, 100), inside [100..500, 50..350]
    await act(async () => {
      dragListener?.({
        payload: { type: "enter", paths: ["/tmp/figure.png"], position: { x: 300, y: 200 } },
      });
    });
    expect(zone?.dataset.dragging).toBe("true");

    await act(async () => {
      dragListener?.({
        payload: { type: "drop", paths: ["/tmp/figure.png"], position: { x: 300, y: 200 } },
      });
    });
    await vi.waitFor(() => {
      expect(onInsert).toHaveBeenCalledWith("![figure](../images/figure.png)", { x: 150, y: 100 });
    });
    expect(invoke).toHaveBeenCalledWith("import_project_image", {
      sourcePath: "/tmp/figure.png",
      expectedProject: "/project",
    });
    expect(zone?.dataset.dragging).toBe("false");
  });

  it("ignores OS drops outside the pane bounds or for non-image files", async () => {
    const { Harness, onInsert } = mount({});
    await act(async () => {
      root.render(createElement(Harness));
    });
    const zone = host.querySelector<HTMLDivElement>('[data-testid="drop-zone"]');
    vi.spyOn(zone as HTMLDivElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 50, 400, 300),
    );

    await act(async () => {
      dragListener?.({
        payload: { type: "drop", paths: ["/tmp/figure.png"], position: { x: 20, y: 20 } },
      });
      dragListener?.({
        payload: { type: "drop", paths: ["/tmp/paper.pdf"], position: { x: 300, y: 200 } },
      });
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("inserts relative Markdown snippets when images are dragged from the sidebar FileTree", async () => {
    const { Harness, onInsert } = mount({ filePath: "drafts/notes.md" });
    await act(async () => {
      root.render(createElement(Harness));
    });
    const zone = host.querySelector<HTMLDivElement>('[data-testid="drop-zone"]');

    await act(async () => {
      zone?.dispatchEvent(
        new CustomEvent(MARKDOWN_IMAGE_DRAG_EVENT, { detail: { active: true } }),
      );
    });
    expect(zone?.dataset.dragging).toBe("true");

    await act(async () => {
      zone?.dispatchEvent(
        new CustomEvent(MARKDOWN_IMAGE_DROP_EVENT, {
          detail: { path: "assets/chart 1.png", clientX: 240, clientY: 160 },
        }),
      );
    });
    expect(zone?.dataset.dragging).toBe("false");
    expect(onInsert).toHaveBeenCalledWith("![chart 1](../assets/chart%201.png)", {
      x: 240,
      y: 160,
    });
  });

  it("reports errors when importing an external image fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Invalid image"));
    const { Harness, onError } = mount({});
    await act(async () => {
      root.render(createElement(Harness));
    });
    const zone = host.querySelector<HTMLDivElement>('[data-testid="drop-zone"]');
    vi.spyOn(zone as HTMLDivElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 500),
    );

    await act(async () => {
      dragListener?.({
        payload: { type: "drop", paths: ["/tmp/broken.png"], position: { x: 100, y: 100 } },
      });
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });
  });
});
