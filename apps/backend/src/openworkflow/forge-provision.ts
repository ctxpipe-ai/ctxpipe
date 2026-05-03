import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

/** Enough for Forge `--verbose`: last GraphQL + error lines usually matter; full stderr also stored on connection (provisionStderr ~8KB). */
const STDERR_LOG_PREVIEW_CHARS = 4_096

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

const FORGE_ECOSYSTEM_GRAPHQL = "https://api.atlassian.com/graphql"

const QUERY_DEV_SPACE_IDS = `
  query GetDevSpaceWithLinkingAccess {
    ecosystem {
      devConsole {
        getDeveloperSpaceWithLinkingAccess
      }
    }
  }
`

const QUERY_DEV_SPACE_DETAILS = `
  query GetDevSpaceDetails($devSpaceIds: [String!]!) {
    ecosystem {
      devConsole {
        getDeveloperSpaceDetails(developerSpaceIds: $devSpaceIds) {
          results {
            developerSpaceId
            error {
              message
            }
            details {
              name
            }
          }
        }
      }
    }
  }
`

const MUTATION_CREATE_DEV_SPACE = `
  mutation CreateDeveloperSpace($input: DevConsoleCreateDeveloperSpaceInput!) {
    ecosystem {
      devConsole {
        createDeveloperSpace(input: $input) {
          devSpace {
            id
            name
          }
          success
          errors {
            message
            extensions {
              statusCode
              errorType
            }
          }
        }
      }
    }
  }
`

/** Shown in Developer Console; one space reused per Forge token / Atlassian account. */
export const CTXPIPE_FORGE_AUTO_DEVELOPER_SPACE_NAME = "ctxpipe"

function readForgeCliVersionForGatewayHeaders(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "node_modules",
      "@forge",
      "cli",
      "package.json",
    )
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
    return pkg.version ?? "12.17.0"
  } catch {
    return "12.17.0"
  }
}

type GraphqlEnvelope<T> = {
  errors?: Array<{ message: string }>
  data?: T
}

/** Matches `@forge/cli-shared` `getBasicAuthorizationHeader` — Dev Console GraphQL expects email + API token, not Bearer. */
function forgeEcosystemBasicAuthorization(
  operatorEmail: string,
  apiToken: string,
): string {
  const b64 = Buffer.from(`${operatorEmail}:${apiToken}`).toString("base64")
  return `Basic ${b64}`
}

async function forgeDevSpaceGraphql<D>(
  operatorEmail: string,
  apiToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<D> {
  const cliVersion = readForgeCliVersionForGatewayHeaders()
  const res = await fetch(FORGE_ECOSYSTEM_GRAPHQL, {
    method: "POST",
    headers: {
      authorization: forgeEcosystemBasicAuthorization(
        operatorEmail,
        apiToken,
      ),
      "content-type": "application/json",
      "user-agent": `@forge/cli/${cliVersion}`,
      "atl-client-name": "@forge/cli",
      "atl-client-version": cliVersion,
      "atl-attribution": JSON.stringify({
        businessUnit: "Ecosystem - COGS",
        service: "forge-cli",
      }),
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  })

  const text = await res.text()
  let body: GraphqlEnvelope<D>
  try {
    body = JSON.parse(text) as GraphqlEnvelope<D>
  } catch {
    throw new Error(`Forge GraphQL returned non-JSON (HTTP ${res.status})`)
  }
  if (!res.ok) {
    throw new Error(`Forge GraphQL HTTP ${res.status}: ${text.slice(0, 800)}`)
  }
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "))
  }
  if (body.data === undefined || body.data === null) {
    throw new Error("Forge GraphQL: missing data in response")
  }
  return body.data
}

type DevSpaceListItem = { id: string; name: string }

async function listForgeDeveloperSpacesAccessible(
  operatorEmail: string,
  apiToken: string,
): Promise<DevSpaceListItem[]> {
  const idData = await forgeDevSpaceGraphql<{
    ecosystem?: {
      devConsole?: {
        getDeveloperSpaceWithLinkingAccess?: string[]
      }
    }
  }>(operatorEmail, apiToken, QUERY_DEV_SPACE_IDS, {})

  const ids =
    idData.ecosystem?.devConsole?.getDeveloperSpaceWithLinkingAccess ?? []
  if (!Array.isArray(ids) || ids.length === 0) {
    return []
  }

  const detailData = await forgeDevSpaceGraphql<{
    ecosystem?: {
      devConsole?: {
        getDeveloperSpaceDetails?: {
          results?: Array<{
            developerSpaceId: string
            error?: { message: string }
            details?: { name: string }
          }>
        }
      }
    }
  }>(operatorEmail, apiToken, QUERY_DEV_SPACE_DETAILS, { devSpaceIds: ids })

  const rows =
    detailData.ecosystem?.devConsole?.getDeveloperSpaceDetails?.results ?? []
  const out: DevSpaceListItem[] = []
  for (const r of rows) {
    if (!r?.error?.message && r.details?.name && r.developerSpaceId) {
      out.push({ id: r.developerSpaceId, name: r.details.name })
    }
  }
  return out
}

function normalizeDevSpaceLabel(s: string): string {
  return s.trim().toLowerCase()
}

function pickForgeDevSpaceByName(
  spaces: DevSpaceListItem[],
  wantName: string,
): DevSpaceListItem | undefined {
  const n = normalizeDevSpaceLabel(wantName)
  return spaces.find((x) => normalizeDevSpaceLabel(x.name) === n)
}

async function createForgeDeveloperSpace(
  operatorEmail: string,
  apiToken: string,
  name: string,
): Promise<DevSpaceListItem> {
  const data = await forgeDevSpaceGraphql<{
    ecosystem?: {
      devConsole?: {
        createDeveloperSpace?: {
          devSpace?: { id?: string; name?: string }
          success?: boolean
          errors?: Array<{ message?: string }>
        }
      }
    }
  }>(operatorEmail, apiToken, MUTATION_CREATE_DEV_SPACE, {
    input: { name },
  })

  const block = data.ecosystem?.devConsole?.createDeveloperSpace
  if (
    block?.success &&
    block.devSpace?.id &&
    typeof block.devSpace.name === "string"
  ) {
    return { id: block.devSpace.id, name: block.devSpace.name }
  }
  const gqlErr =
    block?.errors?.map((e) => e.message ?? "").filter(Boolean).join("; ") ?? ""
  throw new Error(
    gqlErr || "Forge createDeveloperSpace: success=false or missing devSpace",
  )
}

/** Ensures the named Developer Space exists (creates if absent). Exported for tests. */
export async function ensureCtxpipeForgeDeveloperSpaceId(opts: {
  operatorEmail: string
  apiToken: string
  spaceName?: string
}): Promise<string> {
  const spaceName =
    opts.spaceName?.trim() || CTXPIPE_FORGE_AUTO_DEVELOPER_SPACE_NAME
  const email = opts.operatorEmail.trim()

  let spaces = await listForgeDeveloperSpacesAccessible(
    email,
    opts.apiToken,
  )
  const existing = pickForgeDevSpaceByName(spaces, spaceName)
  if (existing) return existing.id

  try {
    const created = await createForgeDeveloperSpace(
      email,
      opts.apiToken,
      spaceName,
    )
    return created.id
  } catch (eFirst) {
    spaces = await listForgeDeveloperSpacesAccessible(
      email,
      opts.apiToken,
    )
    const again = pickForgeDevSpaceByName(spaces, spaceName)
    if (again) return again.id
    throw eFirst instanceof Error ? eFirst : new Error(String(eFirst))
  }
}

function runProvisionCli(
  workdir: string,
  env: NodeJS.ProcessEnv,
  forgeDeveloperSpaceIdForRegister?: string,
): { exit: number; out: string } {
  if (env.FORGE_PROVISION_DRY_RUN === "1") {
    return { exit: 0, out: "dry run ok\n" }
  }
  try {
    const idArg = forgeDeveloperSpaceIdForRegister?.trim()
    const argv = idArg?.length ? [cliPath, idArg] : [cliPath]
    execFileSync(process.execPath, argv, {
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
    const operatorEmail = (row.forgeOperatorEmail ?? "").trim()
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
    if (!operatorEmail) {
      log.error({
        step: "forge-provision.validate-config",
        message:
          "Missing forge operator email for headless Forge CLI (FORGE_EMAIL) — refusing provision",
        orgId: input.orgId,
        connectionId: input.connectionId,
        runLabel,
      })
      await patchForgeConnectionTypedConfig(input.orgId, input.connectionId, {
        provisionStatus: "failed",
        provisionErrorCode: "forge_missing_operator_email",
        provisionStderr:
          "Missing forgeOperatorEmail; required with Forge API token for CLI login",
        lastProvisionAt: new Date().toISOString(),
      })
      return {
        ok: false as const,
        code: "forge_missing_operator_email" as const,
      }
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

    const existingAppId = (row.appId ?? "").trim()
    const ensureDevSpaceResult = await step.run(
      { name: "ensure-forge-developer-space" },
      async (): Promise<
        | { status: "skip" }
        | { status: "ok"; developerSpaceId: string }
        | {
            status: "failed"
            code: "forge_developer_space_ensure_failed"
            stderr: string
          }
      > => {
        if (existingAppId.length > 0 || dryRun) {
          return { status: "skip" }
        }
        try {
          const developerSpaceId = await ensureCtxpipeForgeDeveloperSpaceId({
            operatorEmail,
            apiToken: token as string,
          })
          log.info({
            step: "forge-provision.ensure-developer-space",
            message:
              "Ensured Ctxpipe Forge Developer Space for headless register (-s)",
            connectionId: input.connectionId,
            developerSpaceId,
            runLabel,
            dryRun,
          })
          return { status: "ok", developerSpaceId }
        } catch (e: unknown) {
          const stderr = e instanceof Error ? e.message : String(e)
          const code = "forge_developer_space_ensure_failed" as const
          log.error({
            step: "forge-provision.ensure-developer-space-failed",
            message:
              "Could not list or create Forge Developer Space via GraphQL",
            connectionId: input.connectionId,
            runLabel,
            errPreview: stderr.slice(0, 800),
            dryRun,
          })
          await patchForgeConnectionTypedConfig(
            input.orgId,
            input.connectionId,
            {
              provisionStatus: "failed",
              provisionErrorCode: code,
              provisionStderr: stderr.slice(0, 8_000),
              lastProvisionAt: new Date().toISOString(),
            },
          )
          return { status: "failed", code, stderr }
        }
      },
    )

    if (ensureDevSpaceResult.status === "failed") {
      const message = userMessageForProvisionError(
        ensureDevSpaceResult.code,
      )
      log.error({
        step: "forge-provision.failed",
        message:
          "Forge provision failed inside ensure-forge-developer-space step",
        connectionId: input.connectionId,
        runLabel,
        provisionErrorCode: ensureDevSpaceResult.code,
        userMessage: message,
        dryRun,
      })
      return {
        ok: false as const,
        code: ensureDevSpaceResult.code,
        message,
      }
    }

    const developerSpaceIdForRegister =
      ensureDevSpaceResult.status === "ok"
        ? ensureDevSpaceResult.developerSpaceId
        : undefined

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
      const r = runProvisionCli(
        workdir,
        {
          FORGE_API_TOKEN: token,
          CONFLUENCE_SITE: site,
          FORGE_APP_NAME: appSlug,
          EXISTING_APP_ID: row.appId ?? "",
          FORGE_PROVISION_DRY_RUN: process.env.FORGE_PROVISION_DRY_RUN ?? "0",
          FORGE_EMAIL: operatorEmail,
        },
        developerSpaceIdForRegister,
      )
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
      forgeOperatorEmail: operatorEmail,
      forgeScopedApiTokenLengthChars: typeof token === "string" ? token.length : 0,
      cliExitCode: result.exit,
      cliElapsedMs: result.elapsedMs,
      stderrPreview: result.out.slice(0, STDERR_LOG_PREVIEW_CHARS),
      dryRun,
    })
    return { ok: false as const, code, message }
  },
)
