import { intro, log, note, outro } from "@clack/prompts"
import { DEFAULT_BASE_URL, VERSION, CLIENTS, CLIENT_COMMANDS } from "./constants.js"
import type { Client } from "./constants.js"
import {
  boolFlag,
  isInteractive,
  parseBoolish,
  parseClientFlags,
  parseListFlag,
  stringFlag,
  type ParsedArgs,
} from "./args.js"
import {
  fetchSession,
  loginWithDeviceFlow,
  readStoredAuth,
  removeStoredAuth,
  sessionUser,
  userLabel,
} from "./auth.js"
import { applyOperations } from "./fs-operations.js"
import {
  buildCtxpipeConfigOperation,
  buildMcpOperations,
  createOperationContext,
  validateClients,
  validateScope,
  type Operation,
} from "./mcp/mcp-operations.js"
import { normalizeBaseUrl } from "./mcp/paths.js"
import { promptConfirm, promptInitWizard, promptMcpWizard } from "./prompts.js"
import { commandExists } from "./system.js"
import {
  describeAppliedItem,
  describeOperation,
  describeOperationStyled,
  printAuthHelp,
  printDoctorTable,
  printHelp,
  printInitHelp,
  printMcpAddHelp,
  printMcpHelp,
  writeResult,
} from "./ui.js"

export async function dispatch(parsed: ParsedArgs): Promise<void> {
  const [command, subcommand] = parsed.positionals

  if (parsed.flags.version) {
    console.log(VERSION)
    return
  }
  if (command === undefined) {
    printHelp()
    return
  }

  switch (command) {
    case "init":
      await runInit(parsed)
      return
    case "doctor":
      runDoctor(parsed)
      return
    case "auth":
      if (parsed.flags.help) {
        printAuthHelp()
        return
      }
      if (subcommand === "login") {
        await runAuthLogin(parsed)
        return
      }
      if (subcommand === "whoami") {
        await runAuthWhoami(parsed)
        return
      }
      if (subcommand === "logout") {
        runAuthLogout(parsed)
        return
      }
      printAuthHelp()
      process.exitCode = 1
      return
    case "mcp":
      if (subcommand === "add") {
        await runMcpAdd(parsed)
        return
      }
      if (parsed.flags.help) {
        printMcpHelp()
        return
      }
      printMcpHelp()
      process.exitCode = 1
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

async function runInit(parsed: ParsedArgs): Promise<void> {
  if (parsed.flags.help) {
    printInitHelp()
    return
  }

  const interactive = isInteractive(parsed)
  const answers = {
    org: stringFlag(parsed, "org"),
    baseUrl: stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL,
    agents: [...parseListFlag(parsed, "agents"), ...parseListFlag(parsed, "client")],
    scope: stringFlag(parsed, "scope"),
    yes: boolFlag(parsed, "yes"),
    dryRun: boolFlag(parsed, "dry-run"),
    json: boolFlag(parsed, "json"),
    mcp: parseBoolish(parsed.flags.mcp, true),
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

  const context = createOperationContext({ commandExists })
  const ctxpipeConfig = buildCtxpipeConfigOperation({
    baseUrl: answers.baseUrl,
    org,
    clients: agents,
    context,
  })
  const mcpOps = answers.mcp
    ? buildMcpOperations({
        clients: agents,
        baseUrl: answers.baseUrl,
        org,
        scope,
        context,
      })
    : []
  const operations = [ctxpipeConfig, ...mcpOps]

  await confirmAndApply({ operations, parsed, interactive, dryRun: answers.dryRun })
}

async function runAuthLogin(parsed: ParsedArgs): Promise<void> {
  if (boolFlag(parsed, "json")) {
    throw new Error("auth login is interactive; omit --json")
  }
  const baseUrl = stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL
  const auth = await loginWithDeviceFlow({ baseUrl })
  const session = await fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(
    () => null,
  )
  log.success(`Signed in as ${userLabel(session) ?? "ctx|"}.`)
}

async function runAuthWhoami(parsed: ParsedArgs): Promise<void> {
  const baseUrl = stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL
  const auth = readStoredAuth(baseUrl)
  if (!auth) {
    const result = { status: "signed-out", baseUrl: normalizeBaseUrl(baseUrl) }
    if (boolFlag(parsed, "json")) {
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
  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  log.success(`Signed in as ${userLabel(session) ?? "ctx|"}.`)
}

function runAuthLogout(parsed: ParsedArgs): void {
  const baseUrl = stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL
  removeStoredAuth(baseUrl)
  const result = { status: "ok", baseUrl: normalizeBaseUrl(baseUrl) }
  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  log.success("Signed out.")
}

async function runMcpAdd(parsed: ParsedArgs): Promise<void> {
  if (parsed.flags.help) {
    printMcpAddHelp()
    return
  }

  const interactive = isInteractive(parsed)
  const values = {
    org: stringFlag(parsed, "org"),
    baseUrl: stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL,
    clients: parseClientFlags(parsed),
    scope: stringFlag(parsed, "scope"),
    dryRun: boolFlag(parsed, "dry-run"),
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

  await confirmAndApply({ operations, parsed, interactive, dryRun: values.dryRun })
}

function runDoctor(parsed: ParsedArgs): void {
  const data = {
    version: VERSION,
    node: process.version,
    cwd: process.cwd(),
    package: "ctxpipe",
    detectedClients: Object.fromEntries(
      CLIENTS.map((client) => [client, commandExists(CLIENT_COMMANDS[client])]),
    ) as Record<Client, boolean>,
  }

  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  printDoctorTable(data)
}

async function confirmAndApply({
  operations,
  parsed,
  interactive,
  dryRun,
}: {
  operations: Operation[]
  parsed: ParsedArgs
  interactive: boolean
  dryRun: boolean
}): Promise<void> {
  if (operations.length === 0) {
    writeResult(parsed, { status: "noop", operations: [] })
    return
  }

  const summary = operations.map(describeOperation)
  if (boolFlag(parsed, "json")) {
    if (!dryRun && !boolFlag(parsed, "yes")) {
      throw new Error("Refusing to apply changes without --yes in JSON mode")
    }
    const result = dryRun
      ? { status: "dry-run", operations: summary }
      : applyOperations(operations)
    writeResult(parsed, result)
    return
  }

  intro("ctxpipe setup")
  note(
    operations.map((op) => `+ ${describeOperationStyled(op)}`).join("\n"),
    dryRun ? "Planned changes" : "Ready to apply",
  )

  if (dryRun) {
    outro("Dry run complete. No files or client configs were changed.")
    return
  }

  if (!boolFlag(parsed, "yes")) {
    if (!interactive) {
      throw new Error("Refusing to apply changes without --yes in non-interactive mode")
    }
    const ok = await promptConfirm("Apply these changes?", true)
    if (!ok) {
      log.warn("No changes made.")
      return
    }
  }

  const result = applyOperations(operations)
  log.message(result.operations.map(describeAppliedItem).join("\n"))
  log.success("ctxpipe is connected")
  log.info("Your agents may ask you to approve ctx| the first time they use MCP.")
  outro("Setup complete.")
}
