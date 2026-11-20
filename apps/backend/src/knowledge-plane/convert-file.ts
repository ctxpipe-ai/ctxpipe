// Files become text at projection time (ADR-066 decision 6, CTX-1433). The
// writer reads a file of the Workspace Git at the tip and converts it in
// memory. No derived text goes into Git. The converter is the Rust CLI of
// `apps/backend/converter` (`ctxpipe-convert`): fast, battle-tested parsers
// for the top file types only. The same bytes give the same text.
//
// The input is untrusted, so the CLI runs in its own process: with its own
// address-space and CPU limits (set before it reads the input), a seccomp
// allowlist on Linux (after the input is read, only memory, threads, time
// and stdin and stdout; no file, socket, program or process), no
// environment, as the unprivileged user `nobody` when the worker is root, a
// wall-clock limit, and caps on the input and the output.
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { z } from "zod"

import {
  fileExtension,
  rasterImageType,
} from "../domain/workspaces/raw-file.js"
import { parseJson } from "../lib/parseJson.js"

let version: Promise<string> | undefined

/**
 * The version of the converter (`ctxpipe-convert --version`): its package
 * version and a hash of its locked dependencies, its source and its font.
 * It is part of the projection version (ADR-067), so a new parser starts a
 * full rebuild. The process asks the CLI once.
 */
export function converterVersion(): Promise<string> {
  version ??= promisify(execFile)(converterBinary(), ["--version"], {
    env: {},
  }).then(({ stdout }) => stdout.trim())
  return version
}

/** The formats of the converter, by file extension, with their media type. */
const FORMATS: Record<string, { format: ConverterFormat; mime: string }> = {
  pdf: { format: "pdf", mime: "application/pdf" },
  docx: {
    format: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  pptx: {
    format: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  xlsx: {
    format: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  html: { format: "html", mime: "text/html" },
  htm: { format: "html", mime: "text/html" },
  svg: { format: "svg", mime: "image/svg+xml" },
}
type ConverterFormat = "pdf" | "docx" | "pptx" | "xlsx" | "html" | "svg"

/**
 * The document and image types that a Workspace can hold but that have no
 * converter: "Good support speed for the top file types is more important
 * than exotic file types" (the CTO, 2026-11-20). A file of such a type gets
 * a `failed` document that says so. Other files (code, configuration) are
 * not documents and get no row.
 */
const UNCONVERTED = new Set([
  "doc",
  "ppt",
  "xls",
  "odt",
  "odp",
  "ods",
  "rtf",
  "epub",
  "key",
  "pages",
  "numbers",
  "tif",
  "tiff",
  "bmp",
  "heic",
  "ico",
])

/** What the projection does with a file that is not a knowledge file. */
export type FileType =
  /** The converter gives its text (an SVG: a PNG and its labels). */
  | { kind: "convert"; format: ConverterFormat; mime: string }
  /** The vision model reads it as it is. */
  | { kind: "image"; mime: string }
  /** A document or an image type with no converter: a `failed` document. */
  | { kind: "unsupported"; extension: string }

/** The type of a path, or null for a file that is not a document. */
export function fileType(path: string): FileType | null {
  const extension = fileExtension(path)
  const converted = FORMATS[extension]
  if (converted) return { kind: "convert", ...converted }
  // The vision model reads a raster image as it is.
  const image = rasterImageType(path)
  if (image) return { kind: "image", mime: image }
  if (UNCONVERTED.has(extension)) return { kind: "unsupported", extension }
  return null
}

/** Why a file gives no text. The writer records it on a `failed` document. */
export type ConversionFailure =
  /** A file of more than 64 MiB, or a text of more than 16 MiB. */
  | "too-large"
  /** A PDF of more than 2,000 pages. */
  | "too-many-pages"
  | "encrypted"
  /** A PDF with no text layer (scanned or image-only). */
  | "no-text-layer"
  /** The parser cannot read the file. */
  | "malformed"
  /** The converter used all its memory or CPU time. */
  | "resource-limit"
  /** The converter did not finish within the wall-clock limit. */
  | "timeout"

/** The result of one conversion. */
export type Conversion =
  | {
      kind: "text"
      /** Markdown. */
      text: string
      /** The 1-based PDF pages with no text layer; their text is missing. */
      imageOnlyPages: number[]
    }
  | {
      /** An SVG: a PNG for the vision model, and the text of its labels. */
      kind: "image"
      png: Buffer
      labels: string
    }
  | { kind: "failed"; failure: ConversionFailure; message: string }

/** The text (16 MiB) or the PNG of an SVG (at most 2048 × 2048), as JSON. */
const MAX_OUTPUT_BYTES = 48 * 1024 * 1024

const outputSchema = z.union([
  z.object({
    ok: z.literal(true),
    text: z.string(),
    imageOnlyPages: z.array(z.number()).optional(),
    png: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    // Any other failure of the CLI (`usage`, `io`, `sandbox`) is a file that
    // the converter cannot read.
    failure: z
      .enum([
        "too-large",
        "too-many-pages",
        "encrypted",
        "no-text-layer",
        "malformed",
      ])
      .catch("malformed"),
    message: z.string(),
  }),
])

/**
 * The CLI: the build of this checkout when it exists (local development and
 * tests), else the copy of the worker image (`Dockerfile.worker`). The path
 * is absolute, because the process gets no PATH.
 */
export function converterBinary(): string {
  const local = fileURLToPath(
    new URL("../../converter/target/release/ctxpipe-convert", import.meta.url),
  )
  return existsSync(local) ? local : "/usr/local/bin/ctxpipe-convert"
}

/**
 * Convert one file of format `format` to text. A file that the converter
 * cannot read gives a `failed` result, not an error: the writer records it
 * on a `failed` document (ADR-067 decision 8). An error is thrown only when
 * the converter cannot start.
 */
export async function convertFile(
  format: ConverterFormat,
  bytes: Buffer,
  limits: { timeoutMs?: number } = {},
): Promise<Conversion> {
  const timeoutMs = limits.timeoutMs ?? 60_000
  const child = spawn(
    converterBinary(),
    [
      "--format",
      format,
      "--max-memory-mb",
      "512",
      "--max-cpu-seconds",
      String(Math.ceil(timeoutMs / 1000)),
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      // No environment: the converter reads no setting, and it gets no key.
      env: {},
      // The worker runs as root: the converter runs as `nobody`, so it
      // cannot read the files or the environment of the worker.
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
    },
  )
  const chunks: Buffer[] = []
  let size = 0
  let stop: "timeout" | "too-large" | null = null
  const timer = setTimeout(() => {
    stop = "timeout"
    child.kill("SIGKILL")
  }, timeoutMs)
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_OUTPUT_BYTES) {
      stop = "too-large"
      child.kill("SIGKILL")
    } else chunks.push(chunk)
  })
  // The converter can stop before it reads all the input.
  child.stdin.on("error", () => {})
  child.stdin.end(bytes)
  const exit = await new Promise<{ code: number | null }>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve({ code }))
  }).finally(() => clearTimeout(timer))
  if (stop === "timeout")
    return {
      kind: "failed",
      failure: "timeout",
      message: `The converter did not finish within ${timeoutMs} ms.`,
    }
  if (stop === "too-large")
    return {
      kind: "failed",
      failure: "too-large",
      message: "The output of the converter is larger than 48 MiB.",
    }
  const output = outputSchema.safeParse(
    exit.code === 0 ? parseJson(Buffer.concat(chunks).toString("utf8")) : null,
  )
  // A process that a limit stopped (an allocation failure aborts it, and
  // the CPU limit sends SIGXCPU) writes no result.
  if (!output.success)
    return {
      kind: "failed",
      failure: "resource-limit",
      message: "The converter stopped at its memory or CPU limit.",
    }
  const result = output.data
  if (!result.ok)
    return { kind: "failed", failure: result.failure, message: result.message }
  if (result.png !== undefined)
    return {
      kind: "image",
      png: Buffer.from(result.png, "base64"),
      labels: result.text,
    }
  return {
    kind: "text",
    text: result.text,
    imageOnlyPages: result.imageOnlyPages ?? [],
  }
}
