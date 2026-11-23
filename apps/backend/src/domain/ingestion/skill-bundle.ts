import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { parse as parseYaml } from "yaml"

/*
 * The ingest skill bundle (ADR-052): `apps/backend/ingest-skills/<skill>/`
 * with `SKILL.md`, `scripts/`, and `schema.json`, plus the stage helpers in
 * `bin/`. The backend image holds the folder. Prepare copies it to
 * `/ctxpipe/skills` in the ingest sandbox. The content hash names the bundle,
 * so a step commit can say which bundle wrote it.
 *
 * `versions/` in the folder holds the version markers. It is not part of the
 * bundle. A change that can change the knowledge that ingestion writes adds
 * one marker, `versions/<name>.md`. The re-ingestion version comes from the
 * marker names (see `versions/README.md`), so a speed, format, lint, or
 * comment change starts no paid re-ingestion. A new marker is a new file, so
 * two skill changes do not edit the same line.
 */

const VERSIONS_DIR = "versions"

export const INGEST_SKILLS_DIR = fileURLToPath(
  new URL("../../../ingest-skills/", import.meta.url),
)

/**
 * Sandbox paths (ADR-052). Root owns each of them except `out` and `home`,
 * which belong to the agent user and are emptied before each step.
 */
export const INGEST_ROOT = "/ctxpipe"
export const INGEST_SKILLS_ROOT = `${INGEST_ROOT}/skills`
export const INGEST_OPENCODE_ROOT = `${INGEST_ROOT}/opencode`
export const INGEST_CONTEXT_ROOT = `${INGEST_ROOT}/context`
export const INGEST_SOURCE_ROOT = `${INGEST_ROOT}/source`
export const INGEST_STEP_FILE = `${INGEST_ROOT}/step.json`
export const INGEST_OUT_ROOT = `${INGEST_ROOT}/out`
export const INGEST_HOME = `${INGEST_ROOT}/home`

export type IngestSkillBundle = {
  /** `ingest-<16 hex>`: the first 64 bits of the content hash. */
  name: string
  /**
   * The re-ingestion version, from the marker names in `versions/`. A person
   * adds a marker only when a change can change the knowledge that ingestion
   * writes.
   */
  version: string
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
      if (path === VERSIONS_DIR) continue
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
  const skills: string[] = []
  for (const file of files) {
    const match = /^([^/]+)\/SKILL\.md$/.exec(file.path)
    if (!match?.[1]) continue
    // OpenCode finds a skill by its front matter name; the folder must match.
    const front = /^---\n([\s\S]*?)\n---/.exec(file.content.toString("utf8"))
    const name = front?.[1] ? parseYaml(front[1])?.name : undefined
    if (name !== match[1])
      throw new Error(
        `Ingest skill bundle: the folder ${match[1]} has the SKILL.md name ${String(name)}`,
      )
    skills.push(name)
  }
  return {
    name: `ingest-${hash.digest("hex").slice(0, 16)}`,
    version: await readIngestVersion(join(dir, VERSIONS_DIR)),
    skills,
    files,
  }
}

/**
 * The re-ingestion version from the markers `<name>.md` in `versions/`. One
 * marker gives its name: the seed marker keeps the version of the time before
 * markers. More markers give `ingest-<16 hex>` from the sorted names, so the
 * merge of two changes gives the same version in each order.
 */
async function readIngestVersion(dir: string): Promise<string> {
  const names: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // A dot file (an editor or Finder file) is not a marker.
    if (entry.name === "README.md" || entry.name.startsWith(".")) continue
    const match = /^([a-z0-9][a-z0-9-]*)\.md$/.exec(entry.name)
    if (!entry.isFile() || !match?.[1])
      throw new Error(
        `Ingest skill bundle: ${VERSIONS_DIR}/${entry.name} is not a version marker <name>.md`,
      )
    names.push(match[1])
  }
  names.sort()
  if (names.length === 1 && names[0]) return names[0]
  if (!names.length)
    throw new Error(`Ingest skill bundle: ${VERSIONS_DIR}/ has no marker`)
  const hash = createHash("sha256").update(names.join("\n")).digest("hex")
  return `ingest-${hash.slice(0, 16)}`
}
