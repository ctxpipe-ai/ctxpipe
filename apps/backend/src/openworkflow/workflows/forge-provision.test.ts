import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { saveRegisteredForgeAppId } from "./forge-provision.js"

let workdir: string | undefined

afterEach(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true })
})

describe("saveRegisteredForgeAppId", () => {
  it("rejects a manifest with no app ID and tells the operator what to do", async () => {
    workdir = mkdtempSync(join(tmpdir(), "forge-app-id-test-"))
    writeFileSync(join(workdir, "manifest.yml"), "app:\n  id: ''\n")
    await expect(
      saveRegisteredForgeAppId({
        orgId: "org_test",
        connectionId: "con_test",
        workdir,
      }),
    ).rejects.toThrow(/no app ID.*Run the Forge setup again/)
  })
})
