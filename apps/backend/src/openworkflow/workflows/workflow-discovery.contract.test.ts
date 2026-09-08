import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify, stripVTControlCharacters } from "node:util"
import { expect, it } from "vitest"

it(
  "discovers connector workflows through the native OpenWorkflow CLI",
  { timeout: 60_000 },
  async () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url))
    const require = createRequire(import.meta.url)
    const cli = join(dirname(require.resolve("@openworkflow/cli")), "cli.js")
    const argv = [
      "bun",
      cli,
      "doctor",
      "--config",
      join(root, "openworkflow.config.ts"),
    ]
    // The CLI stops its configured backend before returning. End this disposable
    // inspection process after command completion; no worker is started here.
    const script = `process.argv = ${JSON.stringify(argv)}; await import(${JSON.stringify(pathToFileURL(cli).href)}); process.exit(0)`
    const { stdout, stderr } = await promisify(execFile)(
      "bun",
      ["--eval", script],
      {
        cwd: root,
        env: { ...process.env, CONSOLA_LEVEL: "3" },
        timeout: 45_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    const output = stripVTControlCharacters(stdout + stderr)
    expect(output).toContain("Configuration looks good!")
    const names = output
      .split("\n")
      .map((line) => line.match(/• ([a-z][a-z0-9-]+)$/)?.[1])
    expect(names).toEqual(
      expect.arrayContaining([
        "notion-sync-config",
        "notion-sync-content",
        "notion-sync-entity",
        "slack-mention-agent",
        "workspace-hydrate",
        "workspace-index",
        "repository-index",
        "workspace-write-bootstrap",
        "workspace-write-ui-file-edit",
        "workspace-write-import-key-cleanup",
        "workspace-write-claims-upgrade",
        "workspace-write-valid-from-persist",
        "workspace-write-ops-folder-map",
      ]),
    )
  },
)
