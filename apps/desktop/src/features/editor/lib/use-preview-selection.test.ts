// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewTextSelection } from "./use-preview-selection";

describe("usePreviewTextSelection", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  function Harness({ enabled = true }: { enabled?: boolean }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const { selection } = usePreviewTextSelection({ containerRef, previewRef, enabled });
    return createElement(
      "div",
      { ref: containerRef, "data-testid": "container" },
      createElement("div", { ref: previewRef, "data-testid": "preview" }, "Hello world"),
      createElement("div", { "data-testid": "outside" }, "Outside text"),
      createElement("output", { "data-testid": "selected" }, selection?.text ?? ""),
    );
  }

  it("captures text selected inside the preview pane and ignores outside selections", async () => {
    await act(async () => {
      root.render(createElement(Harness));
    });
    const container = host.querySelector<HTMLDivElement>('[data-testid="container"]');
    const preview = host.querySelector<HTMLDivElement>('[data-testid="preview"]');
    const outside = host.querySelector<HTMLDivElement>('[data-testid="outside"]');
    const output = host.querySelector<HTMLElement>('[data-testid="selected"]');
    expect(container && preview && outside && output).toBeTruthy();

    vi.spyOn(container as HTMLDivElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 600, 400),
    );
    vi.spyOn(preview as HTMLDivElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 60, 600, 360),
    );

    const previewTextNode = preview?.firstChild as Node;
    const range = {
      commonAncestorContainer: previewTextNode,
      getBoundingClientRect: () => new DOMRect(50, 120, 80, 20),
      getClientRects: () => [new DOMRect(50, 120, 80, 20)],
    };
    const mockSelection = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "Hello world",
    };
    vi.spyOn(window, "getSelection").mockReturnValue(mockSelection as unknown as Selection);

    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(output?.textContent).toBe("Hello world");

    // Selection outside preview pane should be cleared
    range.commonAncestorContainer = outside?.firstChild as Node;
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(output?.textContent).toBe("");
  });

  it("clears the selection when disabled", async () => {
    await act(async () => {
      root.render(createElement(Harness, { enabled: false }));
    });
    const output = host.querySelector<HTMLElement>('[data-testid="selected"]');
    expect(output?.textContent).toBe("");
  });
});
