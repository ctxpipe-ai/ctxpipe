import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// The codesearch test image (CTX-1551): each run of run-vitest-docker.sh builds
// it under a tag of its own, with the owner label, and removes that tag when
// it ends, also when the tests fail. An image that the caller names stays.

const root = fileURLToPath(new URL("../../", import.meta.url))
const script = join(root, "apps/codesearch/scripts/run-vitest-docker.sh")

// A fake `docker` that logs each call, one per line, with the arguments
// separated by tabs. FAKE_RUN_STATUS is the exit status of `docker run`.
const FAKE_DOCKER = `#!/usr/bin/env bash
(IFS=$'\\t'; printf '%s\\n' "$*") >> "$FAKE_LOG"
case "$1" in
  info) echo aarch64 ;;
  run) exit "\${FAKE_RUN_STATUS:-0}" ;;
esac
exit 0
`

const run = (env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "codesearch-test-image-"))
  try {
    const log = join(dir, "docker.log")
    writeFileSync(log, "")
    writeFileSync(join(dir, "docker"), FAKE_DOCKER)
    chmodSync(join(dir, "docker"), 0o755)
    const base = { ...process.env }
    delete base.CTXPIPE_CODESEARCH_TEST_IMAGE
    delete base.CTXPIPE_TEST_OWNER
    const result = spawnSync(
      "bash",
      [script, "--node", "src/example.test.ts"],
      {
        encoding: "utf8",
        env: {
          ...base,
          // The fake docker first; node for the orphan sweep.
          PATH: [dir, dirname(process.execPath), base.PATH].join(delimiter),
          FAKE_LOG: log,
          ...env,
        },
      },
    )
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
    return { result, calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const after = (args, flag) => args[args.indexOf(flag) + 1]

test("a run builds the image under a tag of its own, with its owner, and removes the tag at its end", () => {
  const { result, calls } = run({ CTXPIPE_TEST_OWNER: "agent-host/4242" })
  assert.equal(result.status, 0, result.stderr)
  const build = calls.find((args) => args[0] === "build")
  const tag = after(build, "-t")
  assert.match(tag, /^ctxpipe-codesearch:test-\d+-\d+$/)
  assert.equal(after(build, "--label"), "ai.ctxpipe.test=agent-host/4242")
  const runCall = calls.find((args) => args[0] === "run")
  assert.ok(runCall.includes(tag), "the run starts the image of this build")
  // The sweep of killed runs comes before the build.
  const sweep = calls.findIndex(
    (args) =>
      args.join(" ") ===
      "image ls -q --no-trunc --filter label=ai.ctxpipe.test",
  )
  assert.ok(sweep >= 0 && sweep < calls.indexOf(build))
  assert.deepEqual(calls.at(-1), ["image", "rm", "--", tag])
})

test("the tag of a run whose tests fail is removed too", () => {
  const { result, calls } = run({ FAKE_RUN_STATUS: "1" })
  assert.equal(result.status, 1)
  const tag = after(
    calls.find((args) => args[0] === "build"),
    "-t",
  )
  assert.deepEqual(calls.at(-1), ["image", "rm", "--", tag])
})

test("two runs build under two tags", () => {
  const tags = [run(), run()].map(({ calls }) =>
    after(
      calls.find((args) => args[0] === "build"),
      "-t",
    ),
  )
  assert.notEqual(tags[0], tags[1])
})

test("an image that the caller names has no owner label and stays", () => {
  const { result, calls } = run({
    CTXPIPE_CODESEARCH_TEST_IMAGE: "ctxpipe-codesearch:mine",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    after(
      calls.find((args) => args[0] === "build"),
      "-t",
    ),
    "ctxpipe-codesearch:mine",
  )
  assert.ok(!calls.some((args) => args[0] === "image" && args[1] === "rm"))
  // No owner label: the sweep of a later run never selects it.
  assert.ok(
    !calls
      .find((args) => args[0] === "build")
      .some((arg) => arg.startsWith("ai.ctxpipe.test=")),
  )
})
