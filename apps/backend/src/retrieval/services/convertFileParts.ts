// No file part of a chat request reaches a model provider (CTX-1454). When
// a model has no native PDF input, OpenRouter parses a PDF file part with a
// plugin at another service, and `provider.only` does not cover plugins
// (ADR-070). So the proxies replace each PDF file part with its text from
// our converter: the same CLI, sandbox and limits as the knowledge plane.
// The text then goes through the secret scrubber like any other text
// (ADR-072). Each other file part makes the request fail. Image parts stay:
// the provider allowlist covers them.
import { z } from "zod"

import { fileExtension } from "../../domain/workspaces/raw-file.js"
import { convertFile } from "../../knowledge-plane/convert-file.js"
import { getLogger } from "../../observability/logger.js"

const filePartSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    filename: z.string().optional(),
    file_data: z.string().optional(),
  }),
})

/** A data URL that is not an image (for example a PDF). */
const notImage = z.string().regex(/^\s*data:(?!image\/)/i)
const notImagePartSchema = z.object({
  type: z.enum(["image_url", "input_image"]),
  image_url: z.union([notImage, z.object({ url: notImage })]),
})

type Refusal = { ok: false; status: 400 | 429 | 503; error: string }

/**
 * A count of the conversions that run at the same time. A caller that gets
 * no slot does not wait: the request fails with a 429, so many PDFs at once
 * cannot start a converter (up to 512 MiB each) for each of them.
 */
export class ConversionSlots {
  private active = 0

  constructor(private readonly size: number) {}

  /** A function that frees the slot, or null when each slot is taken. */
  take(): (() => void) | null {
    if (this.active >= this.size) return null
    this.active += 1
    let freed = false
    return () => {
      if (freed) return
      freed = true
      this.active -= 1
    }
  }
}

/** The conversions of the two proxies in this process. */
const proxySlots = new ConversionSlots(4)

/**
 * `body` (an OpenAI-compatible chat request) with each PDF file part of its
 * messages replaced by a text part that holds the text of the PDF. Each
 * other file part (another file type, a file id, a URL, a malformed part, a
 * PDF that the converter cannot convert), and an image part with a data URL
 * that is not an image, gives a 400 that the caller sends back to the
 * client. A converter that cannot start gives a 503, and a conversion with
 * no free slot gives a 429.
 */
export async function convertFileParts<T>(
  body: T,
  slots: ConversionSlots = proxySlots,
): Promise<{ ok: true; body: T } | Refusal> {
  const messages = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return { ok: true, body }
  const converted: unknown[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content
    if (!Array.isArray(content)) {
      converted.push(message)
      continue
    }
    const parts: unknown[] = []
    for (const part of content) {
      const type = (part as { type?: unknown } | null)?.type
      if (notImagePartSchema.safeParse(part).success)
        return refuse(
          "An image part holds a data URL that is not an image. Send a PDF as a file part.",
        )
      // The file part of the Responses API: the proxies serve only Chat
      // Completions.
      if (type === "input_file")
        return refuse(
          "An input_file part is not accepted. Send a Chat Completions file part.",
        )
      if (type !== "file") {
        parts.push(part)
        continue
      }
      // The type alone makes a file part: a malformed one is refused.
      const file = filePartSchema.safeParse(part)
      if (!file.success)
        return refuse(
          'A file part is malformed. Send { type: "file", file: { filename, file_data } }.',
        )
      const text = await pdfText(file.data.file, slots)
      if (!("text" in text)) return text
      parts.push({ type: "text", text: text.text })
    }
    converted.push({ ...(message as object), content: parts })
  }
  return { ok: true, body: { ...body, messages: converted } }
}

function refuse(error: string): Refusal {
  return { ok: false, status: 400, error }
}

/** The text of the file of a PDF file part, or why the request fails. */
async function pdfText(
  file: z.infer<typeof filePartSchema>["file"],
  slots: ConversionSlots,
): Promise<{ text: string } | Refusal> {
  // The name goes into the wrapper of the text: it must not end it.
  const filename = (file.filename ?? "file").replace(/["<>\r\n]/g, "_")
  // A data URL can have parameters before `;base64` (RFC 2397).
  const data = /^data:([^;,]*)(?:;[^;,]*)*;base64,(.*)$/is.exec(
    file.file_data ?? "",
  )
  if (!data)
    return refuse(
      `The file part "${filename}" has no file_data of the form data:<media type>;base64,<data>. Send the file itself, not a file id or a URL.`,
    )
  if (
    data[1]?.toLowerCase() !== "application/pdf" &&
    fileExtension(filename) !== "pdf"
  )
    return refuse(
      `The file "${filename}" is not a PDF. The model proxy accepts only PDF file parts, and it converts them to text. Send other files as text.`,
    )
  // The converter takes at most 64 MiB: a larger file is refused before
  // its base64 text is decoded into a second copy.
  if ((data[2]?.length ?? 0) > Math.ceil((64 * 1024 * 1024) / 3) * 4)
    return refuse(
      `The PDF "${filename}" is larger than 64 MiB, the limit of the converter.`,
    )
  const free = slots.take()
  if (!free)
    return {
      ok: false,
      status: 429,
      error: "The server converts too many files now. Try again later.",
    }
  let conversion: Awaited<ReturnType<typeof convertFile>>
  try {
    conversion = await convertFile("pdf", Buffer.from(data[2] ?? "", "base64"))
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      { step: "model-proxy.convert-file" },
    )
    return {
      ok: false,
      status: 503,
      error: "The file converter of the server cannot start.",
    }
  } finally {
    free()
  }
  if (conversion.kind !== "text")
    return refuse(
      conversion.kind === "failed"
        ? `The PDF "${filename}" cannot be converted to text (${conversion.failure}): ${conversion.message}`
        : `The PDF "${filename}" cannot be converted to text.`,
    )
  const missing =
    conversion.imageOnlyPages.length > 0
      ? `\n(Pages ${conversion.imageOnlyPages.join(", ")} have no text layer: their text is missing.)`
      : ""
  return {
    text: `<file name="${filename}">\n${conversion.text}${missing}\n</file>`,
  }
}
