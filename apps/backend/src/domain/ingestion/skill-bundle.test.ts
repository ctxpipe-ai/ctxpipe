import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { INGEST_SKILLS_DIR, readIngestSkillBundle } from "./skill-bundle.js"

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
})
