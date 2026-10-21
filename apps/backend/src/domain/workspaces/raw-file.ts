/**
 * Raw file bytes for the Files pane: image preview and download.
 *
 * The response comes from the app origin and holds bytes from a customer
 * repository. The headers make sure that a browser never runs it as a page:
 * only raster images show inline, every other type downloads, and the CSP
 * sandbox stops scripts if a person opens the URL directly.
 */

/** The largest file that the raw endpoints send. */
export const RAW_FILE_MAX_BYTES = 10 * 1024 * 1024

/** Raster images that the Files pane shows inline. Never HTML or SVG. */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  // An <img> needs this type to show an SVG. The response still downloads.
  svg: "image/svg+xml",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wasm: "application/wasm",
}

function rawFileContentType(path: string): string {
  const name = path.split("/").at(-1) ?? ""
  const dot = name.lastIndexOf(".")
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
  return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

function contentDisposition(kind: "inline" | "attachment", path: string) {
  const name = path.split("/").at(-1) || "file"
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function rawFileHeaders(path: string, size: number) {
  const contentType = rawFileContentType(path)
  return {
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Content-Disposition": contentDisposition(
      INLINE_IMAGE_TYPES.has(contentType) ? "inline" : "attachment",
      path,
    ),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, no-store",
  }
}

export function rawFileTooLargeMessage(size: number): string {
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
  return `This file is ${mb(size)} MB. The Files pane sends files up to ${mb(RAW_FILE_MAX_BYTES)} MB. Clone the repository to get this file.`
}
