import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..")
const WRAPPER_SRC = join(REPO_ROOT, ".cursor/hooks/memory-capture.sh")

function pathWithoutBun(extra: string[] = []): string {
  const filtered = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir.length > 0 && !existsSync(join(dir, "bun")))
  return [...extra, ...filtered].join(":")
}

function seedWrapperRepo(opts: { turbo?: "ok" | "fail" | "missing" } = {}): {
  cwd: string
  wrapper: string
  bunLog: string
  turboLog: string
  nodeLog: string
} {
  const turboMode = opts.turbo ?? "ok"
  const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-memory-capture-sh-"))
  const wrapper = join(cwd, ".cursor/hooks/memory-capture.sh")
  mkdirSync(dirname(wrapper), { recursive: true })
  mkdirSync(join(cwd, "packages/cli/src"), { recursive: true })
  mkdirSync(join(cwd, "packages/cli/bin"), { recursive: true })
  mkdirSync(join(cwd, "packages/cli/dist"), { recursive: true })
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true })
  writeFileSync(wrapper, readFileSync(WRAPPER_SRC, "utf8"))
  chmodSync(wrapper, 0o755)
  writeFileSync(join(cwd, "packages/cli/src/cli.ts"), "export {}\n")
  writeFileSync(join(cwd, "packages/cli/dist/cli.js"), "export {}\n")

  const bunLog = join(cwd, "bun.log")
  const turboLog = join(cwd, "turbo.log")
  const nodeLog = join(cwd, "node.log")

  const bun = join(cwd, "fake-bin/bun")
  mkdirSync(dirname(bun), { recursive: true })
  writeFileSync(
    bun,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > '${bunLog}'\nprintf '%s\\n' '{"via":"bun"}'\n`,
  )
  chmodSync(bun, 0o755)

  if (turboMode !== "missing") {
    const exitCode = turboMode === "fail" ? 1 : 0
    writeFileSync(
      join(cwd, "node_modules/.bin/turbo"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > '${turboLog}'\nexit ${exitCode}\n`,
    )
    chmodSync(join(cwd, "node_modules/.bin/turbo"), 0o755)
  }

  writeFileSync(
    join(cwd, "packages/cli/bin/ctxpipe.js"),
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(nodeLog)}, process.argv.slice(2).join(" "))\nprocess.stdout.write(JSON.stringify({ via: "node" }) + "\\n")\n`,
  )

  return { cwd, wrapper, bunLog, turboLog, nodeLog }
}

describe("in-repo memory-capture.sh", () => {
  it("runs bun from source without invoking turbo", () => {
    const { cwd, wrapper, bunLog, turboLog, nodeLog } = seedWrapperRepo()
    const stdout = execFileSync("bash", [wrapper, "memory", "capture", "observe"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(cwd, "fake-bin")}:${pathWithoutBun()}`,
      },
    })
    expect(JSON.parse(stdout)).toEqual({ via: "bun" })
    expect(readFileSync(bunLog, "utf8")).toContain("packages/cli/src/cli.ts")
    expect(() => readFileSync(turboLog, "utf8")).toThrow()
    expect(() => readFileSync(nodeLog, "utf8")).toThrow()
  })

  it("refreshes dist with turbo then runs node when bun is missing", () => {
    const { cwd, wrapper, bunLog, turboLog, nodeLog } = seedWrapperRepo()
    const stdout = execFileSync("bash", [wrapper, "memory", "capture", "finalize"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: pathWithoutBun(),
      },
    })
    expect(JSON.parse(stdout)).toEqual({ via: "node" })
    expect(() => readFileSync(bunLog, "utf8")).toThrow()
    expect(readFileSync(turboLog, "utf8")).toMatch(
      /run build --filter=ctxpipe/,
    )
    expect(readFileSync(nodeLog, "utf8")).toContain("memory capture finalize")
  })

  it("fail-opens instead of running stale dist when turbo fails", () => {
    const { cwd, wrapper, nodeLog } = seedWrapperRepo({ turbo: "fail" })
    const stdout = execFileSync("bash", [wrapper, "memory", "capture", "finalize"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: pathWithoutBun(),
      },
    })
    expect(JSON.parse(stdout)).toEqual({})
    expect(() => readFileSync(nodeLog, "utf8")).toThrow()
  })

  it("fail-opens instead of running stale dist when turbo is missing", () => {
    const { cwd, wrapper, nodeLog } = seedWrapperRepo({ turbo: "missing" })
    const stdout = execFileSync("bash", [wrapper, "memory", "capture", "finalize"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: pathWithoutBun(),
      },
    })
    expect(JSON.parse(stdout)).toEqual({})
    expect(() => readFileSync(nodeLog, "utf8")).toThrow()
  })
})
