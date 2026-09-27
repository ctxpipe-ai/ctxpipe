import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { useEnv } from "../test-env"
import { rows } from "./blacksmith"

const DAY = "2026-09-25"
// Envelope inferred from CLI v0.4.61 help + binary JSON tags, not a live authenticated run.
const FIXTURE = {
  summary: {
    jobs: 4,
    billable_minutes: 12,
    billing_minutes: 11.25,
    runtime_minutes: 3.5,
    estimated_cost_usd: 0.096,
  },
  days: [{ day: DAY, jobs: 4, billable_minutes: 12, estimated_cost_usd: 0.096 }],
  breakdowns: {
    "day,runner_type,workflow": [
      {
        day: DAY,
        runner_type: "blacksmith-4vcpu-ubuntu-2404",
        workflow: "CI",
        repo: "ctxpipe-ai/ctxpipe",
        jobs: 3,
        billable_minutes: 10,
        billing_minutes: 10,
        runtime_minutes: 2.5,
        estimated_cost_usd: 0.08,
      },
      {
        day: DAY,
        runner_type: "blacksmith-2vcpu-ubuntu-2404-arm",
        workflow: "Deploy",
        repo: "ctxpipe-ai/ctxpipe",
        jobs: 1,
        billable_minutes: 2,
        billing_minutes: 1.25,
        runtime_minutes: 1,
        estimated_cost_usd: 0.016,
      },
    ],
  },
}

let binDir = ""
const previousPath = process.env.PATH
useEnv({ BLACKSMITH_TOKEN: "bs-token" })

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "blacksmith-cli-"))
  process.env.PATH = `${binDir}:${previousPath}`
})

afterEach(() => {
  process.env.PATH = previousPath
  rmSync(binDir, { recursive: true, force: true })
})

describe("blacksmith rows", () => {
  test("maps daily billable minutes and reported spend from usage JSON", async () => {
    const fixturePath = join(binDir, "fixture.json")
    writeFileSync(fixturePath, JSON.stringify(FIXTURE))
    installFake(`#!/bin/sh
printf '%s\\n' "$0 $*" >> "${join(binDir, "argv.log")}"
if [ "$1" != "usage" ]; then exit 0; fi
cat "${fixturePath}"
`)
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "blacksmith",
        sku: "blacksmith-4vcpu-ubuntu-2404",
        scope: "CI",
        usage: 10,
        unit: "minutes",
        costUsd: 0.08,
        source: "reported",
      },
      {
        day: DAY,
        provider: "blacksmith",
        sku: "blacksmith-2vcpu-ubuntu-2404-arm",
        scope: "Deploy",
        usage: 2,
        unit: "minutes",
        costUsd: 0.016,
        source: "reported",
      },
    ])
    const argv = await Bun.file(join(binDir, "argv.log")).text()
    expect(argv).toContain(
      `usage --start-time ${DAY}T00:00:00Z --end-time ${DAY}T23:59:59Z --breakdown-by day,runner_type,workflow --format json --limit 1000 --org ctxpipe-ai`,
    )
    expect(argv).toContain("auth login --api-token - --non-interactive --organization ctxpipe-ai")
  })

  test("throws on a non-zero exit and includes a stderr slice", async () => {
    installFake(`#!/bin/sh
echo 'token verification failed: invalid token' >&2
exit 1
`)
    await expect(rows([DAY])).rejects.toThrow("token verification failed: invalid token")
  })

  test("throws when usage stdout is not JSON", async () => {
    installFake(`#!/bin/sh
if [ "$1" != "usage" ]; then exit 0; fi
echo 'not-json'
`)
    await expect(rows([DAY])).rejects.toThrow("blacksmith usage stdout was not JSON")
  })

  test("throws when the requested breakdown array is missing", async () => {
    const fixturePath = join(binDir, "fixture.json")
    writeFileSync(fixturePath, JSON.stringify({ summary: {}, days: [], breakdowns: { "day,runner_type,repo": [] } }))
    installFake(`#!/bin/sh
if [ "$1" != "usage" ]; then exit 0; fi
cat "${fixturePath}"
`)
    await expect(rows([DAY])).rejects.toThrow("missing breakdowns[day,runner_type,workflow]")
  })

  test("throws when every breakdown row is unmappable", async () => {
    const fixturePath = join(binDir, "fixture.json")
    writeFileSync(
      fixturePath,
      JSON.stringify({
        breakdowns: {
          "day,runner_type,workflow": [
            { day: DAY, runner_type: "blacksmith-4vcpu-ubuntu-2404", billable_minutes: "x", estimated_cost_usd: 0.01 },
            null,
          ],
        },
      }),
    )
    installFake(`#!/bin/sh
if [ "$1" != "usage" ]; then exit 0; fi
cat "${fixturePath}"
`)
    await expect(rows([DAY])).rejects.toThrow("no mappable rows")
  })

  test("skips malformed items", async () => {
    const fixturePath = join(binDir, "fixture.json")
    writeFileSync(
      fixturePath,
      JSON.stringify({
        breakdowns: {
          "day,runner_type,workflow": [
            { day: DAY, runner_type: "blacksmith-4vcpu-ubuntu-2404", workflow: "CI", billable_minutes: 4, estimated_cost_usd: 0.032 },
            { day: DAY, runner_type: "blacksmith-4vcpu-ubuntu-2404", workflow: "CI", billable_minutes: "x", estimated_cost_usd: 0.01 },
            null,
            { runner_type: "blacksmith-4vcpu-ubuntu-2404", billable_minutes: 1, estimated_cost_usd: 0.008 },
          ],
        },
      }),
    )
    installFake(`#!/bin/sh
if [ "$1" != "usage" ]; then exit 0; fi
cat "${fixturePath}"
`)
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "blacksmith",
        sku: "blacksmith-4vcpu-ubuntu-2404",
        scope: "CI",
        usage: 4,
        unit: "minutes",
        costUsd: 0.032,
        source: "reported",
      },
    ])
  })

  test("throws when the org token is missing", async () => {
    delete process.env.BLACKSMITH_TOKEN
    await expect(rows([DAY])).rejects.toThrow("BLACKSMITH_TOKEN is required")
  })
})

function installFake(script: string): void {
  const path = join(binDir, "blacksmith")
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}
