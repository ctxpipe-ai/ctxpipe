// The secret scrubber of every model call (ADR-072). Each text that goes to
// a model (an embedding, an LLM tier, the OpenAI-compatible routes, Jev, the
// vision prompt, an eval judge) passes through `scrubForModel` first.
// Kingfisher finds the secrets with its own rules, and each found secret
// becomes `[REDACTED:<rule id>]`. No found secret goes to a provider for
// validation. The same input gives the same output.
//
// Kingfisher runs in the `--scrub` mode of the converter binary
// (`apps/backend/converter/src/scrub.rs`): one process for each backend
// process, which stays alive and answers one request line at a time, in
// order. The process loads the compiled rules at start. Its version is the
// converter version, which is part of the projection version (ADR-067).
//
// When the scrubber cannot run, the call fails: no text goes to a model
// unscrubbed.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"

import { z } from "zod"

import { converterBinary } from "../../knowledge-plane/convert-file.js"
import { parseJson } from "../../lib/parseJson.js"
import { log } from "../../observability/logger.js"

type Pending = {
  /** The id of the request line, which its answer repeats. */
  id: number
  resolve: (texts: string[]) => void
  reject: (error: Error) => void
}

type Scrubber = {
  child: ChildProcessWithoutNullStreams
  /** The requests in flight, in the order of their lines. */
  pending: Pending[]
  /** The timer that keeps the process alive while a request is in flight. */
  alive?: ReturnType<typeof setInterval>
}

let scrubber: Scrubber | undefined
let nextId = 0

const answerSchema = z.union([
  z.object({ id: z.number(), texts: z.array(z.string()) }),
  z.object({ id: z.number().nullable(), error: z.string() }),
])

function start(): Scrubber {
  const child = spawn(
    converterBinary(),
    [
      "--scrub",
      "--max-memory-mb",
      "1024",
      // The compiled rules: the first start compiles them (about 3 s), a
      // later start loads them (about 0.3 s).
      "--rule-cache",
      join(tmpdir(), "ctxpipe-scrub-rules"),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // No environment: the scrubber reads no setting, and it gets no key.
      env: {},
      // As the converter: when the backend runs as root, the scrubber runs as
      // `nobody`.
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
    },
  )
  const own: Scrubber = { child, pending: [] }
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000)
  })
  // The process stops only when it fails: while the backend process runs,
  // the scrubber stays alive. Each stop is an error event, which the alert
  // "Secret scrubber stopped" counts. The first stop gives the error of the
  // requests in flight.
  let stopped = false
  const stop = (error: Error) => {
    if (scrubber === own) scrubber = undefined
    if (!stopped)
      log.error({
        step: "secret-scrubber.stopped",
        message: error.message,
        inFlight: own.pending.length,
      })
    stopped = true
    for (const request of own.pending.splice(0)) request.reject(error)
    holdWhileInFlight(own)
  }
  onLines(child.stdout, (line) => {
    const answer = answerSchema.safeParse(parseJson(line))
    // An answer that is not the answer of the oldest request stops the
    // process, and each request in flight fails: an answer never goes to
    // another request (of another organization).
    if (!answer.success || answer.data.id !== own.pending[0]?.id) {
      stop(
        new Error(
          "The secret scrubber gave an answer that is not the answer of the oldest request, so it was stopped.",
        ),
      )
      child.kill("SIGKILL")
      return
    }
    const request = own.pending.shift()
    if (!request) return
    if ("error" in answer.data)
      request.reject(
        new Error(`The secret scrubber failed: ${answer.data.error}`),
      )
    else request.resolve(answer.data.texts)
    holdWhileInFlight(own)
  })
  child.on("error", stop)
  child.on("close", (code, signal) =>
    stop(
      new Error(
        `The secret scrubber stopped (${signal ?? `exit ${code}`}): ${stderr.trim()}`,
      ),
    ),
  )
  // A closed pipe also closes the process: `close` rejects the requests.
  child.stdin.on("error", () => {})
  for (const handle of [child, child.stdin, child.stdout, child.stderr])
    (handle as { unref?(): void }).unref?.()
  return own
}

/**
 * Calls `onLine` with each line of `stream`, without its end. A line ends at
 * "\n" only, as the lines of the scrubber do. (`node:readline` also ends a
 * line at "\r", U+2028 and U+2029. The scrubber writes U+2028 and U+2029 as
 * they are, inside a JSON string, so that cut an answer in two: CTX-1504.)
 */
function onLines(stream: Readable, onLine: (line: string) => void) {
  // The decoder of the stream keeps a character that two chunks split.
  stream.setEncoding("utf8")
  let parts: string[] = []
  stream.on("data", (chunk: string) => {
    let from = 0
    for (
      let end = chunk.indexOf("\n");
      end >= 0;
      end = chunk.indexOf("\n", from)
    ) {
      parts.push(chunk.slice(from, end))
      const line = parts.join("")
      parts = []
      from = end + 1
      onLine(line)
    }
    if (from < chunk.length) parts.push(chunk.slice(from))
  })
}

/**
 * An idle scrubber does not keep the backend process alive: its process and
 * pipes are unreferenced from the start. A request in flight does, with a
 * referenced timer: a script that only waits for the answer must not exit.
 * (Bun cannot reference a pipe again after `unref`.)
 */
function holdWhileInFlight(own: Scrubber) {
  if (own.pending.length === 0) {
    clearInterval(own.alive)
    own.alive = undefined
  } else own.alive ??= setInterval(() => {}, 60_000)
}

/** The scrubbed form of each text, in the same order. */
function scrubTexts(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return Promise.resolve([])
  const id = nextId++
  // Each text through UTF-8: a lone surrogate (from a caller) becomes
  // U+FFFD. Else it would make a line that the scrubber cannot read, and
  // that stops it for every request in flight.
  const line = `${JSON.stringify({
    id,
    texts: texts.map((text) => Buffer.from(text, "utf8").toString("utf8")),
  })}\n`
  // The largest line of the scrubber (`MAX_LINE_BYTES` in scrub.rs): a
  // larger line would stop it, and each request in flight of each
  // organization would fail. Only this request fails.
  if (Buffer.byteLength(line, "utf8") > 64 * 1024 * 1024)
    return Promise.reject(
      new Error("The text for the model is larger than 64 MiB."),
    )
  const own = (scrubber ??= start())
  return new Promise<string[]>((resolve, reject) => {
    own.pending.push({
      id,
      resolve: (scrubbed) =>
        scrubbed.length === texts.length
          ? resolve(scrubbed)
          : reject(new Error("The secret scrubber lost a text")),
      reject,
    })
    holdWhileInFlight(own)
    own.child.stdin.write(line)
  })
}

/**
 * True for an image data URL: a whole base64 data URL of a raster image type
 * that the product sends (PNG, JPEG, GIF, WebP). The media type is compared
 * in lower case, without its parameters. Each other data URL (an SVG, which
 * is text, or another type) is scrubbed.
 */
function isImageDataUrl(value: string): boolean {
  const match =
    /^data:([^,;]*)((?:;[^,;]*)*);base64,[A-Za-z0-9+/]*={0,2}$/i.exec(value)
  return (
    match !== null &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      (match[1] ?? "").trim().toLowerCase(),
    )
  )
}

/**
 * The place of a value in a model request body, from its root. Only the
 * image field of an image part of a message is an image place:
 * `messages[].content[].image_url` of a part with type `image_url` or
 * `input_image`, and its `url`. Only an image data URL in that place skips
 * the scrub (ADR-072; the trusted-provider rule of ADR-070 covers images).
 * The same data URL in any other place (a text, a schema, a key) is text.
 */
type Place =
  | "root"
  | "messages"
  | "message"
  | "content"
  | "part"
  | "image"
  | "text"

function placeInArray(place: Place): Place {
  if (place === "messages") return "message"
  if (place === "content") return "part"
  return "text"
}

function placeInObject(
  place: Place,
  object: Record<string, unknown>,
  key: string,
): Place {
  if (place === "root" && key === "messages") return "messages"
  if (place === "message" && key === "content") return "content"
  if (
    place === "part" &&
    key === "image_url" &&
    (object.type === "image_url" || object.type === "input_image")
  )
    return "image"
  if (place === "image" && key === "url") return "image"
  return "text"
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * `value` with each secret in each of its strings replaced by
 * `[REDACTED:<rule id>]`. The value is a string, or a JSON value (a model
 * request body, a list of messages): each string and each key of its plain
 * objects and arrays is scrubbed, at any depth. The base64 payload of an
 * image data URL in the image field of an image part of a message stays as
 * it is (`Place`); a message part that is not text or an image is refused
 * (`unreadableContentPart`). A secret split over two texts of a conversation fails
 * the call. Every model client calls this before it sends.
 */
export async function scrubForModel<T>(value: T): Promise<T> {
  const refused = unreadableContentPart(value)
  if (refused) throw new Error(refused)
  // An image data URL in an image place: only its base64 payload stays as
  // it is. Its header (the type and the parameters) is text.
  const textOf = (text: string, place: Place) =>
    place === "image" && isImageDataUrl(text)
      ? text.slice(0, text.indexOf(","))
      : text
  const texts: string[] = []
  mapStrings(value, "root", (text, place) => {
    texts.push(textOf(text, place))
    return text
  })
  const scrubbed = await scrubTexts(texts)
  // The same walk, in the same order, puts the scrubbed strings back.
  let next = 0
  const result = mapStrings(value, "root", (text, place) => {
    const own = scrubbed[next++] ?? ""
    const header = textOf(text, place)
    return header === text ? own : own + text.slice(header.length)
  }) as T
  // The model reads the texts of a conversation as one text, so a secret
  // split over two of them (two text parts, two messages) is a secret. Each
  // text is scrubbed, so a secret in their joined text crosses a boundary:
  // the call fails (fail closed).
  const runs = conversationRuns(result)
    .filter((run) => run.length > 1)
    .map((run) => run.join(""))
  const found = await scrubTexts(runs)
  if (runs.some((run, at) => found[at] !== run))
    throw new Error(
      "A secret is split over two texts of the model request; the call is refused.",
    )
  return result
}

/**
 * Why the request cannot go to a model, or null. The scrubber reads text,
 * so each content part of a message must be text: a text part, a refusal,
 * or a raster image part. Another part (a file, audio) holds bytes in which
 * the scrubber finds no secret, and the model reads them (ADR-072).
 */
export function unreadableContentPart(value: unknown): string | null {
  if (!isPlainObject(value) || !Array.isArray(value.messages)) return null
  for (const message of value.messages) {
    if (!isPlainObject(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const type = isPlainObject(part) ? part.type : undefined
      if (
        typeof type !== "string" ||
        !["text", "refusal", "image_url", "input_image"].includes(type)
      )
        return `A message part of type ${JSON.stringify(type ?? null)} cannot go to a model: only text and image parts can be scrubbed.`
    }
  }
  return null
}

/**
 * The runs of texts that a model can read as one text, each in order: the
 * whole conversation (the system prompts, then the content of each
 * message), the system texts alone, and the other messages alone (Converse
 * takes the system texts out, then joins the messages of one role). The
 * content of a message is a string, or the text of each text part. The
 * roots are those of the model clients: a request body (`messages`), or the
 * host call (`systemPrompts` and `messages`).
 */
function conversationRuns(value: unknown): string[][] {
  if (!isPlainObject(value)) return []
  const system: string[] = []
  const other: string[] = []
  const all: string[] = []
  const textsOf = (message: unknown): string[] => {
    if (typeof message === "string") return [message]
    if (!isPlainObject(message)) return []
    if (typeof message.content === "string") return [message.content]
    if (!Array.isArray(message.content)) return []
    return message.content.flatMap((part) =>
      isPlainObject(part) && typeof part.text === "string"
        ? [part.text]
        : isPlainObject(part) && typeof part.content === "string"
          ? [part.content]
          : [],
    )
  }
  const prompts = Array.isArray(value.systemPrompts) ? value.systemPrompts : []
  for (const prompt of prompts) {
    system.push(...textsOf(prompt))
    all.push(...textsOf(prompt))
  }
  const messages = Array.isArray(value.messages) ? value.messages : []
  for (const message of messages) {
    const texts = textsOf(message)
    if (isPlainObject(message) && message.role === "system")
      system.push(...texts)
    else other.push(...texts)
    all.push(...texts)
  }
  return [all, system, other]
}

/**
 * `node` with `map` applied to each string and each key of its plain
 * objects and arrays, in a fixed order: each key, then its value. A number,
 * a boolean, null, undefined and bytes (Bedrock image bytes) stay as they
 * are. Each other object (a class instance, a Map) is refused: its text
 * would go to the model unscrubbed.
 */
function mapStrings(
  node: unknown,
  place: Place,
  map: (text: string, place: Place) => string,
): unknown {
  if (typeof node === "string") return map(node, place)
  if (Array.isArray(node))
    return node.map((child) => mapStrings(child, placeInArray(place), map))
  if (isPlainObject(node))
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [
        map(key, "text"),
        mapStrings(child, placeInObject(place, node, key), map),
      ]),
    )
  if (
    typeof node === "object" &&
    node !== null &&
    !(node instanceof Uint8Array)
  )
    throw new Error("A value of a model request is not plain data.")
  return node
}
