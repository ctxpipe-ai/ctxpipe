// No file part of a chat request reaches a model provider (CTX-1454). When
// a model has no native PDF input, OpenRouter parses a PDF file part with a
// plugin at another service, and `provider.only` does not cover plugins
// (ADR-070). So the proxies replace each PDF file part with its text from
// our converter: the same CLI, sandbox and limits as the knowledge plane.
// The text then goes through the secret scrubber like any other text
// (ADR-071). Each other file part makes the request fail. Image parts stay:
// the provider allowlist covers them.
import { fileExtension } from "../../domain/workspaces/raw-file.js"
import { convertFile } from "../../knowledge-plane/convert-file.js"

/**
 * `body` (an OpenAI-compatible chat request) with each file part of its
 * messages (`type` `file` or `input_file`) replaced by a text part that
 * holds the text of the PDF. A file part that is not a PDF, that has no
 * base64 data URL, or that the converter cannot convert gives an error
 * that the caller sends back to the client.
 */
export async function convertFileParts<T>(
  body: T,
): Promise<{ ok: true; body: T } | { ok: false; error: string }> {
  const messages = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return { ok: true, body }
  const converted: unknown[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content
    if (!Array.isArray(content) || !content.some(isFilePart)) {
      converted.push(message)
      continue
    }
    const parts: unknown[] = []
    for (const part of content) {
      if (!isFilePart(part)) {
        parts.push(part)
        continue
      }
      const text = await pdfText(part)
      if ("error" in text) return { ok: false, error: text.error }
      parts.push({ type: "text", text: text.text })
    }
    converted.push({ ...(message as object), content: parts })
  }
  return { ok: true, body: { ...body, messages: converted } }
}

function isFilePart(part: unknown): part is Record<string, unknown> {
  const type = (part as { type?: unknown } | null)?.type
  return type === "file" || type === "input_file"
}

/** The text of a PDF file part, or why the request fails. */
async function pdfText(
  part: Record<string, unknown>,
): Promise<{ text: string } | { error: string }> {
  // The Chat Completions part holds its fields in `file`; the Responses
  // API part (`input_file`) holds them itself.
  const fields = (part.type === "file" ? part.file : part) as {
    filename?: unknown
    file_data?: unknown
  } | null
  const filename =
    typeof fields?.filename === "string" ? fields.filename : "file"
  const data =
    typeof fields?.file_data === "string"
      ? /^data:([^;,]*);base64,(.*)$/s.exec(fields.file_data)
      : null
  if (!data)
    return {
      error: `The file part "${filename}" has no base64 data URL in file_data. Send the file itself, not a file id or a URL.`,
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
