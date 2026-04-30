import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
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
import { log } from "../observability/logger.js"

const STDERR_LOG_PREVIEW_CHARS = 1_400

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
    const dryRun = process.env.FORGE_PROVISION_DRY_RUN === "1"

    log.info({
      step: "forge-provision.start",
      message: "Forge provision workflow started",
      orgId: input.orgId,
      orgSlug: input.orgSlug,
      connectionId: input.connectionId,
      runLabel,
      dryRun,
    })

    const loaded = await step.run({ name: "load-connection" }, async () => {
      return withOrgDbContext(input.orgId, async (db) => {
        const row = await getForgeInstallationByConnectionId(
          input.orgId,
          input.connectionId,
          db,
        )
        if (!row) {
          log.error({
            step: "forge-provision.load-connection",
            message:
              "Unknown forge connection row — provisioning cannot continue for this connectionId",
            orgId: input.orgId,
            connectionId: input.connectionId,
            runLabel,
          })
          throw new Error("Unknown forge connection for org")
        }
        const remote = publicApiOrigin()
        log.info({
          step: "forge-provision.load-connection",
          message:
            "Loaded forge connection row; resolved manifest Remote base URL",
          orgId: input.orgId,
          orgSlug: input.orgSlug,
          connectionId: input.connectionId,
          forgeAppId: row.appId,
          manifestRemoteOrigin: remote,
          confluenceSiteHostStored: row.confluenceSiteHost,
          runLabel,
        })
        return { row, remote }
      })
    })

    const { row, remote } = loaded
    const site = (row.confluenceSiteHost ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
    const token = row.forgeScopedApiToken
    if (!site || !token) {
      log.error({
        step: "forge-provision.validate-config",
        message:
          "Missing Confluence hostname or Forge API token on connection after patch — refusing provision",
        orgId: input.orgId,
        connectionId: input.connectionId,
        hasConfluenceSiteHost: Boolean(site),
        hasForgeScopedToken: Boolean(token),
        runLabel,
      })
      await patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "failed",
        provisionErrorCode: "confluence_install_site",
        provisionStderr:
          "Missing confluence site or forge API token in connection config",
        lastProvisionAt: new Date().toISOString(),
      })
      return { ok: false as const, code: "confluence_install_site" as const }
    }

    await step.run({ name: "mark-running" }, async () => {
      await patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "running",
        provisionErrorCode: null,
        provisionStderr: null,
        provisionWorkflowRunId: runLabel,
        lastProvisionAt: new Date().toISOString(),
      })
      log.info({
        step: "forge-provision.mark-running",
        message:
          "Provision marked running — staging manifest next, then Forge CLI (register / deploy / install)",
        connectionId: input.connectionId,
        runLabel,
        dryRun,
      })
    })

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
      log.info({
        step: "forge-provision.stage-app",
        message:
          "Wrote manifest.yml and package.json under temp workspace for Forge CLI",
        connectionId: input.connectionId,
        forgeAppSlug: name,
        workspaceDirBasename: d.includes("/") ? d.split(/[/]/).pop() : d,
        runLabel,
        dryRun,
      })
      return d
    })

    const result = await step.run({ name: "forge-cli" }, () => {
      const appSlug =
        `ctxp-${input.connectionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40)}` ||
        "ctxpipe-forge"
      const existingAppId = (row.appId ?? "").trim()
      log.info({
        step: "forge-provision.cli-start",
        message:
          "Invoking Forge provision CLI subprocess (Forge register → deploy production → install on Confluence; stdio inherits worker process)",
        connectionId: input.connectionId,
        confluenceSiteHost: site,
        forgeAppSlug: appSlug,
        willRunRegisterStep: existingAppId.length === 0,
        existingForgeAppId: existingAppId || undefined,
        runLabel,
        dryRun,
      })
      const cliStartedAt = Date.now()
      const r = runProvisionCli(workdir, {
        FORGE_API_TOKEN: token,
        CONFLUENCE_SITE: site,
        FORGE_APP_NAME: appSlug,
        EXISTING_APP_ID: row.appId ?? "",
        FORGE_PROVISION_DRY_RUN: process.env.FORGE_PROVISION_DRY_RUN ?? "0",
        FORGE_EMAIL: row.forgeOperatorEmail ?? "",
      })
      try {
        rmSync(workdir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      const elapsedMs = Date.now() - cliStartedAt
      if (r.exit === 0) {
        log.info({
          step: "forge-provision.cli-success",
          message: "Forge CLI subprocess finished OK",
          connectionId: input.connectionId,
          exitCode: r.exit,
          elapsedMs,
          runLabel,
          dryRun,
        })
      }
      return { exit: r.exit, out: r.out, elapsedMs }
    })

    if (result.exit === 0) {
      await step.run({ name: "mark-success" }, async () => {
        await patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
          provisionStatus: "succeeded",
          provisionErrorCode: null,
          provisionStderr: null,
          lastProvisionAt: new Date().toISOString(),
        })
      })
      log.info({
        step: "forge-provision.completed",
        message:
          "Forge provision finished successfully (DB provisionStatus succeeded)",
        connectionId: input.connectionId,
        runLabel,
      })
      return { ok: true as const }
    }

    const code = mapForgeCliOutputToErrorCode(result.exit, result.out)
    const message = userMessageForProvisionError(code)
    await step.run({ name: "mark-failed" }, async () => {
      await patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "failed",
        provisionErrorCode: code,
        provisionStderr: result.out.slice(0, 8_000),
        lastProvisionAt: new Date().toISOString(),
      })
    })
    log.error({
      step: "forge-provision.failed",
      message: "Forge provision failed after CLI exited non-zero",
      connectionId: input.connectionId,
      runLabel,
      provisionErrorCode: code,
      userMessage: message,
      cliExitCode: result.exit,
      cliElapsedMs: result.elapsedMs,
      stderrPreview: result.out.slice(0, STDERR_LOG_PREVIEW_CHARS),
      dryRun,
    })
    return { ok: false as const, code, message }
  },
)
