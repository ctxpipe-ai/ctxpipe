import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

test("missing git is a failed prerequisite, never an optional test skip", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../ci/prerequisites.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent-ctxpipe-fixture" },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Required prerequisite git/)
})

test("chat sandbox builds even when its tag exists", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } =
    await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "prerequisite-docker-"))
  try {
    const log = join(dir, "calls")
    writeFileSync(
      join(dir, "docker"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ')+'\\n')\n`,
      { mode: 0o755 },
    )
    const result = spawnSync(
      process.execPath,
      ["scripts/checks/prerequisites.mjs", "chat-sandbox-image"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: dir },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(
      readFileSync(log, "utf8"),
      /build -t ctxpipe-chat-sandbox:.* scripts\/chat-sandbox/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("contract images refuse a local image with another digest", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "prerequisite-digest-"))
  try {
    writeFileSync(
      join(dir, "docker"),
      `#!${process.execPath}\nprocess.stdout.write('[]')\n`,
      { mode: 0o755 },
    )
    const result = spawnSync(
      process.execPath,
      ["scripts/checks/prerequisites.mjs", "contract-images"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: dir },
      },
    )
    assert.equal(result.status, 1)
    assert.match(result.stdout, /does not have the pinned digest/)
    assert.match(
      result.stdout,
      /docker pull infisical\/agent-vault:latest@sha256:/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the bun prerequisite needs the version of the engines", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "prerequisite-bun-"))
  const run = (version) => {
    writeFileSync(
      join(dir, "bun"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`${version}\n`)})\n`,
      { mode: 0o755 },
    )
    return spawnSync(
      process.execPath,
      ["scripts/checks/prerequisites.mjs", "bun"],
      { encoding: "utf8", env: { ...process.env, PATH: dir } },
    )
  }
  try {
    const older = run("1.4.2")
    assert.equal(older.status, 1)
    assert.match(older.stdout, /Bun 1\.4\.2 is older than 1\.4\.4/)
    assert.match(older.stdout, /Install Bun 1\.4\.4 or newer/)
    assert.equal(run("1.3.9").status, 1)
    assert.equal(run("1.4.4").status, 0)
    assert.equal(run("1.5.0").status, 0)
    assert.equal(run("2.0.0").status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
