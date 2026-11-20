import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { beforeAll, describe, expect, it } from "vitest"

import { buildConverter } from "../../test/converter.js"
import {
  type Conversion,
  convertFile,
  converterBinary,
  converterVersion,
  fileType,
} from "./convert-file.js"

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/convert/${name}`, import.meta.url)),
  )
const visionFixture = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../evals/knowledge/fixtures/vision/${name}`, import.meta.url),
    ),
  )

const convert = (name: string, bytes: Buffer = fixture(name)) => {
  const type = fileType(name)
  if (type?.kind !== "convert") throw new Error(`No converter for ${name}`)
  return convertFile(type.format, bytes)
}

/** The width and the height of a PNG, from its IHDR chunk. */
const pngSize = (png: Buffer) => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
})

// The real CLI of this checkout.
beforeAll(buildConverter, 900_000)

describe("fileType", () => {
  it("routes a path to the converter, the vision model, a failure or nothing", () => {
    expect(fileType("a/Report.PDF")).toEqual({
      kind: "convert",
      format: "pdf",
      mime: "application/pdf",
    })
    expect(fileType("d.svg")).toMatchObject({ kind: "convert", format: "svg" })
    expect(fileType("shot.jpeg")).toEqual({ kind: "image", mime: "image/jpeg" })
    expect(fileType("old.doc")).toEqual({
      kind: "unsupported",
      extension: "doc",
    })
    expect(fileType("src/index.ts")).toBeNull()
    expect(fileType("notes.md")).toBeNull()
  })
})

describe("convertFile", () => {
  it("gives the version of the CLI: the package version and the hash of its build", async () => {
    const version = await converterVersion()
    expect(version).toMatch(/^ctxpipe-convert \d+\.\d+\.\d+ [0-9a-f]{16}$/)
    expect(
      execFileSync(converterBinary(), ["--version"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(version)
  })

  it.each([
    "sample.docx",
    "sample.pptx",
    "sample.xlsx",
    "sample.pdf",
    "sample.html",
  ])("converts %s to Markdown", async (name) => {
    const result = await convert(name)
    expect(result.kind).toBe("text")
    expect(result).toMatchSnapshot()
  })

  it("leaves the script, the style and the navigation of HTML out", async () => {
    const result = await convert("sample.html")
    if (result.kind !== "text") throw new Error(result.kind)
    expect(result.text).toContain("# Deploy guide")
    expect(result.text).not.toMatch(/alert\(1\)|color:red|Home/)
  })

  it.each([
    ["encrypted.pdf", "encrypted"],
    ["image-only.pdf", "no-text-layer"],
    ["many-pages.pdf", "too-many-pages"],
    ["zip-bomb.docx", "too-large"],
    ["truncated.pdf", "malformed"],
    ["truncated.docx", "malformed"],
    ["random.pptx", "malformed"],
    ["billion-laughs.svg", "malformed"],
  ])("gives %s a typed failure (%s)", async (name, failure) => {
    expect(await convert(name)).toMatchObject({ kind: "failed", failure })
  })

  it("stops a shared-strings bomb at a limit", async () => {
    // The text would be about 200 MiB. Linux stops the process at its
    // address-space limit (`resource-limit`); macOS has no such limit, so
    // there the text limit stops it (`too-large`).
    const result = await convert("shared-strings-bomb.xlsx")
    expect(result.kind).toBe("failed")
    expect(["resource-limit", "too-large"]).toContain(
      result.kind === "failed" ? result.failure : null,
    )
  })

  it("does not expand the entities of a billion-laughs DOCX", async () => {
    const result = await convert("billion-laughs.docx")
    expect(result.kind).toBe("text")
    expect(result.kind === "text" && result.text.length).toBeLessThan(100)
  })

  it("refuses a file of more than 64 MiB", async () => {
    expect(
      await convertFile("pdf", Buffer.alloc(64 * 1024 * 1024 + 1)),
    ).toMatchObject({ kind: "failed", failure: "too-large" })
  })

  it("stops the converter at the wall-clock limit", async () => {
    expect(
      await convertFile("pdf", fixture("many-pages.pdf"), { timeoutMs: 1 }),
    ).toMatchObject({ kind: "failed", failure: "timeout" })
  })

  it("renders a draw.io SVG with its labels, without the draw.io notice", async () => {
    const result = await convert(
      "drawio-orders.svg",
      visionFixture("drawio-orders.svg"),
    )
    if (result.kind !== "image") throw new Error(result.kind)
    expect(result.labels.split("\n")).toEqual(
      expect.arrayContaining(["Orders Lambda", "Private subnet", "on failure"]),
    )
    expect(result.labels).not.toContain("Text is not SVG")
    expect(result.png.subarray(1, 4).toString()).toBe("PNG")
  })

  it("takes the HTML labels of a Mermaid SVG", async () => {
    const result = await convert(
      "mermaid-release.svg",
      visionFixture("mermaid-release.svg"),
    )
    if (result.kind !== "image") throw new Error(result.kind)
    expect(result.labels.split("\n")).toEqual(
      expect.arrayContaining(["Unit tests", "Build stage", "green"]),
    )
  })

  it("reads no external image of an SVG, and caps the size of its PNG", async () => {
    const external = await convert("external-image.svg")
    expect(external).toMatchObject({ kind: "image", labels: "Local only\n" })
    const huge = await convert("huge-canvas.svg")
    if (huge.kind !== "image") throw new Error(huge.kind)
    const size = pngSize(huge.png)
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048)
  })

  it("gives the same output for the same bytes", async () => {
    const twice = async (name: string, bytes?: Buffer) => {
      const first: Conversion = await convert(name, bytes)
      const second: Conversion = await convert(name, bytes)
      expect(second).toEqual(first)
    }
    for (const name of [
      "sample.docx",
      "sample.pptx",
      "sample.xlsx",
      "sample.pdf",
      "sample.html",
    ])
      await twice(name)
    await twice("drawio-orders.svg", visionFixture("drawio-orders.svg"))
    await twice("mermaid-release.svg", visionFixture("mermaid-release.svg"))
  })
})
