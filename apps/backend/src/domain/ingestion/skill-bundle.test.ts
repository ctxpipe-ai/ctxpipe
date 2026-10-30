import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { reingestUpgradeKey } from "../upgrades/keys.js"
import {
  assertSameReingestVersion,
  INGEST_SKILLS_DIR,
  readIngestSkillBundle,
} from "./skill-bundle.js"

const copies: string[] = []

function copyBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "ingest-skills-"))
  copies.push(dir)
  cpSync(INGEST_SKILLS_DIR, dir, { recursive: true })
  return dir
}

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true })
})

describe("readIngestSkillBundle", () => {
  it("packs each skill folder and the stage helpers", async () => {
    const bundle = await readIngestSkillBundle()
    expect(bundle.skills).toContain("discover-roots")
    const paths = bundle.files.map((f) => f.path)
    expect(paths).toEqual([...paths].sort())
    expect(paths).toEqual(
      expect.arrayContaining([
        "discover-roots/SKILL.md",
        "discover-roots/schema.json",
        "discover-roots/scripts/discover-roots.mjs",
        "bin/ctxpipe-stage",
        "bin/ctxpipe-delete",
        "bin/ctxpipe-finish",
      ]),
    )
    const stage = bundle.files.find((f) => f.path === "bin/ctxpipe-stage")
    expect(stage?.executable).toBe(true)
    expect(bundle.name).toMatch(/^ingest-[0-9a-f]{16}$/)
  })

  it("keeps the name when nothing changes", async () => {
    const a = await readIngestSkillBundle(copyBundle())
    const b = await readIngestSkillBundle(copyBundle())
    expect(a.name).toBe(b.name)
    expect(a.name).toBe((await readIngestSkillBundle()).name)
  })

  it("changes the name when one script changes", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    writeFileSync(
      join(dir, "discover-roots/scripts/discover-roots.mjs"),
      "#!/usr/bin/env node\nprocess.stdout.write('{\"roots\":[]}')\n",
    )
    expect((await readIngestSkillBundle(dir)).name).not.toBe(before.name)
  })

  it("changes the name when a file becomes executable", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    chmodSync(join(dir, "discover-roots/schema.json"), 0o755)
    expect((await readIngestSkillBundle(dir)).name).not.toBe(before.name)
  })

  it("fails when a skill folder name differs from its SKILL.md name", async () => {
    const dir = copyBundle()
    cpSync(join(dir, "discover-roots"), join(dir, "find-roots"), {
      recursive: true,
    })
    await expect(readIngestSkillBundle(dir)).rejects.toThrow(
      /find-roots.*discover-roots/,
    )
  })

  it("fails when a SKILL.md has no name", async () => {
    const dir = copyBundle()
    writeFileSync(join(dir, "discover-roots/SKILL.md"), "# No front matter\n")
    await expect(readIngestSkillBundle(dir)).rejects.toThrow(/name/)
  })

  it("changes the name when a file is added", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    writeFileSync(join(dir, "discover-roots/notes.md"), "More notes\n")
    expect((await readIngestSkillBundle(dir)).name).not.toBe(before.name)
  })

  it("keeps the re-ingestion version when only the format changes", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    appendFileSync(join(dir, "discover-roots/SKILL.md"), "\n")
    const after = await readIngestSkillBundle(dir)
    expect(after.name).not.toBe(before.name)
    expect(reingestUpgradeKey(after.version)).toBe(
      reingestUpgradeKey(before.version),
    )
    expect(() =>
      assertSameReingestVersion(
        { bundle: before.name, version: before.version },
        after,
      ),
    ).not.toThrow()
  })

  it("gives a new re-ingestion key when the version changes", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    writeFileSync(
      join(dir, "version.json"),
      JSON.stringify({ version: "ingest-1111111111111111", hash: before.name }),
    )
    const after = await readIngestSkillBundle(dir)
    expect(reingestUpgradeKey(after.version)).toBe(
      "reingest-ingest-1111111111111111",
    )
    expect(() =>
      assertSameReingestVersion(
        { bundle: before.name, version: before.version },
        after,
      ),
    ).toThrow(/changed during the run/)
  })

  it("compares the content hash for a run planned with no version", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    expect(() =>
      assertSameReingestVersion({ bundle: before.name }, before),
    ).not.toThrow()
    appendFileSync(join(dir, "discover-roots/SKILL.md"), "\n")
    const after = await readIngestSkillBundle(dir)
    expect(() =>
      assertSameReingestVersion({ bundle: before.name }, after),
    ).toThrow(/changed during the run/)
  })

  it("keeps the re-ingestion key of the 2026-10-21 re-ingestion", async () => {
    const bundle = await readIngestSkillBundle()
    expect(reingestUpgradeKey(bundle.version)).toBe(
      "reingest-ingest-5a5590e43c073b46",
    )
  })

  it("has a version file that covers the content of the folder", async () => {
    const { hash } = JSON.parse(
      readFileSync(join(INGEST_SKILLS_DIR, "version.json"), "utf8"),
    ) as { hash: string }
    const { name } = await readIngestSkillBundle()
    expect(
      hash,
      `The content of apps/backend/ingest-skills changed. In apps/backend/ingest-skills/version.json, set "hash" to "${name}". Set "version" to "${name}" too only when the change can change the knowledge that ingestion writes: a new version offers each Workspace a paid re-ingestion. A format, lint, or comment change keeps the version.`,
    ).toBe(name)
  })
})
