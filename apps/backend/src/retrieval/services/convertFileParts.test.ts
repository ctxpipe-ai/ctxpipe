import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { convertFileParts } from "./convertFileParts.js"

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(
        `../../knowledge-plane/fixtures/convert/${name}`,
        import.meta.url,
      ),
    ),
  )
const dataUrl = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString("base64")}`
const body = (part: unknown) => ({
  model: "test/model",
  messages: [
    { role: "system", content: "Answer briefly." },
    {
      role: "user",
      content: [{ type: "text", text: "Summarize the file." }, part],
    },
  ],
})

describe("convertFileParts", () => {
  it("replaces a PDF file part with the text of our converter", async () => {
    const result = await convertFileParts(
      body({
        type: "file",
        file: {
          filename: "sample.pdf",
          file_data: dataUrl("application/pdf", fixture("sample.pdf")),
        },
      }),
    )
    if (!result.ok) throw new Error(result.error)
    const [system, user] = result.body.messages
    expect(system).toEqual({ role: "system", content: "Answer briefly." })
    const content = (user as { content: Array<Record<string, unknown>> })
      .content
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: "text", text: "Summarize the file." })
    expect(content[1]?.type).toBe("text")
    const text = String(content[1]?.text)
    expect(text).toMatch(/^<file name="sample\.pdf">\n/)
    expect(text).toMatch(/\n<\/file>$/)
    // The text of the PDF itself, not its bytes.
    expect(text.length).toBeGreaterThan(40)
    expect(text).not.toContain("JVBER")
    expect(JSON.stringify(result.body)).not.toContain('"file"')
  })

  it("knows a PDF by its file name when the data URL has no PDF type", async () => {
    const result = await convertFileParts(
      body({
        type: "file",
        file: {
          filename: "Report.PDF",
          file_data: dataUrl("application/octet-stream", fixture("sample.pdf")),
        },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it("refuses a file part that is not a PDF", async () => {
    const result = await convertFileParts(
      body({
        type: "file",
        file: {
          filename: "sample.docx",
          file_data: dataUrl(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fixture("sample.docx"),
          ),
        },
      }),
    )
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('"sample.docx" is not a PDF'),
    })
  })

  it("refuses a PDF that the converter cannot convert", async () => {
    const result = await convertFileParts(
      body({
        type: "file",
        file: {
          filename: "truncated.pdf",
          file_data: dataUrl("application/pdf", fixture("truncated.pdf")),
        },
      }),
    )
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^The PDF "truncated\.pdf" cannot be converted to text \(malformed\)/,
      ),
    })
  })

  it.each([
    ["a file id", { type: "file", file: { file_id: "file-abc" } }],
    [
      "a URL",
      {
        type: "file",
        file: { filename: "a.pdf", file_data: "https://example.com/a.pdf" },
      },
    ],
    [
      "a Responses API file part",
      { type: "input_file", file_url: "https://example.com/a.pdf" },
    ],
  ])("refuses %s, which holds no file data", async (_name, part) => {
    const result = await convertFileParts(body(part))
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(
        "has no file_data of the form data:<media type>;base64,<data>",
      ),
    })
  })

  it("reads a data URL with parameters, and keeps the name from ending the wrapper", async () => {
    const result = await convertFileParts(
      body({
        type: "file",
        file: {
          filename: 'a"></file>\n.pdf',
          file_data: `data:application/pdf;name=a.pdf;base64,${fixture("sample.pdf").toString("base64")}`,
        },
      }),
    )
    if (!result.ok) throw new Error(result.error)
    const content = (
      result.body.messages[1] as { content: Array<{ text?: string }> }
    ).content
    const text = String(content[1]?.text)
    expect(text).toMatch(/^<file name="a___\/file__\.pdf">\n/)
    expect(text.match(/<\/file>/g)).toHaveLength(1)
  })

  it.each([
    { url: "data:application/pdf;base64,JVBERi0=" },
    "data:application/pdf;base64,JVBERi0=",
  ])(
    "refuses an image part with a data URL that is not an image",
    async (image_url) => {
      const result = await convertFileParts(
        body({ type: "image_url", image_url }),
      )
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining("not an image"),
      })
    },
  )

  it.each([
    { filename: null, file_data: "data:application/pdf;base64,JVBERi0=" },
    "data:application/pdf;base64,JVBERi0=",
  ])("refuses a malformed file part", async (file) => {
    const result = await convertFileParts(body({ type: "file", file }))
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("A file part is malformed"),
    })
  })

  it("keeps an image part and a body with no file part as they are", async () => {
    const image = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    }
    const input = body(image)
    expect(await convertFileParts(input)).toEqual({ ok: true, body: input })
    const plain = { messages: [{ role: "user", content: "hi" }] }
    expect(await convertFileParts(plain)).toEqual({ ok: true, body: plain })
  })
})
