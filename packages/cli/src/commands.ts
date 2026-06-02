import { stdin as input, stdout as output } from "node:process"
import { intro, log, note, outro, tasks } from "@clack/prompts"
import { CLIENTS, CLIENT_COMMANDS, CLIENT_LABELS } from "./constants.js"
import { packageVersion } from "./version.js"
import type { Client } from "./constants.js"
import {
  fetchSession,
  loginWithDeviceFlow,
  readStoredAuth,
  removeStoredAuth,
  resolveCtxpipeBaseUrl,
  sessionUser,
  userLabel,
} from "./auth.js"
import { applyOperation, applyOperations } from "./fs-operations.js"
import type { ApplyOperationResult } from "./fs-operations.js"
import {
  buildClaudeHooksOperation,
  buildCtxpipeConfigOperation,
  buildMcpOperations,
  buildMemoryArtifactOperations,
  createOperationContext,
  validateClients,
  validateScope,
  type Operation,
} from "./mcp/mcp-operations.js"
import { normalizeBaseUrl } from "./mcp/paths.js"
import { promptConfirm, promptInitWizard, promptMcpWizard } from "./prompts.js"
import { commandExists } from "./system.js"
import { describeAppliedItem, describeOperation, brandName, printDoctorTable, writeResult } from "./ui.js"

export function isInteractive(opts: {
  nonInteractive?: boolean
  json?: boolean
}): boolean {
  return !opts.nonInteractive && !opts.json && input.isTTY && output.isTTY
}

export type InitRunOpts = {
  baseUrl: string
  org?: string
  scope?: string
  agents: string[]
  dryRun: boolean
  json: boolean
  nonInteractive: boolean
  mcp: boolean
  /** Tri-state: true = always enable, false = always skip, undefined = ask in interactive mode. */
  memory?: boolean
  /** Install Claude Code SessionStart/Stop hooks for memory automation. */
  claudeHooks?: boolean
}

export type McpAddRunOpts = {
  baseUrl: string
  org?: string
  scope?: string
  clients: string[]
  dryRun: boolean
  json: boolean
  nonInteractive: boolean
}

export async function runInit(opts: InitRunOpts): Promise<void> {
  const interactive = isInteractive(opts)
  const answers: {
    org: string | null
    baseUrl: string
    agents: string[]
    scope: string | null
    nonInteractive: boolean
    dryRun: boolean
    json: boolean
    mcp: boolean
    memory: boolean | undefined
  } = {
    org: opts.org ?? null,
    baseUrl: opts.baseUrl,
    agents: [...opts.agents],
    scope: opts.scope ?? null,
    nonInteractive: opts.nonInteractive,
    dryRun: opts.dryRun,
    json: opts.json,
    mcp: opts.mcp,
    memory: opts.memory,
  }

  if (interactive) {
    Object.assign(answers, await promptInitWizard(answers))
  } else {
    if (!answers.org) throw new Error("Missing --org for non-interactive init")
    if (!answers.scope) throw new Error("Missing --scope for non-interactive init")
    if (answers.agents.length === 0 && answers.mcp) {
      throw new Error("Missing --agents for non-interactive init")
    }
  }

  const org = answers.org
  const scope = answers.scope
  const agents = answers.agents
  if (!org) throw new Error("Missing --org")
  if (!scope) throw new Error("Missing --scope")
  validateScope(scope)
  validateClients(agents)
  // In non-interactive mode an unspecified --memory means "do not enable".
  const memoryEnabled = answers.memory === true

  const context = createOperationContext({ commandExists })
  const ctxpipeConfig = buildCtxpipeConfigOperation({
    baseUrl: answers.baseUrl,
    org,
    context,
  })
  const mcpOps = answers.mcp
    ? buildMcpOperations({
        clients: agents,
        baseUrl: answers.baseUrl,
        org,
        scope,
        memory: memoryEnabled,
        context,
      })
    : []
  const memoryOps = memoryEnabled ? buildMemoryArtifactOperations({ context }) : []
  const claudeHookOps =
    memoryEnabled && opts.claudeHooks && agents.includes("claude")
      ? [buildClaudeHooksOperation({ context })]
      : []
  const operations = [ctxpipeConfig, ...mcpOps, ...memoryOps, ...claudeHookOps]

  await confirmAndApply({
    operations,
    json: opts.json,
    nonInteractive: opts.nonInteractive,
    interactive,
    dryRun: answers.dryRun,
    introShown: interactive,
    setupSummary: [
      `Organization ${org}`,
      `Scope ${scopeLabel(scope)}`,
      `Agents ${agentsLabel(agents, answers.mcp)}`,
      `Memory ${memoryEnabled ? "enabled (local AgentMemory + .ai/memory)" : "disabled"}`,
    ],
  })
}

export async function runAuthLogin(opts: { baseUrl: string }): Promise<void> {
  const baseUrl = resolveCtxpipeBaseUrl(process.cwd(), opts.baseUrl)
  const auth = await loginWithDeviceFlow({ baseUrl })
  const session = await fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(
    () => null,
  )
  log.success(`Signed in as ${userLabel(session) ?? "ctx|"}.`)
}

export async function runAuthWhoami(opts: { baseUrl: string; json: boolean }): Promise<void> {
  const baseUrl = resolveCtxpipeBaseUrl(process.cwd(), opts.baseUrl)
  const auth = await readStoredAuth(baseUrl)
  if (!auth) {
    const result = { status: "signed-out", baseUrl: normalizeBaseUrl(baseUrl) }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    log.warn("Not signed in.")
    return
  }
  const session = await fetchSession({ baseUrl, accessToken: auth.accessToken })
  const result = {
    status: "ok",
    baseUrl: normalizeBaseUrl(baseUrl),
    user: sessionUser(session),
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  log.success(`Signed in as ${userLabel(session) ?? "ctx|"}.`)
}

export async function runAuthLogout(opts: { baseUrl: string; json: boolean }): Promise<void> {
  const baseUrl = resolveCtxpipeBaseUrl(process.cwd(), opts.baseUrl)
  await removeStoredAuth(baseUrl)
  const result = { status: "ok", baseUrl: normalizeBaseUrl(baseUrl) }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  log.success("Signed out.")
}

export async function runMcpAdd(opts: McpAddRunOpts): Promise<void> {
  const interactive = isInteractive(opts)
  const values = {
    org: opts.org ?? null,
    baseUrl: opts.baseUrl,
    clients: [...opts.clients],
    scope: opts.scope ?? null,
    dryRun: opts.dryRun,
  }

  if (interactive) {
    Object.assign(values, await promptMcpWizard(values))
  } else {
    if (!values.org) throw new Error("Missing --org for non-interactive mcp add")
    if (!values.scope) throw new Error("Missing --scope for non-interactive mcp add")
    if (values.clients.length === 0) {
      throw new Error("Missing --client for non-interactive mcp add")
    }
  }

  const org = values.org
  const scope = values.scope
  const clients = values.clients
  if (!org) throw new Error("Missing --org")
  if (!scope) throw new Error("Missing --scope")
  validateScope(scope)
  validateClients(clients)

  const operations = buildMcpOperations({
    clients,
    baseUrl: values.baseUrl,
    org,
    scope,
    context: createOperationContext({ commandExists }),
  })
  // mcp add does not toggle memory; users opt-in through `ctxpipe memory init`.

  await confirmAndApply({
    operations,
    json: opts.json,
    nonInteractive: opts.nonInteractive,
    interactive,
    dryRun: values.dryRun,
    introShown: interactive,
    setupSummary: [
      `Organization ${org}`,
      `Scope ${scopeLabel(scope)}`,
      `Agents ${agentsLabel(clients, true)}`,
    ],
  })
}

export function runDoctor(opts: { json: boolean }): void {
  const data = {
    version: packageVersion,
    node: process.version,
    cwd: process.cwd(),
    package: "ctxpipe",
    detectedClients: Object.fromEntries(
      CLIENTS.map((client) => [client, commandExists(CLIENT_COMMANDS[client])]),
    ) as Record<Client, boolean>,
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  printDoctorTable(data)
}

export type ConfirmAndApplyOpts = {
  operations: Operation[]
  json: boolean
  nonInteractive: boolean
  interactive: boolean
  dryRun: boolean
  introShown: boolean
  setupSummary?: string[]
  successMessage?: string
  outroMessage?: string
}

export async function confirmAndApply({
  operations,
  json,
  nonInteractive,
  interactive,
  dryRun,
  introShown,
  setupSummary,
  successMessage = "ctxpipe is connected",
  outroMessage = "Setup complete.",
}: ConfirmAndApplyOpts): Promise<void> {
  if (operations.length === 0) {
    writeResult(json, { status: "noop", operations: [] })
    return
  }

  const summary = operations.map(describeOperation)
  if (json) {
    if (!dryRun && !nonInteractive) {
      throw new Error("Refusing to apply changes without --non-interactive in JSON mode")
    }
    const result = dryRun
      ? { status: "dry-run", operations: summary }
      : applyOperations(operations)
    writeResult(json, result)
    return
  }

  if (!introShown) {
    intro(`${brandName()} setup`)
  }
  if (setupSummary && setupSummary.length > 0) {
    note(setupSummary.join("\n"), "Setup choices")
  }
  note(
    operations.map((op) => `+ ${describeOperation(op)}`).join("\n"),
    dryRun ? "Planned changes" : "Ready to apply",
  )

  if (dryRun) {
    outro("Dry run complete. No files or client configs were changed.")
    return
  }

  if (!nonInteractive) {
    if (!interactive) {
      throw new Error(
        "Refusing to apply changes without --non-interactive in non-interactive mode",
      )
    }
    const ok = await promptConfirm("Apply these changes?", true)
    if (!ok) {
      outro("No changes made.")
      return
    }
  }

  const applied: ApplyOperationResult[] = []
  await tasks(
    operations.map((op) => ({
      title: describeOperation(op),
      task: () => {
        const result = applyOperation(op)
        applied.push(result)
        return describeAppliedItem(result)
      },
    })),
  )
  if (applied.some((item) => item.status === "manual")) {
    note(applied.map(describeAppliedItem).join("\n"), "Manual follow-up")
  }
  log.success(successMessage)
  log.info("Your agents may ask you to approve ctx| the first time they use MCP.")
  outro(outroMessage)
}

function scopeLabel(scope: string): string {
  if (scope === "repo") return "This repo"
  if (scope === "user") return "Globally"
  if (scope === "both") return "This repo and globally"
  return scope
}

function agentsLabel(clients: string[], mcpEnabled: boolean): string {
  if (!mcpEnabled) return "MCP disabled"
  if (clients.length === 0) return "None selected"
  return clients
    .map((client) => CLIENT_LABELS[client as Client] ?? client)
    .join(", ")
}
