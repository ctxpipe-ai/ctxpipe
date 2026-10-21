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
})
