// No file part of a chat request reaches a model provider (CTX-1454). When
// a model has no native PDF input, OpenRouter parses a PDF file part with a
// plugin at another service, and `provider.only` does not cover plugins
// (ADR-070). So the proxies replace each PDF file part with its text from
// our converter: the same CLI, sandbox and limits as the knowledge plane.
// The text then goes through the secret scrubber like any other text
// (ADR-071). Each other file part makes the request fail. Image parts stay:
// the provider allowlist covers them.
import { z } from "zod"

import { fileExtension } from "../../domain/workspaces/raw-file.js"
import { convertFile } from "../../knowledge-plane/convert-file.js"

const chatRequestSchema = z
  .object({
    messages: z.array(
      z.union([
        z
          .object({ content: z.array(z.unknown()) })
          .passthrough()
          .transform((message) => ({ kind: "parts" as const, message })),
        z
          .unknown()
          .transform((message) => ({ kind: "other" as const, message })),
      ]),
    ),
  })
  .passthrough()

const filePartSchema = z.object({
  // `input_file` is the file part of the Responses API. The proxies serve
  // only Chat Completions, so it is refused, not converted.
  type: z.enum(["file", "input_file"]),
  file: z
    .object({
      filename: z.string().optional(),
      file_data: z.string().optional(),
    })
    .optional(),
})

function isFilePart(part: unknown): boolean {
  const type = (part as { type?: unknown } | null)?.type
  return type === "file" || type === "input_file"
}

/** An image part with a data URL that is not an image (for example a PDF). */
const notImageSchema = z.object({
  type: z.enum(["image_url", "input_image"]),
  image_url: z.union([
    z.string().regex(/^\s*data:(?!image\/)/i),
    z.object({ url: z.string().regex(/^\s*data:(?!image\/)/i) }),
  ]),
})

/**
 * `body` (an OpenAI-compatible chat request) with each PDF file part of its
 * messages replaced by a text part that holds the text of the PDF. Each
 * other file part (another file type, a file id, a URL, a PDF that the
 * converter cannot convert), and an image part with a data URL that is not
 * an image, gives an error that the caller sends back to the client.
 */
export async function convertFileParts<T>(
  body: T,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  const request = chatRequestSchema.safeParse(body)
  if (!request.success) return { ok: true, body }
  const messages: unknown[] = []
  for (const { kind, message } of request.data.messages) {
    if (kind === "other") {
      messages.push(message)
      continue
    }
    const content: unknown[] = []
    for (const part of message.content) {
      if (notImageSchema.safeParse(part).success)
        return {
          ok: false,
          error:
            "An image part holds a data URL that is not an image. Send a PDF as a file part.",
        }
      if (!isFilePart(part)) {
        content.push(part)
        continue
      }
      // The type alone makes a file part: a malformed one is refused.
      const file = filePartSchema.safeParse(part)
      if (!file.success)
        return {
          ok: false,
          error:
            'A file part is malformed. Send { type: "file", file: { filename, file_data } }.',
        }
      const text = await pdfText(file.data)
      if ("error" in text) return { ok: false, error: text.error }
      content.push({ type: "text", text: text.text })
    }
    messages.push({ ...message, content })
  }
  return { ok: true, body: { ...body, messages } }
}

/** The text of a PDF file part, or why the request fails. */
async function pdfText(
  part: z.infer<typeof filePartSchema>,
): Promise<{ text: string } | { error: string }> {
  // The name goes into the wrapper of the text: it must not end it.
  const filename = (part.file?.filename ?? "file").replace(/["<>\r\n]/g, "_")
  // A data URL can have parameters before `;base64` (RFC 2397).
  const data =
    part.type === "file"
      ? /^data:([^;,]*)(?:;[^;,]*)*;base64,(.*)$/s.exec(
          part.file?.file_data ?? "",
        )
      : null
  if (!data)
    return {
      error: `The file part "${filename}" has no file_data of the form data:<media type>;base64,<data>. Send the file itself in a Chat Completions file part, not a file id or a URL.`,
    }
  if (data[1] !== "application/pdf" && fileExtension(filename) !== "pdf")
    return {
      error: `The file "${filename}" is not a PDF. The model proxy accepts only PDF file parts, and it converts them to text. Send other files as text.`,
    }
  const conversion = await convertFile(
    "pdf",
    Buffer.from(data[2] ?? "", "base64"),
  )
  if (conversion.kind !== "text")
    return {
      error:
        conversion.kind === "failed"
          ? `The PDF "${filename}" cannot be converted to text (${conversion.failure}): ${conversion.message}`
          : `The PDF "${filename}" cannot be converted to text.`,
    }
  const missing =
    conversion.imageOnlyPages.length > 0
      ? `\n(Pages ${conversion.imageOnlyPages.join(", ")} have no text layer: their text is missing.)`
      : ""
  return {
    text: `<file name="${filename}">\n${conversion.text}${missing}\n</file>`,
  }
}
