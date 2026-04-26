import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import {
  buildForgeAppManifestYml,
  forgeAppIdToAri,
} from "../lib/forge-app-manifest.js"
import {
  mapForgeCliOutputToErrorCode,
  userMessageForProvisionError,
} from "../lib/forge-provision-error-map.js"
import {
  getForgeInstallationByConnectionId,
  patchForgeConnectionTypedConfig,
} from "../models/atlassian-connector.js"

const inputSchema = z.object({
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  connectionId: z.string().min(1),
})

function publicApiOrigin(): string {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  if (process.env.CTXPIPE_PUBLIC_APP_URL) {
    return process.env.CTXPIPE_PUBLIC_APP_URL.replace(/\/$/, "")
  }
  return env.AUTH_BASE_URL.replace(/\/$/, "")
}

const cliPath = fileURLToPath(
  new URL("../scripts/forge-provision-cli.mjs", import.meta.url),
)

function runProvisionCli(
  workdir: string,
  env: NodeJS.ProcessEnv,
): { exit: number; out: string } {
  if (env.FORGE_PROVISION_DRY_RUN === "1") {
    return { exit: 0, out: "dry run ok\n" }
  }
  try {
    execFileSync(process.execPath, [cliPath], {
      cwd: workdir,
      env: {
        ...process.env,
        ...env,
        FORGE_PROVISION_LOG: join(workdir, "out.log"),
      },
      maxBuffer: 8 * 1024 * 1024,
    })
    return { exit: 0, out: "ok" }
  } catch (e: unknown) {
    const ex = e as {
      status?: number
      message?: string
      stdout?: string
      stderr?: string
    }
    const out = [ex.stdout, ex.stderr, ex.message].filter(Boolean).join("\n")
    return { exit: typeof ex.status === "number" ? ex.status : 1, out }
  }
}

export const forgeProvision = defineWorkflow(
  { name: "forge-provision", schema: inputSchema },
  async ({ input, step }) => {
    const runLabel = `fp_${input.connectionId.slice(-8)}_${Date.now()}`

    const loaded = await step.run({ name: "load-connection" }, async () => {
      const row = await getForgeInstallationByConnectionId(
        input.orgId,
        input.connectionId,
      )
      if (!row) {
        throw new Error("Unknown forge connection for org")
      }
      return { row, remote: publicApiOrigin() }
    })

    const { row, remote } = loaded
    const site = (row.confluenceSiteHost ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
    const token = row.forgeScopedApiToken
    if (!site || !token) {
      await patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "failed",
        provisionErrorCode: "confluence_install_site",
        provisionStderr:
          "Missing confluence site or forge API token in connection config",
        lastProvisionAt: new Date().toISOString(),
      })
      return { ok: false as const, code: "confluence_install_site" as const }
    }

    await step.run({ name: "mark-running" }, () =>
      patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "running",
        provisionErrorCode: null,
        provisionStderr: null,
        provisionWorkflowRunId: runLabel,
        lastProvisionAt: new Date().toISOString(),
      }),
    )

    const workdir = await step.run({ name: "stage-forge-app" }, () => {
      const d = mkdtempSync(join(tmpdir(), "ctxpipe-forge-"))
      const appAri = forgeAppIdToAri(row.appId)
      const name =
        `ctxp-${input.connectionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40)}` ||
        "ctxpipe-forge"
      writeFileSync(
        join(d, "manifest.yml"),
        buildForgeAppManifestYml({ appIdAri: appAri, remoteBaseUrl: remote }),
        "utf8",
      )
      writeFileSync(
        join(d, "package.json"),
        JSON.stringify({ name, version: "1.0.0", private: true }, null, 2),
        "utf8",
      )
      return d
    })

    const result = await step.run({ name: "forge-cli" }, () => {
      const r = runProvisionCli(workdir, {
        FORGE_API_TOKEN: token,
        CONFLUENCE_SITE: site,
        FORGE_APP_NAME: `ctxp-${input.connectionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40)}`,
        EXISTING_APP_ID: row.appId ?? "",
        FORGE_PROVISION_DRY_RUN: process.env.FORGE_PROVISION_DRY_RUN ?? "0",
        FORGE_EMAIL: row.forgeOperatorEmail ?? "",
      })
      try {
        rmSync(workdir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      return r
    })

    if (result.exit === 0) {
      await step.run({ name: "mark-success" }, () =>
        patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
          provisionStatus: "succeeded",
          provisionErrorCode: null,
          provisionStderr: null,
          lastProvisionAt: new Date().toISOString(),
        }),
      )
      return { ok: true as const }
    }

    const code = mapForgeCliOutputToErrorCode(result.exit, result.out)
    const message = userMessageForProvisionError(code)
    await step.run({ name: "mark-failed" }, () =>
      patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "failed",
        provisionErrorCode: code,
        provisionStderr: result.out.slice(0, 8_000),
        lastProvisionAt: new Date().toISOString(),
      }),
    )
    return { ok: false as const, code, message }
  },
)
