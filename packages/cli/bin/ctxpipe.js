#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { stdin as input, stdout as output } from "node:process"
import prompts from "prompts"

const VERSION = "0.1.0-alpha.1"
const DEFAULT_BASE_URL = "https://app.ctxpipe.ai"
const CLIENTS = ["codex", "claude", "cursor", "opencode", "vscode"]

const CLIENT_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  vscode: "VS Code / Copilot",
}

const CLIENT_COMMANDS = {
  codex: "codex",
  claude: "claude",
  cursor: "cursor",
  opencode: "opencode",
  vscode: "code",
}

const args = process.argv.slice(2)

main(args).catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`ctxpipe: ${message}`)
  process.exitCode = 1
})

async function main(rawArgs) {
  const parsed = parseArgs(rawArgs)
  const [command, subcommand] = parsed.positionals

  if (parsed.flags.help || command === undefined) {
    printHelp()
    return
  }
  if (parsed.flags.version) {
    console.log(VERSION)
    return
  }

  switch (command) {
    case "init":
      await runInit(parsed)
      return
    case "doctor":
      runDoctor(parsed)
      return
    case "mcp":
      if (subcommand === "add") {
        await runMcpAdd(parsed)
        return
      }
      printMcpHelp()
      process.exitCode = 1
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

async function runInit(parsed) {
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

  validateScope(answers.scope)
  validateClients(answers.agents)

  const ctxpipeConfig = buildCtxpipeConfigOperation({
    baseUrl: answers.baseUrl,
    org: answers.org,
    clients: answers.agents,
  })
  const mcpOps = answers.mcp
    ? buildMcpOperations({
        clients: answers.agents,
        baseUrl: answers.baseUrl,
        org: answers.org,
        scope: answers.scope,
      })
    : []
  const operations = [ctxpipeConfig, ...mcpOps]

  await confirmAndApply({ operations, parsed, interactive, dryRun: answers.dryRun })
}

async function runMcpAdd(parsed) {
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

  validateScope(values.scope)
  validateClients(values.clients)

  const operations = buildMcpOperations({
    clients: values.clients,
    baseUrl: values.baseUrl,
    org: values.org,
    scope: values.scope,
  })

  await confirmAndApply({ operations, parsed, interactive, dryRun: values.dryRun })
}

function runDoctor(parsed) {
  const data = {
    version: VERSION,
    node: process.version,
    cwd: process.cwd(),
    package: "ctxpipe",
    detectedClients: Object.fromEntries(
      CLIENTS.map((client) => [client, commandExists(CLIENT_COMMANDS[client])]),
    ),
  }

  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(`ctxpipe ${data.version}`)
  console.log(`node ${data.node}`)
  console.log(`cwd ${data.cwd}`)
  console.log("")
  console.log("Detected clients:")
  for (const client of CLIENTS) {
    const found = data.detectedClients[client] ? "yes" : "no"
    console.log(`  ${CLIENT_LABELS[client]}: ${found}`)
  }
}

async function confirmAndApply({ operations, parsed, interactive, dryRun }) {
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

  console.log("ctxpipe will:")
  for (const line of summary) console.log(`  - ${line}`)

  if (dryRun) {
    console.log("")
    console.log("Dry run only. No files or client configs were changed.")
    return
  }

  if (!boolFlag(parsed, "yes")) {
    if (!interactive) {
      throw new Error("Refusing to apply changes without --yes in non-interactive mode")
    }
    const ok = await promptConfirm("Apply these changes?", true)
    if (!ok) {
      console.log("No changes made.")
      return
    }
  }

  const result = applyOperations(operations)
  for (const item of result.operations) {
    if (item.status === "manual") console.log(`Manual step: ${item.detail}`)
    if (item.status === "ran") console.log(`Ran: ${item.detail}`)
    if (item.status === "written") console.log(`Wrote: ${item.path}`)
    if (item.status === "unchanged") console.log(`Already up to date: ${item.path}`)
  }
}

function applyOperations(operations) {
  const results = []
  for (const op of operations) {
    if (op.type === "write-json") {
      const next = `${JSON.stringify(op.content(), null, 2)}\n`
      const previous = existsSync(op.path) ? readFileSync(op.path, "utf8") : null
      if (previous === next) {
        results.push({ status: "unchanged", path: op.path })
        continue
      }
      mkdirSync(dirname(op.path), { recursive: true })
      writeFileSync(op.path, next, "utf8")
      results.push({ status: "written", path: op.path })
      continue
    }
    if (op.type === "run") {
      const result = spawnSync(op.command[0], op.command.slice(1), {
        encoding: "utf8",
        stdio: "pipe",
      })
      if (result.status !== 0) {
        throw new Error(
          `${op.command.join(" ")} failed: ${result.stderr || result.stdout}`,
        )
      }
      results.push({ status: "ran", detail: op.command.join(" ") })
      continue
    }
    if (op.type === "manual") {
      results.push({ status: "manual", detail: op.detail })
    }
  }
  return { status: "ok", operations: results }
}

function buildCtxpipeConfigOperation({ baseUrl, org, clients }) {
  const configPath = resolve(process.cwd(), ".ctxpipe", "config.json")
  return {
    type: "write-json",
    path: configPath,
    description: `write repo ctxpipe config at ${relative(configPath)}`,
    content() {
      const existing = readJsonObject(configPath)
      return {
        ...existing,
        orgSlug: org,
        baseUrl: normalizeBaseUrl(baseUrl),
        mcp: {
          ...(isObject(existing.mcp) ? existing.mcp : {}),
          url: mcpUrl({ baseUrl, org }),
          clients,
        },
      }
    },
  }
}

function buildMcpOperations({ clients, baseUrl, org, scope }) {
  return clients.flatMap((client) =>
    scopesFor(scope).flatMap((singleScope) =>
      buildClientOperations({ client, baseUrl, org, scope: singleScope }),
    ),
  )
}

function buildClientOperations({ client, baseUrl, org, scope }) {
  const url = mcpUrl({ baseUrl, org })
  switch (client) {
    case "cursor":
      return [
        writeMcpServersOperation({
          path:
            scope === "user"
              ? join(homedir(), ".cursor", "mcp.json")
              : resolve(process.cwd(), ".cursor", "mcp.json"),
          url,
          label: "Cursor",
        }),
      ]
    case "claude":
      if (scope === "user" && commandExists("claude")) {
        return [
          {
            type: "run",
            command: ["claude", "mcp", "add", "ctxpipe", "--transport", "http", url],
            description: "run Claude Code MCP add command",
          },
        ]
      }
      return [
        writeMcpServersOperation({
          path: resolve(process.cwd(), ".mcp.json"),
          url,
          label: "Claude Code project",
        }),
      ]
    case "opencode":
      return [
        writeOpenCodeOperation({
          path:
            scope === "user"
              ? join(homedir(), ".config", "opencode", "opencode.json")
              : resolve(process.cwd(), "opencode.json"),
          url,
        }),
      ]
    case "vscode":
      if (scope === "user") {
        return [
          {
            type: "manual",
            description: "open VS Code MCP install link",
            detail: `Open vscode:mcp/install?${encodeURIComponent(
              JSON.stringify({ name: "ctxpipe", type: "http", url }),
            )}`,
          },
        ]
      }
      return [
        writeVsCodeOperation({
          path: resolve(process.cwd(), ".vscode", "mcp.json"),
          url,
        }),
      ]
    case "codex":
      if (scope === "user" && commandExists("codex")) {
        return [
          {
            type: "run",
            command: ["codex", "mcp", "add", "ctxpipe", "--url", url],
            description: "run Codex MCP add command",
          },
        ]
      }
      return [
        {
          type: "manual",
          description: "show Codex MCP add command",
          detail: `Run: codex mcp add ctxpipe --url ${url}`,
        },
      ]
    default:
      throw new Error(`Unsupported client: ${client}`)
  }
}

function writeMcpServersOperation({ path, url, label }) {
  return {
    type: "write-json",
    path,
    description: `configure ${label} MCP at ${relative(path)}`,
    content() {
      const existing = readJsonObject(path)
      return {
        ...existing,
        mcpServers: {
          ...(isObject(existing.mcpServers) ? existing.mcpServers : {}),
          ctxpipe: {
            type: "streamable-http",
            url,
          },
        },
      }
    },
  }
}

function writeOpenCodeOperation({ path, url }) {
  return {
    type: "write-json",
    path,
    description: `configure OpenCode MCP at ${relative(path)}`,
    content() {
      const existing = readJsonObject(path)
      return {
        ...existing,
        mcp: {
          ...(isObject(existing.mcp) ? existing.mcp : {}),
          ctxpipe: {
            type: "remote",
            url,
            enabled: true,
          },
        },
      }
    },
  }
}

function writeVsCodeOperation({ path, url }) {
  return {
    type: "write-json",
    path,
    description: `configure VS Code MCP at ${relative(path)}`,
    content() {
      const existing = readJsonObject(path)
      return {
        ...existing,
        servers: {
          ...(isObject(existing.servers) ? existing.servers : {}),
          ctxpipe: {
            type: "http",
            url,
          },
        },
      }
    },
  }
}

function readJsonObject(path) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function describeOperation(op) {
  if (op.description) return op.description
  if (op.type === "write-json") return `write ${relative(op.path)}`
  if (op.type === "run") return `run ${op.command.join(" ")}`
  return op.detail
}

function writeResult(parsed, result) {
  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(result.status)
}

function mcpUrl({ baseUrl, org }) {
  const url = new URL("/mcp", normalizeBaseUrl(baseUrl))
  url.searchParams.set("orgSlug", org)
  return url.toString()
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "")
}

function scopesFor(scope) {
  if (scope === "both") return ["repo", "user"]
  return [scope]
}

function validateScope(scope) {
  if (!["repo", "user", "both"].includes(scope)) {
    throw new Error("--scope must be one of: repo, user, both")
  }
}

function validateClients(clients) {
  for (const client of clients) {
    if (!CLIENTS.includes(client)) {
      throw new Error(`Unsupported client "${client}". Use: ${CLIENTS.join(", ")}`)
    }
  }
}

function parseClientFlags(parsed) {
  const client = parseListFlag(parsed, "client")
  return client.length > 0 ? client : parseListFlag(parsed, "clients")
}

function parseListFlag(parsed, name) {
  const value = parsed.flags[name]
  if (value == null || value === true || value === false) return []
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((item) =>
    String(item)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
}

function stringFlag(parsed, name) {
  const value = parsed.flags[name]
  if (value == null || value === true || value === false) return null
  return Array.isArray(value) ? String(value.at(-1)) : String(value)
}

function boolFlag(parsed, name) {
  return parsed.flags[name] === true || parsed.flags[name] === "true"
}

function parseBoolish(value, fallback) {
  if (value == null) return fallback
  if (value === true || value === "true" || value === "yes") return true
  if (value === false || value === "false" || value === "no") return false
  return fallback
}

function parseArgs(rawArgs) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg === "--") {
      positionals.push(...rawArgs.slice(i + 1))
      break
    }
    if (arg === "-h") {
      flags.help = true
      continue
    }
    if (arg === "-y") {
      flags.yes = true
      continue
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2)
    const name = normalizeFlagName(rawName)
    const next = rawArgs[i + 1]
    const value =
      inlineValue !== undefined
        ? inlineValue
        : next && !next.startsWith("-")
          ? rawArgs[++i]
          : true
    if (flags[name] === undefined) {
      flags[name] = value
    } else if (Array.isArray(flags[name])) {
      flags[name].push(value)
    } else {
      flags[name] = [flags[name], value]
    }
  }
  return { flags, positionals }
}

function normalizeFlagName(name) {
  switch (name) {
    case "agent":
      return "agents"
    case "clients":
      return "client"
    default:
      return name
  }
}

function isInteractive(parsed) {
  return !boolFlag(parsed, "yes") && !boolFlag(parsed, "json") && input.isTTY && output.isTTY
}

async function promptInitWizard(current) {
  printWizardHeader("Initialize ctx|")
  console.log(
    "This will prepare the current repo and optionally connect your agent clients to ctx| MCP.",
  )
  console.log("")

  const answers = {}
  if (!current.org) {
    answers.org = await promptText({
      message: "Which ctx| organization should this repo use?",
      initial: detectDefaultOrgSlug(),
    })
  }
  if (!current.scope) {
    answers.scope = await promptSelect({
      message: "Where should ctxpipe apply setup?",
      initial: "repo",
      choices: [
        {
          title: "This repo",
          value: "repo",
          description: "Write project files such as .ctxpipe/config.json and MCP config.",
        },
        {
          title: "Globally",
          value: "user",
          description: "Configure supported clients for your whole machine when possible.",
        },
        {
          title: "Both",
          value: "both",
          description: "Set up this repo and your user-level client config.",
        },
      ],
    })
  }
  const shouldConfigureMcp = answers.mcp ?? current.mcp
  if (shouldConfigureMcp && current.agents.length === 0) {
    answers.agents = await promptAgents()
  }

  return answers
}

async function promptMcpWizard(current) {
  printWizardHeader("Add ctx| MCP")
  console.log("Choose the clients ctxpipe should configure for this machine or repo.")
  console.log("")

  const answers = {}
  if (!current.org) {
    answers.org = await promptText({
      message: "Which ctx| organization should this MCP server use?",
      initial: detectDefaultOrgSlug(),
    })
  }
  if (!current.scope) {
    answers.scope = await promptSelect({
      message: "Where should ctxpipe configure MCP?",
      initial: "repo",
      choices: [
        { title: "This repo", value: "repo" },
        { title: "Globally", value: "user" },
        { title: "Both", value: "both" },
      ],
    })
  }
  if (current.clients.length === 0) {
    answers.clients = await promptAgents()
  }
  return answers
}

async function promptAgents() {
  const detected = CLIENTS.filter((client) => commandExists(CLIENT_COMMANDS[client]))
  const agents = await prompts(
    {
      type: "multiselect",
      name: "value",
      message: "Which agents should use ctx|?",
      hint: "space to select, enter to continue",
      instructions: false,
      min: 1,
      choices: CLIENTS.map((client) => ({
        title: CLIENT_LABELS[client],
        value: client,
        selected: detected.includes(client),
        description: detected.includes(client)
          ? "Detected on this machine"
          : "Not detected, but ctxpipe can still write project config",
      })),
    },
    promptOptions(),
  )
  return agents.value
}

async function promptText({ message, initial }) {
  const answer = await prompts(
    {
      type: "text",
      name: "value",
      message,
      initial,
      validate: (value) => (String(value).trim() ? true : "Required"),
    },
    promptOptions(),
  )
  return String(answer.value).trim()
}

function detectDefaultOrgSlug() {
  const existing = readJsonObject(resolve(process.cwd(), ".ctxpipe", "config.json"))
  if (typeof existing.orgSlug === "string" && existing.orgSlug.trim()) {
    return existing.orgSlug
  }
  return process.env.CTXPIPE_ORG_SLUG || process.env.CTXPIPE_ORG || undefined
}

async function promptSelect({ message, choices, initial }) {
  const answer = await prompts(
    {
      type: "select",
      name: "value",
      message,
      initial: Math.max(
        choices.findIndex((choice) => choice.value === initial),
        0,
      ),
      choices,
    },
    promptOptions(),
  )
  return answer.value
}

async function promptConfirm(message, initial) {
  const answer = await prompts(
    {
      type: "confirm",
      name: "value",
      message,
      initial,
    },
    promptOptions(),
  )
  return answer.value
}

function promptOptions() {
  return {
    onCancel() {
      throw new Error("Setup cancelled")
    },
  }
}

function printWizardHeader(title) {
  console.log("")
  console.log(`ctxpipe - ${title}`)
  console.log("=".repeat(`ctxpipe - ${title}`.length))
  console.log("")
}

function commandExists(command) {
  if (!command) return false
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  })
  if (result.error?.code === "ENOENT") return false
  return result.status === 0 || result.status === 1
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function relative(path) {
  const cwd = process.cwd()
  return path.startsWith(cwd) ? path.slice(cwd.length + 1) : path
}

function printHelp() {
  console.log(`ctxpipe ${VERSION}

Usage:
  ctxpipe init [--org <slug>] [--agents <list>] [--scope repo|user|both]
  ctxpipe mcp add --org <slug> --client <name> --scope repo|user|both
  ctxpipe doctor [--json]

Human setup:
  npx ctxpipe init

Agent/CI setup:
  npx ctxpipe init --org acme --agents codex,claude --scope repo --yes

Options:
  --base-url <url>   ctx| base URL (default: ${DEFAULT_BASE_URL})
  --dry-run          Show planned changes without writing files
  --json             Print machine-readable output where supported
  --yes, -y          Do not prompt; required for non-interactive runs
  --help, -h         Show help
  --version          Show version
`)
}

function printInitHelp() {
  console.log(`ctxpipe init

Initialize the current repo or user environment for ctx|.

Examples:
  ctxpipe init
  ctxpipe init --org acme --agents codex,claude --scope repo --yes
  ctxpipe init --org acme --agents cursor --scope user --dry-run
`)
}

function printMcpHelp() {
  console.log(`ctxpipe mcp

Usage:
  ctxpipe mcp add --org <slug> --client <name> --scope repo|user|both
`)
}

function printMcpAddHelp() {
  console.log(`ctxpipe mcp add

Configure ctx| MCP for one or more clients.

Examples:
  ctxpipe mcp add --org acme --client cursor --scope repo --yes
  ctxpipe mcp add --org acme --client claude,codex --scope user --dry-run

Supported clients:
  ${CLIENTS.join(", ")}
`)
}
