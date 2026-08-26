import { describe, expect, it } from "vitest"
import { applyLinearAssetRewrites } from "./converter.js"
import { scanLinearMarkdownImages } from "./markdown-images.js"

describe("scanLinearMarkdownImages", () => {
  it("returns the span, alt, and normalised URL for an ordinary HTTPS image", () => {
    const image = "![diagram](https://cdn.example.com/architecture.png)"
    const source = `See ${image} now`
    expect(scanLinearMarkdownImages(source)).toEqual([
      {
        start: 4,
        end: 4 + image.length,
        source: image,
        alt: "diagram",
        url: "https://cdn.example.com/architecture.png",
      },
    ])
  })

  it("parses angle-bracket destinations that contain parentheses and a query", () => {
    const image = "![x](<https://cdn.example.com/a(b).png?sig=1>)"
    expect(scanLinearMarkdownImages(`Intro ${image} out`)).toEqual([
      {
        start: 6,
        end: 6 + image.length,
        source: image,
        alt: "x",
        url: "https://cdn.example.com/a(b).png?sig=1",
      },
    ])
  })

  it("parses balanced nested parentheses in a bare destination", () => {
    const image = "![shot](https://cdn.example.com/a(b(c)).png)"
    expect(scanLinearMarkdownImages(image)).toEqual([
      {
        start: 0,
        end: image.length,
        source: image,
        alt: "shot",
        url: "https://cdn.example.com/a(b(c)).png",
      },
    ])
  })

  it("unescapes backslash-escaped parentheses in a bare destination", () => {
    const image = "![shot](https://cdn.example.com/a\\(b\\).png)"
    expect(scanLinearMarkdownImages(image)).toEqual([
      {
        start: 0,
        end: image.length,
        source: image,
        alt: "shot",
        url: "https://cdn.example.com/a(b).png",
      },
    ])
  })

  it("ignores image syntax inside inline, fenced, and indented code", () => {
    const real = "![keep](https://cdn.example.com/keep.png)"
    const markdown = [
      "Before `![nope](https://cdn.example.com/inline.png)` after",
      "",
      "```",
      "![nope](https://cdn.example.com/fenced.png)",
      "```",
      "",
      "    ![nope](https://cdn.example.com/indented.png)",
      "",
      real,
    ].join("\n")

    expect(scanLinearMarkdownImages(markdown)).toEqual([
      {
        start: markdown.indexOf(real),
        end: markdown.indexOf(real) + real.length,
        source: real,
        alt: "keep",
        url: "https://cdn.example.com/keep.png",
      },
    ])
  })

  it("resolves full, collapsed, and shortcut reference images from definitions", () => {
    const markdown = [
      "![diagram][shot]",
      "![nested][]",
      "![escaped]",
      "",
      "[shot]: https://cdn.example.com/a(b).png?sig=1",
      "[nested]: <https://cdn.example.com/a(b(c)).png>",
      "[escaped]: https://cdn.example.com/a\\(b\\).png",
      "[unused]: https://cdn.example.com/unused.png",
    ].join("\n")

    expect(
      scanLinearMarkdownImages(markdown).map(
        ({ definition: _definition, identifier: _identifier, ...image }) =>
          image,
      ),
    ).toEqual([
      {
        start: 0,
        end: "![diagram][shot]".length,
        source: "![diagram][shot]",
        alt: "diagram",
        url: "https://cdn.example.com/a(b).png?sig=1",
      },
      {
        start: markdown.indexOf("![nested][]"),
        end: markdown.indexOf("![nested][]") + "![nested][]".length,
        source: "![nested][]",
        alt: "nested",
        url: "https://cdn.example.com/a(b(c)).png",
      },
      {
        start: markdown.indexOf("![escaped]"),
        end: markdown.indexOf("![escaped]") + "![escaped]".length,
        source: "![escaped]",
        alt: "escaped",
        url: "https://cdn.example.com/a(b).png",
      },
    ])
  })

  it("leaves unresolved references, definitions, and ordinary links untouched", () => {
    expect(
      scanLinearMarkdownImages(
        [
          "![missing][nope]",
          "![also-missing][]",
          "![orphan]",
          "[label](https://cdn.example.com/link.png)",
          "[def]: https://cdn.example.com/definition.png",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  it("does not treat ordinary links or malformed image markup as images", () => {
    expect(
      scanLinearMarkdownImages(
        [
          "[design](https://cdn.example.com/a(b).png)",
          "![x](https://cdn.example.com/a(b.png)",
          "![x](<https://cdn.example.com/a.png)",
          "![x](javascript:alert(1))",
          "\\![x](https://cdn.example.com/a.png)",
        ].join("\n"),
      ),
    ).toEqual([])
  })
})

describe("applyLinearAssetRewrites", () => {
  it("rewrites angle-bracket and nested-paren images to relative paths", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "![x](<https://cdn.example.com/a(b).png?sig=1>)",
        "![shot](https://cdn.example.com/a(b(c)).png)",
      ].join(" "),
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?sig=1",
          sourceKey: "src-1",
          relativePath: "stem/assets/src-1--ab.png",
          gitPath: "linear/issues/stem/assets/src-1--ab.png",
          status: "downloaded",
          filename: "ab.png",
        },
        {
          sourceUrl: "https://cdn.example.com/a(b(c)).png",
          sourceKey: "src-2",
          relativePath: "stem/assets/src-2--abc.png",
          gitPath: "linear/issues/stem/assets/src-2--abc.png",
          status: "downloaded",
          filename: "abc.png",
        },
      ],
    )

    expect(rewritten).toBe(
      "![x](stem/assets/src-1--ab.png) ![shot](stem/assets/src-2--abc.png)",
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("sig=1")
  })

  it("emits a URL-free stub for a failed nested-paren image", () => {
    const rewritten = applyLinearAssetRewrites(
      "See ![shot](https://cdn.example.com/a(b).png?token=expiring)",
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?token=expiring",
          sourceKey: "src-3",
          relativePath: "stem/assets/src-3--ab.png",
          gitPath: "linear/issues/stem/assets/src-3--ab.png",
          status: "stub",
          reason: "download_failed",
        },
      ],
    )

    expect(rewritten).toBe("See [image: shot — unavailable]")
    expect(rewritten).not.toContain("https://")
    expect(rewritten).not.toContain("token=expiring")
  })

  it("leaves malformed image markup unchanged", () => {
    const malformed = "Keep ![x](https://cdn.example.com/a(b.png) please"
    expect(applyLinearAssetRewrites(malformed, [])).toBe(malformed)
  })

  it("removes a captured reference definition so the signed URL cannot survive", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "See ![diagram][shot] please",
        "",
        "[shot]: https://cdn.example.com/a(b).png?sig=1",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?sig=1",
          sourceKey: "src-ref",
          relativePath: "stem/assets/src-ref--ab.png",
          gitPath: "linear/issues/stem/assets/src-ref--ab.png",
          status: "downloaded",
          filename: "ab.png",
        },
      ],
    )

    expect(rewritten).toBe(
      [
        "See ![diagram](stem/assets/src-ref--ab.png) please",
        "",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("sig=1")
    expect(rewritten).not.toContain("[shot]:")
  })

  it("removes the definition after a failed reference capture without persisting the host or query", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "See ![diagram][shot]",
        "",
        "[shot]: https://cdn.example.com/a(b).png?token=expiring",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?token=expiring",
          sourceKey: "src-ref",
          relativePath: "stem/assets/src-ref--ab.png",
          gitPath: "linear/issues/stem/assets/src-ref--ab.png",
          status: "stub",
          reason: "download_failed",
        },
      ],
    )

    expect(rewritten).toBe(
      [
        "See [image: diagram — unavailable]",
        "",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("token=expiring")
    expect(rewritten).not.toContain("[shot]:")
  })

  it("removes one shared definition after rewriting every image that used it", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "![one][shot] and ![two][shot]",
        "",
        "[shot]: https://cdn.example.com/shared.png?sig=1",
      ].join("\n"),
      [
        {
          sourceUrl: "https://cdn.example.com/shared.png?sig=1",
          sourceKey: "src-shared",
          relativePath: "stem/assets/src-shared--shared.png",
          gitPath: "linear/issues/stem/assets/src-shared--shared.png",
          status: "downloaded",
          filename: "shared.png",
        },
      ],
    )

    expect(rewritten).toBe(
      "![one](stem/assets/src-shared--shared.png) and ![two](stem/assets/src-shared--shared.png)\n",
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("sig=1")
  })

  it("rewrites ordinary full, collapsed, and shortcut links for a captured identifier", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "See ![diagram][shot], [notes][shot], [shot][], and [shot].",
        "Keep [docs][keep] and [other](https://docs.example.org/other).",
        "",
        "[shot]: https://cdn.example.com/a(b).png?sig=1",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?sig=1",
          sourceKey: "src-ref",
          relativePath: "stem/assets/src-ref--ab.png",
          gitPath: "linear/issues/stem/assets/src-ref--ab.png",
          status: "downloaded",
          filename: "ab.png",
        },
      ],
    )

    expect(rewritten).toBe(
      [
        "See ![diagram](stem/assets/src-ref--ab.png), [notes](stem/assets/src-ref--ab.png), [shot](stem/assets/src-ref--ab.png), and [shot](stem/assets/src-ref--ab.png).",
        "Keep [docs][keep] and [other](https://docs.example.org/other).",
        "",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("sig=1")
    expect(rewritten).not.toContain("[shot]:")
  })

  it("uses a URL-free fallback for ordinary links when the captured reference fails", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "See ![diagram][shot] and [notes][shot]",
        "",
        "[shot]: https://cdn.example.com/a(b).png?token=expiring",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?token=expiring",
          sourceKey: "src-ref",
          relativePath: "stem/assets/src-ref--ab.png",
          gitPath: "linear/issues/stem/assets/src-ref--ab.png",
          status: "stub",
          reason: "download_failed",
        },
      ],
    )

    expect(rewritten).toBe(
      [
        "See [image: diagram — unavailable] and [notes — unavailable]",
        "",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("token=expiring")
    expect(rewritten).not.toContain("[shot]:")
  })

  it("removes every duplicate definition for a captured identifier, including CommonMark-ignored copies", () => {
    const rewritten = applyLinearAssetRewrites(
      [
        "![diagram][shot] and [notes][shot]",
        "",
        "[shot]: https://cdn.example.com/a(b).png?sig=1",
        "[shot]: https://cdn.example.com/duplicate.png?token=expiring",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
      [
        {
          sourceUrl: "https://cdn.example.com/a(b).png?sig=1",
          sourceKey: "src-ref",
          relativePath: "stem/assets/src-ref--ab.png",
          gitPath: "linear/issues/stem/assets/src-ref--ab.png",
          status: "downloaded",
          filename: "ab.png",
        },
      ],
    )

    expect(rewritten).toBe(
      [
        "![diagram](stem/assets/src-ref--ab.png) and [notes](stem/assets/src-ref--ab.png)",
        "",
        "[keep]: https://docs.example.org/readme",
      ].join("\n"),
    )
    expect(rewritten).not.toContain("cdn.example.com")
    expect(rewritten).not.toContain("sig=1")
    expect(rewritten).not.toContain("token=expiring")
    expect(rewritten).not.toContain("duplicate.png")
    expect(rewritten).not.toContain("[shot]:")
  })

  it("does not scrub unresolved or unused definitions", () => {
    const markdown = [
      "![missing][nope] and [notes][keep]",
      "",
      "[nope]: https://cdn.example.com/unused-ref.png?sig=1",
      "[keep]: https://docs.example.org/readme",
    ].join("\n")

    expect(applyLinearAssetRewrites(markdown, [])).toBe(markdown)
  })

  it("does not rewrite image syntax that only appears in code", () => {
    const markdown = [
      "Before `![nope](https://cdn.example.com/inline.png)` after",
      "",
      "```",
      "![nope](https://cdn.example.com/fenced.png)",
      "```",
    ].join("\n")
    expect(
      applyLinearAssetRewrites(markdown, [
        {
          sourceUrl: "https://cdn.example.com/inline.png",
          sourceKey: "src-inline",
          relativePath: "stem/assets/src-inline--inline.png",
          gitPath: "linear/issues/stem/assets/src-inline--inline.png",
          status: "downloaded",
          filename: "inline.png",
        },
      ]),
    ).toBe(markdown)
  })
})
