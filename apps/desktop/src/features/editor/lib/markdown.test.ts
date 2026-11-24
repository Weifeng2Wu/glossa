import { describe, expect, it } from "vitest";
import {
  isMarkdownFile,
  isMarkdownImagePath,
  MARKDOWN_SNIPPETS,
  markdownImageSnippet,
  markdownRelativePath,
  resolveMarkdownImage,
} from "./markdown";

describe("Markdown drafts", () => {
  it.each(["draft.md", "notes.MD", "paper.markdown", "notes.mdown"])("recognizes %s", (file) => {
    expect(isMarkdownFile(file)).toBe(true);
  });
  it.each([
    "paper.tex",
    "draft.mdx",
    "image.png",
    "readme.md.exe",
  ])("does not execute %s as Markdown", (file) => {
    expect(isMarkdownFile(file)).toBe(false);
  });
  it("resolves project-local images relative to the draft", () => {
    expect(resolveMarkdownImage("../images/figure%201.png", "drafts/paper.md", "/project")).toBe(
      "/project/images/figure 1.png",
    );
    expect(resolveMarkdownImage("./figure.png", "/project/drafts/paper.md", "/project")).toBe(
      "/project/drafts/figure.png",
    );
    expect(
      resolveMarkdownImage("../figures/plot.png", "C:\\Project\\drafts\\paper.md", "C:\\Project"),
    ).toBe("C:/Project/figures/plot.png");
  });
  it("preserves HTTPS images", () => {
    expect(resolveMarkdownImage("https://example.com/a.png", "draft.md", "/project")).toBe(
      "https://example.com/a.png",
    );
  });
  it.each([
    "../../outside.png",
    "%2e%2e/%2e%2e/outside.png",
    "file:///secret.png",
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "/secret.png",
    "C:\\secret.png",
    "//example.com/a.png",
    "bad%00.png",
    "%invalid",
  ])("rejects unsafe image %s", (source) => {
    expect(resolveMarkdownImage(source, "drafts/paper.md", "/project")).toBeUndefined();
  });
  it("rejects drafts outside the active project", () => {
    expect(resolveMarkdownImage("image.png", "/outside/draft.md", "/project")).toBeUndefined();
  });
  it("provides common writing snippets with literal Monaco tab stops", () => {
    expect(MARKDOWN_SNIPPETS.map(({ key }) => key)).toEqual([
      "heading",
      "link",
      "image",
      "table",
      "code",
      "math",
      "task",
    ]);
    for (const snippet of MARKDOWN_SNIPPETS) {
      expect(snippet.body).toContain("$0");
      expect(snippet.body).toMatch(/\$\{1:/);
    }
  });
  it("recognizes supported Markdown image paths", () => {
    for (const image of ["fig.png", "photo.JPG", "chart.webp", "diagram.svg", "shot.avif"]) {
      expect(isMarkdownImagePath(image)).toBe(true);
    }
    for (const nonImage of ["paper.pdf", "notes.md", "main.tex", "image.png.bak"]) {
      expect(isMarkdownImagePath(nonImage)).toBe(false);
    }
  });
  it("computes relative Markdown image paths and snippets that round-trip cleanly", () => {
    expect(markdownRelativePath("draft.md", "images/figure.png", "/project")).toBe(
      "images/figure.png",
    );
    expect(markdownRelativePath("drafts/paper.md", "images/figure 1 (final).png", "/project")).toBe(
      "../images/figure%201%20%28final%29.png",
    );
    expect(
      markdownRelativePath("C:\\Project\\drafts\\paper.md", "images/图表 1.png", "C:\\Project"),
    ).toBe("../images/图表%201.png");
    expect(markdownImageSnippet("drafts/paper.md", "images/result [1].png", "/project")).toBe(
      "![result 1](../images/result%20[1].png)",
    );
    const relative = markdownRelativePath(
      "drafts/section/intro.md",
      "images/figure 1 (v2).png",
      "/project",
    );
    expect(resolveMarkdownImage(relative, "drafts/section/intro.md", "/project")).toBe(
      "/project/images/figure 1 (v2).png",
    );
  });
});
