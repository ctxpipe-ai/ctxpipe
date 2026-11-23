import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { reingestUpgradeKey } from "../upgrades/keys.js"
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

  it("keeps the re-ingestion version when only the format changes", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    appendFileSync(join(dir, "discover-roots/SKILL.md"), "\n")
    const after = await readIngestSkillBundle(dir)
    expect(after.name).not.toBe(before.name)
    expect(reingestUpgradeKey(after.version)).toBe(
      reingestUpgradeKey(before.version),
    )
  })

  it("keeps the version and the name when only a marker text changes", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    writeFileSync(join(dir, "versions/ingest-ca237393fef135a9.md"), "Other\n")
    writeFileSync(join(dir, "versions/README.md"), "Other\n")
    const after = await readIngestSkillBundle(dir)
    expect(after.version).toBe(before.version)
    expect(after.name).toBe(before.name)
  })

  it("gives a new re-ingestion key when a change adds a marker", async () => {
    const dir = copyBundle()
    const before = await readIngestSkillBundle(dir)
    writeFileSync(join(dir, "versions/ctx-1.md"), "New knowledge.\n")
    const after = await readIngestSkillBundle(dir)
    expect(after.version).toMatch(/^ingest-[0-9a-f]{16}$/)
    expect(reingestUpgradeKey(after.version)).not.toBe(
      reingestUpgradeKey(before.version),
    )
    expect(after.name).toBe(before.name)
  })

  it("gives one version for two added markers, in each merge order", async () => {
    const a = copyBundle()
    writeFileSync(join(a, "versions/ctx-1.md"), "One.\n")
    writeFileSync(join(a, "versions/ctx-2.md"), "Two.\n")
    const b = copyBundle()
    writeFileSync(join(b, "versions/ctx-2.md"), "Two.\n")
    writeFileSync(join(b, "versions/ctx-1.md"), "One.\n")
    const one = copyBundle()
    writeFileSync(join(one, "versions/ctx-1.md"), "One.\n")
    const [ab, ba, onlyOne] = await Promise.all(
      [a, b, one].map((dir) => readIngestSkillBundle(dir)),
    )
    expect(ab?.version).toBe(ba?.version)
    expect(ab?.version).not.toBe(onlyOne?.version)
  })

  it("keeps the stored version of the time before markers", async () => {
    // The last version.json on main had this version. The seed marker keeps
    // it, so the release of the markers offers no new re-ingestion.
    const seed = "ingest-ca237393fef135a9.md"
    expect(readdirSync(join(INGEST_SKILLS_DIR, "versions"))).toContain(seed)
    const dir = copyBundle()
    for (const marker of readdirSync(join(dir, "versions")))
      if (marker !== seed && marker !== "README.md")
        rmSync(join(dir, "versions", marker))
    expect((await readIngestSkillBundle(dir)).version).toBe(
      "ingest-ca237393fef135a9",
    )
  })

  it("fails when a marker has another name form", async () => {
    const dir = copyBundle()
    writeFileSync(join(dir, "versions/CTX-1.txt"), "One.\n")
    await expect(readIngestSkillBundle(dir)).rejects.toThrow(/CTX-1\.txt/)
  })

  it("fails when the versions folder has no marker", async () => {
    const dir = copyBundle()
    rmSync(join(dir, "versions/ingest-ca237393fef135a9.md"))
    await expect(readIngestSkillBundle(dir)).rejects.toThrow(/no marker/)
  })

  it("does not put the markers in the bundle", async () => {
    const bundle = await readIngestSkillBundle()
    expect(bundle.files.some((f) => f.path.startsWith("versions/"))).toBe(false)
  })
})
