import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { listVitest } from "../checks/lanes.mjs"
import { prepare } from "../checks/prerequisites.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = (file) => readFileSync(join(root, file), "utf8")
const pins = JSON.parse(read("scripts/ci/service-pins.json"))
const postgresImage = `${pins.postgres.image}:${pins.postgres.tag}@${pins.postgres.digest}`

test("every Postgres image in compose and the workflows is the pinned one", () => {
  for (const file of ["docker-compose.yml", ".github/workflows/ci.yaml"]) {
    const images = [...read(file).matchAll(/image: (pgvector\/pgvector\S*)/g)]
    assert.ok(images.length > 0, `${file} has no pgvector image`)
    for (const [, image] of images) assert.equal(image, postgresImage, file)
  }
})

test("compose runs the ClickHouse image that the contract tests use", () => {
  const pin = pins.contracts.clickhouse
  const image = `${pin.image}:${pin.tag}@${pin.digest}`
  assert.match(read("docker-compose.yml"), new RegExp(`image: ${image}\\n`))
})

test("compose runs the DinD image that the contract tests use", () => {
  const pin = pins.contracts.dind
  const image = `${pin.image}:${pin.tag}@${pin.digest}`
  assert.match(read("docker-compose.yml"), new RegExp(`&dind-image ${image}\\n`))
})

test("compose and the AWS sandbox host run the pinned Agent Vault image", () => {
  const pin = pins.contracts.agentVault
  const image = `${pin.image}:${pin.tag}@${pin.digest}`
  assert.match(read("docker-compose.yml"), new RegExp(`&agent-vault-image ${image}\\n`))
  assert.ok(
    read("packages/aws-cdk/src/internal/sandbox-host-construct.ts").includes(`"${image}"`),
  )
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
      ["postgres", "previous-release", "contract-images"].includes(name),
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

test("the worker image builds the converter with the Rust of its rust-toolchain.toml", () => {
  const channel = read("apps/backend/converter/rust-toolchain.toml").match(
    /^channel = "([^"]+)"$/m,
  )?.[1]
  assert.ok(channel, "rust-toolchain.toml has no channel")
  assert.match(
    read("apps/backend/Dockerfile.worker"),
    new RegExp(
      `^FROM rust:${channel.replaceAll(".", "\\.")}-alpine\\S* AS converter$`,
      "m",
    ),
  )
})
