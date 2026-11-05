import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { listVitest } from "../checks/lanes.mjs"
import { falkordbModuleVersion, prepare } from "../checks/prerequisites.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = (file) => readFileSync(join(root, file), "utf8")
const pins = JSON.parse(read("scripts/ci/service-pins.json"))
const postgresImage = `${pins.postgres.image}:${pins.postgres.tag}@${pins.postgres.digest}`

test("every Postgres image in compose and the workflows is the pinned one", () => {
  for (const file of [
    "docker-compose.yml",
    ".github/workflows/ci.yaml",
    ".github/workflows/mcp-evals.yaml",
  ]) {
    const images = [...read(file).matchAll(/image: (pgvector\/pgvector\S*)/g)]
    assert.ok(images.length > 0, `${file} has no pgvector image`)
    for (const [, image] of images) assert.equal(image, postgresImage, file)
  }
})

test("the FalkorDB action and compose use the pinned digest", () => {
  const image = `${pins.falkordb.image}@${pins.falkordb.digest}`
  assert.ok(read(".github/actions/falkordb/action.yaml").includes(image))
  assert.match(read("docker-compose.yml"), new RegExp(`image: ${image}\\n`))
})

test("ci.yaml reads the previous release ref from the pins file", () => {
  const ci = read(".github/workflows/ci.yaml")
  assert.ok(
    ci.includes("jq -r .previousRelease.ref scripts/ci/service-pins.json"),
  )
  assert.ok(!ci.includes(pins.previousRelease.ref))
})

test("every check that needs a pinned service lists the pins file", async () => {
  const checks = await listVitest()
  const pinned = checks.filter((check) =>
    check.prerequisites?.some((name) =>
      ["postgres", "falkordb", "previous-release", "contract-images"].includes(
        name,
      ),
    ),
  )
  const contracts = checks.filter((check) => check.lane === "contracts")
  assert.ok(contracts.length > 0)
  for (const check of contracts) {
    assert.ok(check.prerequisites.includes("contract-images"), check.id)
    assert.ok(
      check.env.some(
        (entry) =>
          entry.name === "DOCKER_DEFAULT_PLATFORM" && entry.mode === "value",
      ),
      check.id,
    )
  }
  assert.ok(pinned.length > 0)
  for (const check of pinned) {
    assert.ok(check.inputs.includes("scripts/ci/service-pins.json"), check.id)
    assert.ok(
      check.inputs.includes("scripts/checks/prerequisites.mjs"),
      check.id,
    )
  }
})

test("the FalkorDB module version comes from a MODULE LIST reply", async () => {
  // A real FalkorDB of another version is not practical in a unit test, so a
  // tiny server answers MODULE LIST with the RESP2 shape that FalkorDB sends.
  const server = createServer((socket) =>
    socket.on("data", () =>
      socket.write(
        "*1\r\n*8\r\n$4\r\nname\r\n$5\r\ngraph\r\n$3\r\nver\r\n:41999\r\n$4\r\npath\r\n$1\r\nx\r\n$4\r\nargs\r\n*0\r\n",
      ),
    ),
  )
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const version = await falkordbModuleVersion(
      `redis://127.0.0.1:${server.address().port}`,
    )
    assert.equal(version, 41999)
    assert.notEqual(version, pins.falkordb.moduleVersion)
  } finally {
    server.close()
  }
})

test("previous-release refuses a tree at another commit", async () => {
  const tree = mkdtempSync(join(tmpdir(), "previous-release-"))
  mkdirSync(join(tree, "apps/backend/node_modules"), { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: tree })
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ],
    { cwd: tree },
  )
  process.env.RELEASE_TREE = tree
  const failed = await prepare(["previous-release"])
  assert.match(
    failed.get("previous-release"),
    /is at [0-9a-f]{40}|git fetch origin tag/,
  )
})
