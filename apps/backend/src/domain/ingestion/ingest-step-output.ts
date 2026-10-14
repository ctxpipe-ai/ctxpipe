import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/*
 * The host side of a step output (ADR-052): the tar that root packed from
 * `/ctxpipe/out`. The agent controls what is in it, so this reader writes
 * only regular files, folders, and symlinks (as links, which the patch
 * validator rejects) into its own folder. It refuses an absolute path, a
 * `..` segment, a path under a symlink, hard links, and special files. The
 * staged tree cap of the validator is 2 MiB; the tar may be at most 4 MiB.
 */

const MAX_TAR_BYTES = 4 * 1024 * 1024
const BLOCK = 512

function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length)
  const end = bytes.indexOf(0)
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString(
    "utf8",
  )
}

function octal(header: Uint8Array, start: number, length: number): number {
  const bytes = header.subarray(start, start + length)
  // Base-256 (GNU) for large values: refuse; no step output is that large.
  if ((bytes[0] ?? 0) & 0x80) throw new Error("The step output is too large")
  const text = field(header, start, length).trim()
  return text ? Number.parseInt(text, 8) : 0
}

/** The `path` record of a pax header, if any. */
function paxPath(data: Uint8Array): string | undefined {
  const text = Buffer.from(data).toString("utf8")
  let at = 0
  let path: string | undefined
  while (at < text.length) {
    const space = text.indexOf(" ", at)
    if (space === -1) break
    const length = Number.parseInt(text.slice(at, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, at + length - 1)
    const eq = record.indexOf("=")
    if (record.slice(0, eq) === "path") path = record.slice(eq + 1)
    at += length
  }
  return path
}

function safePath(raw: string): string | null {
  if (raw.includes("\0") || raw.startsWith("/"))
    throw new Error(`The step output has a path outside its folder: ${raw}`)
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.includes(".."))
    throw new Error(`The step output has a path outside its folder: ${raw}`)
  return parts.length ? parts.join("/") : null
}

async function assertNoLinkOnPath(
  dir: string,
  path: string,
  links: ReadonlySet<string>,
): Promise<void> {
  const parts = path.split("/")
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/")
    const isLast = i === parts.length
    if (!isLast && links.has(prefix))
      throw new Error(`The step output has a path under a symlink: ${path}`)
    const stat = await lstat(join(dir, prefix)).catch(() => null)
    if (stat?.isSymbolicLink())
      throw new Error(`The step output has a path under a symlink: ${path}`)
  }
}

/** Unpack `tar` into a new folder, call `fn` with it, then delete it. */
export async function withIngestStepOutput<T>(
  tar: Uint8Array,
  fn: (stagedDir: string) => Promise<T>,
): Promise<T> {
  if (tar.length > MAX_TAR_BYTES)
    throw new Error("The step output is too large")
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-step-"))
  try {
    const links = new Set<string>()
    let longName: string | undefined
    let at = 0
    while (at + BLOCK <= tar.length) {
      const header = tar.subarray(at, at + BLOCK)
      if (header.every((b) => b === 0)) break
      const size = octal(header, 124, 12)
      const type = String.fromCharCode(header[156] ?? 0)
      const dataStart = at + BLOCK
      const data = tar.subarray(dataStart, dataStart + size)
      if (data.length < size) throw new Error("The step output is cut short")
      at = dataStart + Math.ceil(size / BLOCK) * BLOCK
      if (type === "L") {
        longName = field(data, 0, data.length)
        continue
      }
      if (type === "x") {
        longName = paxPath(data) ?? longName
        continue
      }
      if (type === "g" || type === "K") continue
      const prefix = field(header, 345, 155)
      const name = field(header, 0, 100)
      const raw = longName ?? (prefix ? `${prefix}/${name}` : name)
      longName = undefined
      const path = safePath(raw)
      if (path === null) continue
      await assertNoLinkOnPath(dir, path, links)
      const target = join(dir, path)
      if (type === "5") {
        await mkdir(target, { recursive: true })
      } else if (type === "0" || type === "\0" || type === "7") {
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, data)
      } else if (type === "2") {
        await mkdir(join(target, ".."), { recursive: true })
        await rm(target, { force: true })
        await symlink(field(header, 157, 100), target)
        links.add(path)
      } else {
        throw new Error(
          `The step output has an entry that is not a file, a folder, or a symlink: ${path}`,
        )
      }
    }
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
