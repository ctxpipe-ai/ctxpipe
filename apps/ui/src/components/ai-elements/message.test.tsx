import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { MessageResponse } from "./message"

function render(markdown: string) {
  return renderToStaticMarkup(
    <MessageResponse onOpenFile={() => {}}>{markdown}</MessageResponse>,
  )
}

describe("MessageResponse file links", () => {
  it.each([
    "knowledge/x.md",
    "./knowledge/x.md",
    "knowledge/x.md#L12",
    "knowledge/x.md#L12-L20",
    "knowledge/x.md:12",
    "knowledge/x.md:12:5",
    "file:///workspace/knowledge/x.md",
    "/workspace/knowledge/x.md",
  ])("makes the link target %j a file link without [blocked]", (href) => {
    const html = render(`See [\`knowledge/x.md\`](${href}) now.`)
    expect(html).not.toContain("blocked")
    expect(html).toContain("data-ctx-file-link")
    expect(html).not.toContain("<a ")
  })

  it("keeps the content of a link to a path that is not in the Workspace", () => {
    const html = render("See [the notes](../outside/notes.md#L3) now.")
    expect(html).not.toContain("blocked")
    expect(html).not.toContain("<a ")
    expect(html).toContain("the notes")
  })

  it("still turns code inside an unwrapped link into a file link", () => {
    const html = render("See [`knowledge/x.md`](mailto:a@b.co) now.")
    expect(html).not.toContain("blocked")
    expect(html).toContain("data-ctx-file-link")
  })

  it("opens the href target of a file: link, not the link text", () => {
    const html = render("See [the file](file:///workspace/knowledge/x.md) now.")
    expect(html).toContain("data-ctx-file-link")
    expect(html).toContain("the file")
    expect(html).not.toContain("<a ")
    const code = render("See [`other.md`](file:///workspace/knowledge/x.md).")
    expect(code).toContain("data-ctx-file-link")
    expect(code).toContain("other.md")
  })

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,hi",
    "vbscript:msgbox(1)",
    "//evil.com",
    "javascript%3Aalert(1)",
    "file:///etc/passwd",
    "file:///workspace/../etc/passwd",
    "file://host/workspace/x.md",
    "foo/../../secret.md",
    "C:\\code\\a.ts",
  ])("leaves the unsafe href %j as plain text", (href) => {
    const html = render(`See [the link](${href}) now.`)
    expect(html).toContain("the link")
    expect(html).not.toContain("href=")
    expect(html).not.toContain("data-ctx-file-link")
  })

  it("keeps a real https link as a link button", () => {
    const html = render("See [site](https://example.com) now.")
    expect(html).toContain('data-streamdown="link"')
    expect(html).not.toContain("data-ctx-file-link")
  })

  it("keeps an in-page anchor link the same as with file links off", () => {
    const markdown = "Jump to [Options](#options) now."
    const withFiles = render(markdown)
    const withoutFiles = renderToStaticMarkup(
      <MessageResponse>{markdown}</MessageResponse>,
    )
    expect(withFiles).not.toContain("data-ctx-file-link")
    expect(withFiles).toBe(withoutFiles)
    expect(withFiles).toContain("Options")
  })

  // Accepted behavior, not a goal: it was never a link before, so harden
  // blocks it and the link text stays.
  it("accepts that an uppercase-scheme HTTPS link is blocked, not made a file link", () => {
    const html = render("See [site](HTTPS://example.com) now.")
    expect(html).not.toContain("data-ctx-file-link")
    expect(html).not.toContain("href=")
  })
})
