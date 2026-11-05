import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

test("a known diagnostic cannot hide a new error outside the workspace paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  try {
    mkdirSync(join(directory, "src"))
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    )
    writeFileSync(
      join(directory, "src/legacy.ts"),
      'export const value: number = "legacy"\n',
    )
    writeFileSync(
      join(directory, "baseline.json"),
      JSON.stringify({
        version: 1,
        diagnostics: [
          {
            file: "src/legacy.ts",
            code: 2322,
            message: "Type 'string' is not assignable to type 'number'.",
            count: 1,
          },
        ],
      }),
    )
    const check = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
          join(directory, "tsconfig.json"),
          join(directory, "baseline.json"),
        ],
        { encoding: "utf8" },
      )
    const known = check()
    assert.equal(known.status, 0, known.stdout + known.stderr)
    assert.match(known.stdout, /ACKNOWLEDGED.*1/)
    // In GitHub Actions, Bun adds `::error` annotation lines to its output.
    const actions = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
        join(directory, "tsconfig.json"),
        join(directory, "baseline.json"),
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          GITHUB_ACTIONS: "true",
          GITHUB_WORKSPACE: directory,
        },
      },
    )
    assert.equal(actions.status, 0, actions.stdout + actions.stderr)

    writeFileSync(
      join(directory, "src/elsewhere.ts"),
      'export const value: number = "new"\n',
    )
    const regression = check()
    assert.equal(regression.status, 1, regression.stdout + regression.stderr)
    assert.match(regression.stdout, /src\/elsewhere\.ts/)
    assert.match(regression.stdout, /UNEXPECTED/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a message change does not change the allowance, and a changed count does", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  try {
    mkdirSync(join(directory, "src"))
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    )
    writeFileSync(
      join(directory, "src/legacy.ts"),
      'export const a: number = "x"\nexport const b: number = "y"\n',
    )
    const run = (count) => {
      writeFileSync(
        join(directory, "baseline.json"),
        JSON.stringify({
          version: 1,
          diagnostics: [
            { file: "src/legacy.ts", code: 2322, message: "old text", count },
          ],
        }),
      )
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
          join(directory, "tsconfig.json"),
          join(directory, "baseline.json"),
        ],
        { encoding: "utf8" },
      )
    }
    const same = run(2)
    assert.equal(same.status, 0, same.stdout + same.stderr)
    const fewer = run(1)
    assert.equal(fewer.status, 1)
    assert.match(
      fewer.stdout,
      /UNEXPECTED src\/legacy\.ts TS2322: observed 2, allowed 1/,
    )
    const more = run(3)
    assert.equal(more.status, 1)
    assert.match(
      more.stdout,
      /UNEXPECTED src\/legacy\.ts TS2322: observed 2, allowed 3/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a configuration error that stops Bun before it checks files cannot hide a new type error", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  try {
    mkdirSync(join(directory, "src"))
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: ["nope"], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    )
    writeFileSync(
      join(directory, "src/new.ts"),
      'export const value: number = "new"\n',
    )
    // The allowance holds only the configuration error.
    writeFileSync(
      join(directory, "baseline.json"),
      JSON.stringify({
        version: 1,
        diagnostics: [
          {
            file: "<compiler>",
            code: 2688,
            message: "Cannot find type definition file for 'nope'.",
            count: 1,
          },
        ],
      }),
    )
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
        join(directory, "tsconfig.json"),
        join(directory, "baseline.json"),
      ],
      { encoding: "utf8" },
    )
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /not trusted/)
    assert.doesNotMatch(result.stdout, /ACKNOWLEDGED/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the runner rejects Bun output that it cannot trust, and accepts a trusted summary", () => {
  const diagnostic =
    "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n"
  const cases = [
    {
      name: "exit 0 with no output",
      fake: { status: 0, stdout: "", stderr: "" },
      expect: /no summary line/,
    },
    {
      name: "a summary that counts more errors than the lines",
      fake: {
        status: 1,
        stdout: diagnostic,
        stderr: "Found 2 errors in 2 files, checked 83 files [8ms]\n",
      },
      expect: /summary has 2 error\(s\) and the script parsed 1/,
    },
    {
      name: "an error line that does not parse",
      fake: {
        status: 1,
        stdout: `${diagnostic}src/b.ts:2 error TS2322 broken line\n`,
        stderr: "Found 2 errors in 2 files, checked 83 files [8ms]\n",
      },
      expect: /not a diagnostic/,
    },
    {
      name: "a run that checked 0 files",
      fake: {
        status: 1,
        stdout: diagnostic,
        stderr: "Found 1 error, checked 0 files [8ms]\n",
      },
      expect: /checked 0 files/,
    },
    {
      name: "a run that stopped before type checking",
      fake: {
        status: 1,
        stdout: diagnostic,
        stderr:
          "note: Stopped before type checking 83 files. Fix the errors above to see the rest.\nFound 1 error in 1 file, checked 83 files [8ms]\n",
      },
      expect: /stopped before/,
    },
    {
      name: "exit 0 with a diagnostic",
      fake: {
        status: 0,
        stdout: diagnostic,
        stderr: "Found 1 error in 1 file, checked 83 files [8ms]\n",
      },
      expect: /exit 0 does not match 1 error/,
    },
    {
      name: "exit 1 with no diagnostic",
      fake: {
        status: 1,
        stdout: "",
        stderr: "✓ No type errors in 83 files [8ms]\n",
      },
      expect: /exit 1 does not match 0 error/,
    },
    {
      name: "a trusted summary with a thousands separator (control: passes)",
      fake: {
        status: 1,
        stdout: diagnostic,
        stderr: "Found 1 error in 1 file, checked 1,429 files [8ms]\n",
      },
      expect: /ACKNOWLEDGED 1 /,
      passes: true,
    },
    {
      name: "a crash",
      fake: { status: 139, stdout: "", stderr: "" },
      expect: /bun check failed \(exit 139\)/,
    },
  ]
  for (const { name, fake, expect, passes } of cases) {
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
    try {
      // The fake `bun` prints the output in `fake.json`, in its directory.
      writeFileSync(join(directory, "tsconfig.json"), "{}")
      writeFileSync(join(directory, "fake.json"), JSON.stringify(fake))
      mkdirSync(join(directory, "bin"))
      writeFileSync(
        join(directory, "bin/bun"),
        `#!${process.execPath}\nconst fake = JSON.parse(require("node:fs").readFileSync("fake.json", "utf8"))\nprocess.stdout.write(fake.stdout)\nprocess.stderr.write(fake.stderr)\nprocess.exitCode = fake.status\n`,
        { mode: 0o755 },
      )
      writeFileSync(
        join(directory, "baseline.json"),
        JSON.stringify({
          version: 1,
          diagnostics: [
            { file: "src/a.ts", code: 2322, message: "m", count: 1 },
          ],
        }),
      )
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
          join(directory, "tsconfig.json"),
          join(directory, "baseline.json"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(directory, "bin")}:${process.env.PATH}`,
          },
        },
      )
      const output = `${name}: ${result.stdout}${result.stderr}`
      if (passes) {
        assert.equal(result.status, 0, output)
        assert.match(result.stdout, expect, name)
      } else {
        assert.equal(result.status, 1, output)
        assert.match(result.stderr, expect, name)
        assert.doesNotMatch(result.stdout, /ACKNOWLEDGED/, name)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test("a package check script does not replace the checker, and a multi-line message is one diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-typecheck-"))
  try {
    mkdirSync(join(directory, "src"))
    // `bun check` runs this script instead of the checker, unless the runner
    // passes --no-script.
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { check: "exit 7" } }),
    )
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, types: [], skipLibCheck: true },
        include: ["src/**/*.ts"],
      }),
    )
    writeFileSync(
      join(directory, "src/legacy.ts"),
      "declare const inner: { b: string }\nexport const value: { a: { b: number } } = { a: inner }\n",
    )
    const baseline = (message) =>
      writeFileSync(
        join(directory, "baseline.json"),
        JSON.stringify({
          version: 1,
          diagnostics: [
            { file: "src/legacy.ts", code: 2322, message, count: 1 },
          ],
        }),
      )
    const check = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("../ci/typecheck.mjs", import.meta.url)),
          join(directory, "tsconfig.json"),
          join(directory, "baseline.json"),
          join(directory, "report.json"),
        ],
        { encoding: "utf8" },
      )
    // The allowance holds other message text: the file, the code and the count
    // decide, so the check passes and the report keeps the observed message.
    baseline("anything")
    const known = check()
    assert.equal(known.status, 0, known.stdout + known.stderr)
    assert.match(known.stdout, /ACKNOWLEDGED 1 /)
    const report = JSON.parse(
      readFileSync(join(directory, "report.json"), "utf8"),
    )
    assert.equal(report.diagnostics.length, 1)
    assert.equal(report.diagnostics[0].file, "src/legacy.ts")
    assert.equal(report.diagnostics[0].code, 2322)
    assert.match(report.diagnostics[0].message, /\n {2}/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
