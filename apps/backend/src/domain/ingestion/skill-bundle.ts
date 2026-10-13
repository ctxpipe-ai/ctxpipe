import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SandboxHandle } from "@tanstack/ai-sandbox"

/*
 * The ingest skill bundle (ADR-052): `apps/backend/ingest-skills/<skill>/`
 * with `SKILL.md`, `scripts/`, and `schema.json`, plus the stage helpers in
 * `bin/`. The backend image holds the folder. Prepare copies it to
 * `/ctxpipe/skills` in the ingest sandbox. The content hash names the bundle,
 * so a step commit can say which bundle wrote it.
 */

export const INGEST_SKILLS_DIR = fileURLToPath(
  new URL("../../../ingest-skills/", import.meta.url),
)

/** Sandbox paths. The ingest OpenCode config reads skills only from here. */
export const INGEST_ROOT = "/ctxpipe"
export const INGEST_SKILLS_ROOT = `${INGEST_ROOT}/skills`
export const INGEST_OUT_ROOT = `${INGEST_ROOT}/out`
export const INGEST_CONTEXT_ROOT = `${INGEST_ROOT}/context`

export type IngestSkillBundle = {
  /** `ingest-<16 hex>`: the first 64 bits of the content hash. */
  name: string
  /** Skill folder names: each folder with a `SKILL.md`. */
  skills: string[]
  files: Array<{ path: string; content: Buffer; executable: boolean }>
}

export async function readIngestSkillBundle(
  dir: string = INGEST_SKILLS_DIR,
): Promise<IngestSkillBundle> {
  const files: IngestSkillBundle["files"] = []
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(folder, entry.name)
      if (entry.isDirectory()) await walk(full, path)
      else if (entry.isFile())
        files.push({
          path,
          content: await readFile(full),
          executable: ((await stat(full)).mode & 0o111) !== 0,
        })
      else throw new Error(`Ingest skill bundle: ${path} is not a file`)
    }
  }
  await walk(dir, "")
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(
      `${file.path}\0${file.executable ? "755" : "644"}\0${file.content.length}\0`,
    )
    hash.update(file.content)
  }
  return {
    name: `ingest-${hash.digest("hex").slice(0, 16)}`,
    skills: files
      .filter((f) => /^[^/]+\/SKILL\.md$/.test(f.path))
      .map((f) => f.path.split("/")[0] as string),
    files,
  }
}

type BundleTarget = Pick<SandboxHandle, "fs" | "process">

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function run(handle: BundleTarget, command: string): Promise<string> {
  const result = await handle.process.exec(command)
  if (result.exitCode !== 0)
    throw new Error(
      `Ingest sandbox command failed (${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    )
  return result.stdout
}

/**
 * Copy the bundle to `/ctxpipe/skills`. A sandbox that already holds the same
 * bundle keeps it. The marker file is written last, so a copy that stopped
 * part way is made again.
 */
export async function installIngestSkillBundle(
  handle: BundleTarget,
  bundle: IngestSkillBundle,
): Promise<{ installed: boolean }> {
  const marker = `${INGEST_SKILLS_ROOT}/.bundle`
  const current = await run(handle, `cat ${quote(marker)} 2>/dev/null || true`)
  if (current.trim() === bundle.name) return { installed: false }
  const folders = new Set<string>([INGEST_SKILLS_ROOT])
  for (const file of bundle.files) {
    const parts = file.path.split("/").slice(0, -1)
    for (let i = 1; i <= parts.length; i++)
      folders.add(`${INGEST_SKILLS_ROOT}/${parts.slice(0, i).join("/")}`)
  }
  await run(
    handle,
    `rm -rf ${quote(INGEST_SKILLS_ROOT)} && mkdir -p ${[...folders].map(quote).join(" ")}`,
  )
  for (const file of bundle.files)
    await handle.fs.write(
      `${INGEST_SKILLS_ROOT}/${file.path}`,
      new Uint8Array(file.content),
    )
  const executables = bundle.files
    .filter((f) => f.executable)
    .map((f) => quote(`${INGEST_SKILLS_ROOT}/${f.path}`))
  if (executables.length > 0)
    await run(handle, `chmod 755 ${executables.join(" ")}`)
  await handle.fs.write(marker, `${bundle.name}\n`)
  return { installed: true }
}

/**
 * Start a step: make its output folder and point the stage helpers at it and
 * at the destination Workspace checkout. Returns the step folder.
 */
export async function startIngestStep(
  handle: BundleTarget,
  input: { step: string; workspaceId: string },
): Promise<string> {
  const slug = input.step.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)
  const suffix = createHash("sha256")
    .update(input.step)
    .digest("hex")
    .slice(0, 8)
  const stepDir = `${INGEST_OUT_ROOT}/${slug}-${suffix}`
  if (!/^[A-Za-z0-9_-]+$/.test(input.workspaceId))
    throw new Error("Ingest step: the Workspace id is not a plain id")
  await run(
    handle,
    `rm -rf ${quote(stepDir)} && mkdir -p ${quote(`${stepDir}/files`)}`,
  )
  await handle.fs.write(
    `${INGEST_OUT_ROOT}/step.json`,
    `${JSON.stringify({
      stepDir,
      contextDir: `${INGEST_CONTEXT_ROOT}/${input.workspaceId}`,
    })}\n`,
  )
  return stepDir
}
