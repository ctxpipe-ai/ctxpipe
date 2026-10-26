import { confirmAndApply, isInteractive } from "../commands.js"
import type { Client } from "../constants.js"
import { CLIENT_LABELS } from "../constants.js"
import {
  buildMemoryArtifactOperations,
  buildMemoryConfigOperation,
  createOperationContext,
  validateClients,
  validateScope,
} from "../mcp/mcp-operations.js"
import { promptMemoryInitWizard } from "../prompts.js"
import { commandExists } from "../system.js"
import { buildMemoryHookOperations } from "./hooks.js"
import { buildMemoryUpgradeOperations } from "./upgrade.js"

type MemoryInitRunOpts = {
  baseUrl: string
  scope?: string
  agents: string[]
  dryRun: boolean
  json: boolean
  nonInteractive: boolean
}

export async function runMemoryInit(opts: MemoryInitRunOpts): Promise<void> {
  const interactive = isInteractive(opts)
  const answers: {
    agents: Client[]
    scope: string | null
    dryRun: boolean
  } = {
    agents: [...opts.agents] as Client[],
    scope: opts.scope ?? null,
    dryRun: opts.dryRun,
  }

  if (interactive) {
    const wizard = await promptMemoryInitWizard({
      agents: answers.agents,
      scope: answers.scope,
    })
    if (wizard.scope) answers.scope = wizard.scope
    if (wizard.agents) answers.agents = wizard.agents
  } else {
    if (answers.agents.length === 0) {
      throw new Error("Missing --agents for non-interactive memory init")
    }
    if (!answers.scope) answers.scope = "repo"
  }

  const scope = answers.scope
  const agents = answers.agents
  if (!scope) throw new Error("Missing --scope")
  validateScope(scope)
  validateClients(agents)

  const context = createOperationContext({ commandExists })
  const configOp = buildMemoryConfigOperation({
    baseUrl: opts.baseUrl,
    context,
  })
  const upgradeOps = buildMemoryUpgradeOperations({ context })
  const memoryOps = buildMemoryArtifactOperations({ context })
  const hookOps = buildMemoryHookOperations({
    clients: agents,
    scope,
    context,
  })
  const operations = [configOp, ...upgradeOps, ...memoryOps, ...hookOps]

  const modeLine =
    "Markdown-only memory — candidates via hooks; promote with capture skills"

  await confirmAndApply({
    operations,
    json: opts.json,
    nonInteractive: opts.nonInteractive,
    interactive,
    dryRun: answers.dryRun,
    introShown: interactive,
    setupSummary: [
      scopeLabel(scope),
      `Agents ${agents.map((a) => CLIENT_LABELS[a]).join(", ")}`,
      modeLine,
    ],
    successMessage: "Local memory is configured",
    outroMessage:
      "Memory setup complete. Restart the agent host to pick up hooks and rules.",
  })
}

function scopeLabel(scope: string): string {
  if (scope === "repo") return "Scope This repo"
  if (scope === "user") return "Scope Globally"
  if (scope === "both") return "Scope This repo and globally"
  return `Scope ${scope}`
}
