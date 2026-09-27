import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

test("proof policy rejects aliased skips, retries and owned module mocks without matching prose", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-proof-policy-"))
  try {
    const file = join(directory, "contract.test.ts")
    const check = (source) => {
      writeFileSync(file, source)
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../ci/check-test-policy.mjs", import.meta.url),
          ),
          file,
        ],
        { encoding: "utf8" },
      )
    }
    const normal = check(
      'import { it as scenario } from "vitest"; scenario("describes .skip and vi.mock in prose", () => {})',
    )
    assert.equal(normal.status, 0, normal.stderr)
    for (const source of [
      'import { test } from "vitest"; const options = Object.seal({ retry: 0 }); options.retry = 2; test("proof", options, () => {})',
      'import { test } from "vitest"; const options = Object.freeze({ retry: 2 }); test("proof", options, () => {})',
      'import { test } from "vitest"; test("proof", Object.assign({}, { retry: 2 }), () => {})',
      'import { test } from "vitest"; const args = ["proof", { fails: true }, () => {}] as const; test(...args)',
      'import { test as scenario } from "./fixture"; scenario("proof", { retry: 2 }, () => {})',
      'import { test } from "vitest"; const options = { retry: 0 }; Object.assign(options, { retry: 2 }); test("proof", options, () => {})',
      'import { test } from "vitest"; const options = { retry: 0 }; Object.defineProperty(options, "retry", { value: 2 }); test("proof", options, () => {})',
      'import { test } from "vitest"; const options = { retry: 0 }; Reflect.set(options, "retry", 2); test("proof", options, () => {})',
      'import { test } from "vitest"; const options = { retry: 0 }; function configure(value) { value.retry = 2 } configure(options); test("proof", options, () => {})',
      'import { test } from "vitest"; test("proof", { fails: true }, () => { throw new Error("defect") })',
      'import { test } from "vitest"; const fails = true; test("proof", { fails }, () => {})',
      'import { test } from "vitest"; const key = `fails`; test("proof", { [key]: true }, () => {})',
      'import { test } from "vitest"; const options = { fails: true }; test("proof", { ...options }, () => {})',
      'import { test } from "vitest"; test.skip.each([1])("proof", () => {})',
      'import { test } from "vitest"; const omit = test.skip; omit("proof", () => {})',
      'import * as v from "vitest"; v.test.skip.each([1])("proof", () => {})',
      'import { test } from "vitest"; const { skip } = test; skip("proof", () => {})',
      'import * as v from "vitest"; const { skip: omit } = v.test; omit("proof", () => {})',
      'import { vi } from "vitest"; const { mock } = vi; mock("./owned.js", () => ({}))',
      'import * as v from "vitest"; const { mock } = v.vi; mock("./owned.js", () => ({}))',
      'import { test } from "@playwright/test"; test.fail();',
      'import { test } from "@playwright/test"; test.fixme();',
      'import { vi } from "vitest"; const fake = vi; const { mock } = fake; mock("./owned.js", () => ({}))',
      'import * as v from "vitest"; const { vi: fake } = v; fake.mock("./owned.js", () => ({}))',
      'import { test } from "vitest"; const scenario = test; scenario("proof", { retry: 2 }, () => {})',
      'import * as v from "vitest"; const scenario = v.test; scenario("proof", { retry: 2 }, () => {})',
      'import { test } from "vitest"; const options = { retry: 2 }; test("proof", options, () => {})',
      'import { test } from "vitest"; const retry = 2; test("proof", { retry }, () => {})',
      'import { test } from "vitest"; const retries = 2; const options = { retries }; test("proof", { ...options }, () => {})',
      'import { defineConfig } from "vitest/config"; const retry = 2; export default defineConfig({ test: { retry } })',
      'import { test } from "vitest"; const key = "retry"; test("proof", { [key]: 2 }, () => {})',
      'import { test } from "vitest"; test("proof", { get retry() { return 2 } }, () => {})',
      'import { test } from "vitest"; const key = `retry`; test("proof", { [key]: 2 }, () => {})',
      'import { test } from "vitest"; let retry = 0; retry = 2; test("proof", { retry }, () => {})',
      'import { test } from "vitest"; let options = { retry: 0 }; options = { retry: 2 }; test("proof", options, () => {})',
      'import { test } from "vitest"; const options = { retry: 0 }; options.retry = 2; test("proof", options, () => {})',
      'import { test } from "vitest"; const options = { retry: 0 }; const alias = options; alias.retry++; test("proof", options, () => {})',
      'import { test } from "vitest"; const retry = 2; test("proof", { retry }, () => {}); function unrelated() { const retry = 0 }',
      'import { mock } from "node:test"; mock.module("./owned.js")',
      'import { mock as substitute } from "bun:test"; substitute.module("./owned.js")',
      'import { vi } from "vitest"; const fake = (vi); fake[`mock`]("./owned.js", () => ({}))',
      'import { test } from "vitest"; const selector = `skip`; test[selector]("proof", () => {})',
      'import { defineConfig } from "vitest/config"; export default defineConfig({ test: { retry: 2 } })',
    ]) {
      const rejected = check(source)
      assert.equal(rejected.status, 1, source)
    }
    const shared = join(directory, "shared-options.ts")
    const config = join(directory, "vitest.config.ts")
    writeFileSync(shared, "export default { test: { retry: 2 } }")
    writeFileSync(config, 'export { default } from "./shared-options"')
    const policy = fileURLToPath(
      new URL("../ci/check-test-policy.mjs", import.meta.url),
    )
    assert.equal(spawnSync(process.execPath, [policy, config]).status, 1)
    const manifest = join(directory, "package.json")
    writeFileSync(
      manifest,
      JSON.stringify({ scripts: { test: "vitest run --retry=2" } }),
    )
    assert.equal(spawnSync(process.execPath, [policy, manifest]).status, 1)
    const frozenZero = check(
      'import { test } from "vitest"; test("proof", Object.freeze({ retry: 0 }), () => {})',
    )
    assert.equal(frozenZero.status, 0, frozenZero.stderr)
    const workflow = join(directory, "ci.yaml")
    writeFileSync(
      workflow,
      "jobs:\n  test:\n    steps:\n      - run: >\n          pnpm vitest run\n          --retry=2\n",
    )
    assert.equal(spawnSync(process.execPath, [policy, workflow]).status, 1)
    const custom = join(directory, "custom.ts")
    writeFileSync(custom, "export default { test: { retry: 2 } }")
    writeFileSync(
      manifest,
      JSON.stringify({ scripts: { test: "vitest run --config ./custom.ts" } }),
    )
    assert.equal(spawnSync(process.execPath, [policy, manifest]).status, 1)
    const commonConfig = join(directory, "vitest.config.cjs")
    const commonShared = join(directory, "shared-options.cjs")
    writeFileSync(commonShared, "module.exports = { test: { retry: 2 } }")
    writeFileSync(
      commonConfig,
      'module.exports = require("./shared-options.cjs")',
    )
    assert.equal(spawnSync(process.execPath, [policy, commonConfig]).status, 1)
    const helperCall = check(
      'import * as helpers from "./helpers"; test("proof", () => helpers.assert(buildSubject()))',
    )
    assert.equal(helperCall.status, 0, helperCall.stderr)
    const tableData = check(
      'import { test } from "vitest"; test.each([{ retry: 2 }])("proof", (value) => expect(value.retry).toBe(2))',
    )
    assert.equal(tableData.status, 0, tableData.stderr)
    const runner = join(directory, "runner.mjs")
    writeFileSync(runner, 'spawnSync("node", [vitest, "run", "--retry=2"])')
    assert.equal(spawnSync(process.execPath, [policy, runner]).status, 1)
    for (const command of [
      "pnpm --filter @ctxpipe/backend test -- --retry=2",
      "pnpm -C apps/backend run test -- --retry 2",
      "npm --workspace backend run test -- --retry=2",
      "turbo run test -- --retry=2",
    ]) {
      writeFileSync(manifest, JSON.stringify({ scripts: { test: command } }))
      assert.equal(
        spawnSync(process.execPath, [policy, manifest]).status,
        1,
        command,
      )
    }
    writeFileSync(
      runner,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Fixture source retains its runtime interpolation.
      'spawnSync("node", [vitest, "run", `--retry=${count}`])',
    )
    assert.equal(spawnSync(process.execPath, [policy, runner]).status, 1)
    const frameworkAssertion = check(
      'import * as v from "vitest"; v.test("proof", () => v.expect(buildSubject()).toBe(1))',
    )
    assert.equal(frameworkAssertion.status, 0, frameworkAssertion.stderr)
    const domainRetry = check(
      'test("retry policy", () => withTransientHttpRetry(operation, { retries: 2 }))',
    )
    assert.equal(domainRetry.status, 0, domainRetry.stderr)
    const observedStub = check(
      'import { vi } from "vitest"; const stub = vi.fn(); test("observes output", () => expect(stub.mock.calls).toEqual([]))',
    )
    assert.equal(observedStub.status, 0, observedStub.stderr)
    const zeroRetry = check(
      'import { test } from "vitest"; const retry = 0; const options = { retry }; test("proof", { ...options }, () => {})',
    )
    assert.equal(zeroRetry.status, 0, zeroRetry.stderr)
    const noExpectedFailure = check(
      'import { test } from "vitest"; test("proof", { fails: false }, () => {})',
    )
    assert.equal(noExpectedFailure.status, 0, noExpectedFailure.stderr)
    const scopedZero = check(
      'import { test } from "vitest"; const retry = 0; test("proof", { retry }, () => {}); function unrelated() { const retry = 2 }',
    )
    assert.equal(scopedZero.status, 0, scopedZero.stderr)
    assert.equal(
      check(
        'import { it as scenario } from "vitest"; scenario.skipIf(false)("proof", () => {})',
      ).status,
      1,
    )
    assert.equal(
      check('import { it } from "vitest"; it("proof", { retry: 2 }, () => {})')
        .status,
      1,
    )
    const mocked = check(
      'import { vi } from "vitest"; vi.mock("./owned-store.js", () => ({}))',
    )
    assert.equal(mocked.status, 1)
    assert.match(mocked.stderr, /mock/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("imported main mocks and exact skipIf are counted; fresh ones stay proof", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const policy = fileURLToPath(
    new URL("../ci/check-test-policy.mjs", import.meta.url),
  )
  const check = (...files) =>
    spawnSync(process.execPath, [policy, ...files], { encoding: "utf8" })

  const importedMock = check(join(root, "apps/backend/src/auth/config.test.ts"))
  assert.equal(importedMock.status, 0, importedMock.stderr)

  const gate0Characterization = check(
    join(root, "apps/backend/src/db/client.org-context.test.ts"),
  )
  assert.equal(gate0Characterization.status, 0, gate0Characterization.stderr)

  for (const relativePath of [
    "apps/backend/src/models/github-pr-mirror.integration.test.ts",
    "apps/backend/src/models/repositories.integration.test.ts",
    "apps/backend/src/observability/dbTrace.integration.test.ts",
    "apps/codesearch/src/routes/repo.test.ts",
  ]) {
    const importedSkipIf = check(join(root, relativePath))
    assert.equal(
      importedSkipIf.status,
      0,
      `${relativePath}\n${importedSkipIf.stderr}`,
    )
  }

  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-proof-merge-policy-"))
  try {
    const file = join(directory, "branch-new.test.ts")
    writeFileSync(
      file,
      'import { vi } from "vitest"; vi.mock("./owned.js", () => ({}))',
    )
    const rejectedMock = check(file)
    assert.equal(rejectedMock.status, 1, rejectedMock.stderr)
    assert.match(rejectedMock.stderr, /owned collaborators/)

    writeFileSync(
      file,
      'import { describe } from "vitest"; describe.skipIf(false)("proof", () => {})',
    )
    const newSkipIf = check(file)
    assert.equal(newSkipIf.status, 1, newSkipIf.stderr)
    assert.match(newSkipIf.stderr, /skipIf/)

    writeFileSync(
      file,
      'import { describe } from "vitest"; describe.skipIf(!connectionString || true)("proof", () => {})',
    )
    const changedSkipIf = check(file)
    assert.equal(changedSkipIf.status, 1, changedSkipIf.stderr)
    assert.match(changedSkipIf.stderr, /skipIf/)

    writeFileSync(
      file,
      'import { describe } from "vitest"; describe.skipIf(!connectionString)("proof", () => {})',
    )
    const copiedSkipIf = check(file)
    assert.equal(copiedSkipIf.status, 1, copiedSkipIf.stderr)
    assert.match(copiedSkipIf.stderr, /skipIf/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }

  const worktreePath = join(
    tmpdir(),
    `ctxpipe-proof-skipif-${process.pid}-${Date.now()}`,
  )
  execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
    cwd: root,
  })
  const worktree = realpathSync(worktreePath)
  try {
    copyFileSync(policy, join(worktree, "scripts/ci/check-test-policy.mjs"))
    const nodeModules = join(worktree, "node_modules")
    if (!existsSync(nodeModules))
      symlinkSync(join(root, "node_modules"), nodeModules)
    const worktreePolicy = join(worktree, "scripts/ci/check-test-policy.mjs")
    const checkWorktree = (file) =>
      spawnSync(process.execPath, [worktreePolicy, file], { encoding: "utf8" })

    const relativePath =
      "apps/backend/src/models/github-pr-mirror.integration.test.ts"
    const target = join(worktree, relativePath)
    const imported = readFileSync(join(root, relativePath), "utf8")
    const skipIfCall = "describe.skipIf(!connectionString)"
    assert.equal(
      imported.split(skipIfCall).length - 1,
      1,
      "imported fixture must have exactly one pinned skipIf call",
    )
    writeFileSync(target, imported)
    const unmodified = checkWorktree(target)
    assert.equal(unmodified.status, 0, unmodified.stderr)

    writeFileSync(
      target,
      imported.replace(
        skipIfCall,
        `${skipIfCall}("duplicate", () => {});\n${skipIfCall}`,
      ),
    )
    const duplicate = checkWorktree(target)
    assert.equal(duplicate.status, 1, duplicate.stderr)
    assert.match(duplicate.stderr, /skipIf/)

    const importedMockPath = "apps/backend/src/auth/config.test.ts"
    const importedMockTarget = join(worktree, importedMockPath)
    const importedMock = readFileSync(join(root, importedMockPath), "utf8")
    const existingOwnedMock = 'vi.mock("../db/client.js"'
    assert.match(
      importedMock,
      /vi\.mock\("\.\.\/db\/client\.js"/,
      "imported fixture must keep a pinned owned mock",
    )
    writeFileSync(importedMockTarget, importedMock)
    const existingImportedMocks = checkWorktree(importedMockTarget)
    assert.equal(
      existingImportedMocks.status,
      0,
      existingImportedMocks.stderr,
    )

    writeFileSync(
      importedMockTarget,
      `${importedMock}\nvi.mock("./owned.js", () => ({}))\n`,
    )
    const newOwnedMock = checkWorktree(importedMockTarget)
    assert.equal(newOwnedMock.status, 1, newOwnedMock.stderr)
    assert.match(newOwnedMock.stderr, /owned collaborators/)
    assert.doesNotMatch(newOwnedMock.stderr, /client\.js/)
    assert.ok(
      importedMock.includes(existingOwnedMock),
      "existing imported mock text must remain in the isolated copy",
    )

    const exceptionPath =
      "apps/backend/src/services/github/pull-request-mirror/ensure.test.ts"
    const exceptionTarget = join(worktree, exceptionPath)
    mkdirSync(join(exceptionTarget, ".."), { recursive: true })
    const exceptionSource = readFileSync(join(root, exceptionPath), "utf8")
    const existingSyncMock = `vi.mock("./sync.js", () => ({
  prepareGithubPrMirrorConfigYaml: mocks.prepareYaml,
}))`
    assert.ok(
      exceptionSource.includes(existingSyncMock),
      "exception fixture must keep the merge-resolved sync mock",
    )
    writeFileSync(exceptionTarget, exceptionSource)
    const existingException = checkWorktree(exceptionTarget)
    assert.equal(existingException.status, 0, existingException.stderr)

    writeFileSync(
      exceptionTarget,
      exceptionSource.replace(
        existingSyncMock,
        `vi.mock("./sync.js", () => ({
}))`,
      ),
    )
    const rewrittenFactory = checkWorktree(exceptionTarget)
    assert.equal(rewrittenFactory.status, 1, rewrittenFactory.stderr)
    assert.match(rewrittenFactory.stderr, /owned collaborators/)
    assert.match(rewrittenFactory.stderr, /ensure\.test\.ts/)
    assert.ok(
      exceptionSource.includes(existingSyncMock),
      "current exception call text must remain in the isolated copy",
    )
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: root,
      })
    } catch {
      rmSync(worktreePath, { recursive: true, force: true })
      execFileSync("git", ["worktree", "prune"], { cwd: root })
    }
  }
})
