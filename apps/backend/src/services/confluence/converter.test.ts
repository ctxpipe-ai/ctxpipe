import { describe, expect, it } from "vitest"
import {
  confluenceExternalSourceKey,
  confluencePageAssetPath,
  isManagedConfluenceMarkdownForPage,
  relativeConfluenceAssetHref,
  toConfluenceMarkdownFile,
} from "./converter.js"

const pages = [{ id: "42", title: "Design", parentId: null }]

function leafFile(bodyStorage: string) {
  return toConfluenceMarkdownFile({
    spaceKey: "ENG",
    pageId: "42",
    title: "Design",
    bodyStorage,
    pages,
    selectedIds: new Set(["42"]),
    resolveMedia: (media) => {
      if (media.kind === "attachment") {
        return {
          status: "ok",
          href: relativeConfluenceAssetHref(
            "confluence/ENG/design--42.md",
            confluencePageAssetPath({
              spaceKey: "ENG",
              pageId: "42",
              sourceKey: "att100",
              filename: media.filename,
            }),
          ),
        }
      }
      return {
        status: "ok",
        href: relativeConfluenceAssetHref(
          "confluence/ENG/design--42.md",
          confluencePageAssetPath({
            spaceKey: "ENG",
            pageId: "42",
            sourceKey: confluenceExternalSourceKey(media.url),
            filename: "logo.png",
          }),
        ),
      }
    },
  })
}

describe("Confluence markdown paths", () => {
  it("keeps leaf pages as title--id.md under the space", () => {
    const file = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "42",
      title: "Design",
      bodyStorage: "<p>Hello</p>",
      pages,
      selectedIds: new Set(["42"]),
    })
    expect(file.path).toBe("confluence/ENG/design--42.md")
    expect(file.content).toBe("# Design\n\nHello\n")
  })

  it("keys branch and ancestor directories immutably by page id", () => {
    const pages = [
      { id: "1", title: "Parent", parentId: null },
      { id: "2", title: "Child", parentId: "1" },
    ]
    const parent = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "1",
      title: "Parent",
      bodyStorage: "<p>Root</p>",
      pages,
      selectedIds: new Set(["1", "2"]),
    })
    const child = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "2",
      title: "Child",
      bodyStorage: "<p>Leaf</p>",
      pages,
      selectedIds: new Set(["1", "2"]),
    })
    expect(parent.path).toBe("confluence/ENG/page--1/index.md")
    expect(child.path).toBe("confluence/ENG/page--1/child--2.md")
  })

  it("keeps descendant paths identical when an ancestor title changes", () => {
    const before = [
      { id: "1", title: "Parent", parentId: null },
      { id: "2", title: "Child", parentId: "1" },
    ]
    const after = [
      { id: "1", title: "Folder", parentId: null },
      { id: "2", title: "Child", parentId: "1" },
    ]
    const parentBefore = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "1",
      title: "Parent",
      bodyStorage: "<p>Root</p>",
      pages: before,
      selectedIds: new Set(["1", "2"]),
    })
    const parentAfter = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "1",
      title: "Folder",
      bodyStorage: "<p>Root</p>",
      pages: after,
      selectedIds: new Set(["1", "2"]),
    })
    const childBefore = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "2",
      title: "Child",
      bodyStorage: "<p>Leaf</p>",
      pages: before,
      selectedIds: new Set(["1", "2"]),
    })
    const childAfter = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "2",
      title: "Child",
      bodyStorage: "<p>Leaf</p>",
      pages: after,
      selectedIds: new Set(["1", "2"]),
    })
    expect(parentBefore.path).toBe("confluence/ENG/page--1/index.md")
    expect(parentAfter.path).toBe(parentBefore.path)
    expect(childBefore.path).toBe("confluence/ENG/page--1/child--2.md")
    expect(childAfter.path).toBe(childBefore.path)
  })
})

describe("isManagedConfluenceMarkdownForPage", () => {
  it("matches only managed markdown for the exact page id", () => {
    expect(
      isManagedConfluenceMarkdownForPage("confluence/ENG/design--42.md", "42"),
    ).toBe(true)
    expect(
      isManagedConfluenceMarkdownForPage(
        "confluence/ENG/page--1/child--42.md",
        "42",
      ),
    ).toBe(true)
    expect(
      isManagedConfluenceMarkdownForPage(
        "confluence/ENG/page--42/index.md",
        "42",
      ),
    ).toBe(true)
    expect(
      isManagedConfluenceMarkdownForPage(
        "confluence/ENG/parent--42/index.md",
        "42",
      ),
    ).toBe(true)
    expect(
      isManagedConfluenceMarkdownForPage(
        "confluence/ENG/_assets/42/att100--diagram.png",
        "42",
      ),
    ).toBe(false)
    expect(
      isManagedConfluenceMarkdownForPage("confluence/ENG/other--99.md", "42"),
    ).toBe(false)
    expect(
      isManagedConfluenceMarkdownForPage("confluence/ENG/design--420.md", "42"),
    ).toBe(false)
    // Legacy branch directories omitted the page id; only a full reconcile
    // can safely delete them via the desired-set prune.
    expect(
      isManagedConfluenceMarkdownForPage("confluence/ENG/parent/index.md", "1"),
    ).toBe(false)
  })
})

describe("Confluence storage media", () => {
  it("preserves surrounding text around an ac:image attachment", () => {
    const file = leafFile(
      '<p>Before the figure.</p><ac:image ac:alt="Architecture"><ri:attachment ri:filename="diagram.png" /></ac:image><p>After the figure.</p>',
    )
    expect(file.content).toBe(
      "# Design\n\nBefore the figure.\n\n![Architecture](_assets/42/att100--diagram.png)\n\nAfter the figure.\n",
    )
  })

  it("turns ac:link and view-file attachments into relative file links", () => {
    const file = leafFile(
      '<p>See <ac:link><ri:attachment ri:filename="spec.pdf" /><ac:plain-text-link-body><![CDATA[the spec]]></ac:plain-text-link-body></ac:link>.</p><ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name"><ri:attachment ri:filename="deck.pptx" /></ac:parameter></ac:structured-macro>',
    )
    expect(file.content).toContain("[the spec](_assets/42/att100--spec.pdf)")
    expect(file.content).toContain("[deck.pptx](_assets/42/att100--deck.pptx)")
    expect(file.content).toContain("See ")
  })

  it("keeps ordinary Confluence links as links instead of media", () => {
    const file = leafFile(
      '<p>Read <ac:link><ri:url ri:value="https://example.com/guide" /><ac:plain-text-link-body><![CDATA[the guide]]></ac:plain-text-link-body></ac:link>.</p>',
    )

    expect(file.content).toContain(
      "Read [the guide](https://example.com/guide).",
    )
    expect(file.content).not.toContain("_assets/")
  })

  it("decodes XML entities in attachment names and URLs", () => {
    const file = leafFile(
      '<p>Team &#x41;.</p><p><ac:link><ri:url ri:value="https://example.com/guide?x=1&amp;sig=abc" /><ac:link-body>R&amp;D guide</ac:link-body></ac:link></p><ac:image ac:alt="Team"><ri:attachment ri:filename="john&amp;mary.png" /></ac:image>',
    )

    expect(file.content).toContain("Team A.")
    expect(file.content).toContain(
      "[R&D guide](https://example.com/guide?x=1&sig=abc)",
    )
    expect(file.content).toContain(
      "![Team](_assets/42/att100--john-and-mary.png)",
    )
  })

  it("downloads explicit external ri:url media via a resolved local href", () => {
    const file = leafFile(
      '<p>Logo:</p><ac:image ac:alt="Logo"><ri:url ri:value="https://cdn.example.com/logo.png" /></ac:image>',
    )
    expect(file.content).toBe(
      "# Design\n\nLogo:\n\n![Logo](_assets/42/2443b42f4c45--logo.png)\n",
    )
  })

  it("stubs omitted media without dropping the rest of the page", () => {
    const file = toConfluenceMarkdownFile({
      spaceKey: "ENG",
      pageId: "42",
      title: "Design",
      bodyStorage:
        '<p>Keep me.</p><ac:image ac:alt="Huge"><ri:attachment ri:filename="huge.png" /></ac:image>',
      pages,
      selectedIds: new Set(["42"]),
      resolveMedia: () => ({ status: "stub", reason: "asset_limit" }),
    })
    expect(file.content).toBe(
      "# Design\n\nKeep me.\n\n[omitted: Huge (exceeds 25 MiB)]\n",
    )
  })
})

describe("Confluence asset paths", () => {
  it("places files under confluence/<spaceKey>/_assets/<pageId>/", () => {
    expect(
      confluencePageAssetPath({
        spaceKey: "ENG",
        pageId: "42",
        sourceKey: "att100",
        filename: "Architecture diagram.PNG",
      }),
    ).toBe("confluence/ENG/_assets/42/att100--architecture-diagram.png")
  })

  it("uses a stable source key for external URLs", () => {
    expect(
      confluenceExternalSourceKey("https://cdn.example.com/logo.png"),
    ).toBe("2443b42f4c45")
    expect(
      confluenceExternalSourceKey(
        "https://cdn.example.com/logo.png?X-Amz-Credential=key&X-Amz-Signature=rotated",
      ),
    ).toBe(confluenceExternalSourceKey("https://cdn.example.com/logo.png"))
  })
})
