import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { saveRegisteredForgeAppId } from "./forge-provision.js"

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function workdirWithAppId(id: string): string {
  const d = mkdtempSync(join(tmpdir(), "forge-app-id-test-"))
  dirs.push(d)
  writeFileSync(join(d, "manifest.yml"), `app:\n  id: ${JSON.stringify(id)}\n`)
  return d
}

describe("saveRegisteredForgeAppId", () => {
  it.each([
    "",
    "not-an-app",
    "ari:cloud:ecosystem::app/4ce198e3",
    "ari:cloud:ecosystem::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43/extra",
    "ari:cloud:other::app/4ce198e3-2ce7-4a6e-865f-a3e31d15fe43",
  ])("rejects the app ID %j and tells the operator what to do", async (id) => {
    await expect(
      saveRegisteredForgeAppId({
        orgId: "org_test",
        connectionId: "con_test",
        workdir: workdirWithAppId(id),
      }),
    ).rejects.toThrow(/no valid app ID.*Run the Forge setup again/)
  })
})
