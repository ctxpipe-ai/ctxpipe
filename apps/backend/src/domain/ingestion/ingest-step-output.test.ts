import { execFileSync } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { withIngestStepOutput } from "./ingest-step-output.js"

/*
 * The host reads the step tar that the sandbox packed. The agent controls
 * its content, so the reader writes only into its own folder.
 */

let host: string
/** No AppleDouble entries from the macOS tar. */
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: "1" }

beforeAll(() => {
  host = mkdtempSync(join(tmpdir(), "ingest-step-output-"))
})

afterAll(() => {
  rmSync(host, { recursive: true, force: true })
})

/** A tar made by the system tar from a folder that `build` fills. */
function tarOf(build: (dir: string) => void, args: string[] = ["."]) {
  const dir = mkdtempSync(join(host, "src-"))
  build(dir)
  return new Uint8Array(
    execFileSync("tar", ["-C", dir, "-cf", "-", ...args], {
      env: TAR_ENV,
      maxBuffer: 16 * 1024 * 1024,
    }),
  )
}

describe("ingest step output", () => {
  it("unpacks files, folders, a long path, and keeps a symlink as a link for the validator", async () => {
    const long = `files/knowledge/services/${"a".repeat(120)}.md`
    const tar = tarOf((dir) => {
      mkdirSync(join(dir, "files/knowledge/services"), { recursive: true })
      writeFileSync(join(dir, "patch.json"), '{"ops":[]}\n')
      writeFileSync(join(dir, long), "long\n")
      symlinkSync("/etc/passwd", join(dir, "files/knowledge/services/x.md"))
    })
    await withIngestStepOutput(tar, async (staged) => {
      expect(readFileSync(join(staged, "patch.json"), "utf8")).toBe(
        '{"ops":[]}\n',
      )
      expect(readFileSync(join(staged, long), "utf8")).toBe("long\n")
      const link = join(staged, "files/knowledge/services/x.md")
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe("/etc/passwd")
    })
  })

  it("refuses a path that leaves the folder", async () => {
    const outside = join(host, "escaped.md")
    const tar = tarOf(
      (dir) => {
        mkdirSync(join(dir, "inner"))
        writeFileSync(join(host, "escaped.md"), "x")
      },
      ["-P", outside],
    )
    rmSync(outside)
    await expect(withIngestStepOutput(tar, async () => {})).rejects.toThrow(
      "outside",
    )
  })

  it("refuses a file under a symlink of the same tar", async () => {
    const target = mkdtempSync(join(host, "target-"))
    const dir = mkdtempSync(join(host, "src-"))
    symlinkSync(target, join(dir, "files"))
    const first = execFileSync("tar", ["-C", dir, "-cf", "-", "files"], {
      env: TAR_ENV,
    })
    rmSync(join(dir, "files"))
    mkdirSync(join(dir, "files"))
    writeFileSync(join(dir, "files/owned.md"), "x")
    const second = execFileSync(
      "tar",
      ["-C", dir, "-cf", "-", "files/owned.md"],
      { env: TAR_ENV },
    )
    // Two archives back to back: the reader stops at the first end marker,
    // so join the entries without it (the end is two zero blocks).
    const entries = (buf: Buffer) => {
      let end = buf.length
      while (end >= 512 && buf.subarray(end - 512, end).every((b) => b === 0))
        end -= 512
      return buf.subarray(0, end)
    }
    const tar = new Uint8Array(Buffer.concat([entries(first), second]))
    await expect(withIngestStepOutput(tar, async () => {})).rejects.toThrow(
      "symlink",
    )
    expect(() => lstatSync(join(target, "owned.md"))).toThrow()
  })

  it("refuses an output above the cap", async () => {
    const tar = tarOf((dir) => {
      writeFileSync(join(dir, "big"), Buffer.alloc(5 * 1024 * 1024, 1))
    })
    await expect(withIngestStepOutput(tar, async () => {})).rejects.toThrow(
      "too large",
    )
  })

  it("deletes its folder after the callback", async () => {
    let seen = ""
    await withIngestStepOutput(
      tarOf((dir) => writeFileSync(join(dir, "patch.json"), "{}")),
      async (staged) => {
        seen = staged
      },
    )
    expect(() => lstatSync(seen)).toThrow()
  })
})
