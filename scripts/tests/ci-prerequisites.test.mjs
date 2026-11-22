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

// A fake docker for the contract images: `image inspect` answers with the
// RepoDigests of an image that `pull` fetched (or that `present` lists),
// and fails for any other; other commands (`info`) succeed. Each call is
// logged.
const contractDocker = async ({ present = [], pull = "ok", digests }) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } =
    await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "prerequisite-contract-"))
  try {
    const log = join(dir, "calls")
    const have = join(dir, "have.json")
    writeFileSync(log, "")
    writeFileSync(have, JSON.stringify(present))
    writeFileSync(
      join(dir, "docker"),
      `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n")
const have = JSON.parse(fs.readFileSync(${JSON.stringify(have)}, "utf8"))
const ref = args.at(-1)
if (args[0] === "pull") {
  if (${JSON.stringify(pull)} === "fail") process.exit(1)
  fs.writeFileSync(${JSON.stringify(have)}, JSON.stringify([...have, ref]))
  process.exit(0)
}
if (args[0] !== "image") process.exit(0)
if (!have.includes(ref)) process.exit(1)
const [name, digest] = ref.split("@")
const repo = name.slice(0, name.lastIndexOf(":"))
process.stdout.write(JSON.stringify(${JSON.stringify(digests ?? null)} ?? [repo + "@" + digest]))
`,
      { mode: 0o755 },
    )
    const result = spawnSync(
      process.execPath,
      ["scripts/checks/prerequisites.mjs", "contract-images"],
      { encoding: "utf8", env: { ...process.env, PATH: dir } },
    )
    const calls = readFileSync(log, "utf8").trim().split("\n")
    return { result, calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The `image:tag@digest` reference of each pinned contract image.
const pinnedRefs = async () => {
  const { readFileSync } = await import("node:fs")
  const pins = JSON.parse(readFileSync("scripts/ci/service-pins.json", "utf8"))
  return Object.values(pins.contracts).map(
    (pin) => `${pin.image}:${pin.tag}@${pin.digest}`,
  )
}

test("contract images pulls a missing image by its pinned digest", async () => {
  const { result, calls } = await contractDocker({})
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(
    calls.filter((call) => call.startsWith("pull ")),
    (await pinnedRefs()).map((ref) => `pull ${ref}`),
  )
})

test("contract images does not pull an image it already has", async () => {
  const { result, calls } = await contractDocker({
    present: await pinnedRefs(),
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(
    calls.filter((call) => call.startsWith("pull ")),
    [],
  )
})

test("contract images fails with the pull command when the pull fails", async () => {
  const { result } = await contractDocker({ pull: "fail" })
  assert.equal(result.status, 1)
  const [first] = await pinnedRefs()
  assert.ok(result.stdout.includes(`docker pull ${first}`), result.stdout)
})

test("contract images refuse a local image with another digest", async () => {
  const { result } = await contractDocker({ digests: [] })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /does not have the pinned digest/)
  assert.match(
    result.stdout,
    /docker pull infisical\/agent-vault:0\.40\.2@sha256:/,
  )
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
