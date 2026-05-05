#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { stdin as input, stdout as output } from "node:process"
import {
  confirm as confirmPrompt,
  isCancel,
  multiselect,
  select,
  text,
} from "@clack/prompts"
import chalk from "chalk"

const VERSION = "0.1.0-alpha.1"
const DEFAULT_BASE_URL = "https://app.ctxpipe.ai"
const AUTH_CLIENT_ID = "ctxpipe-cli"
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const CLIENTS = ["codex", "claude", "cursor", "opencode", "vscode"]
const teal = chalk.hex("#2dd4bf")

const PIXEL_MARK = `
              ░██               
              ░██               
 ░███████  ░████████ ░██    ░██ 
░██    ░██    ░██     ░██  ░██  
░██           ░██      ░█████   
░██    ░██    ░██     ░██  ░██  
 ░███████      ░████ ░██    ░██ 
`
const PIXEL_PIPE = `
░██ 
░██ 
░██ 
░██ 
░██ 
░██ 
░██ 
░██ 
░██ 
`

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

async function runAuthLogin(parsed) {
  if (boolFlag(parsed, "json")) {
    throw new Error("auth login is interactive; omit --json")
  }
  const baseUrl = stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL
  const auth = await loginWithDeviceFlow({ baseUrl })
  const session = await fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(
    () => null,
  )
  const label =
    typeof session?.user?.email === "string"
      ? session.user.email
      : typeof session?.user?.name === "string"
        ? session.user.name
        : "ctx|"
  console.log(`Signed in as ${label}.`)
}

async function runAuthWhoami(parsed) {
  const baseUrl = stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL
  const auth = readStoredAuth(baseUrl)
  if (!auth) {
    const result = { status: "signed-out", baseUrl: normalizeBaseUrl(baseUrl) }
    if (boolFlag(parsed, "json")) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log("Not signed in.")
    return
  }
  const session = await fetchSession({ baseUrl, accessToken: auth.accessToken })
  const result = {
    status: "ok",
    baseUrl: normalizeBaseUrl(baseUrl),
    user: session.user,
  }
  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Signed in as ${session.user.email ?? session.user.name ?? session.user.id}.`)
}

function runAuthLogout(parsed) {
  const baseUrl = stringFlag(parsed, "base-url") ?? DEFAULT_BASE_URL
  const path = authStorePath(baseUrl)
  if (existsSync(path)) unlinkSync(path)
  const result = { status: "ok", baseUrl: normalizeBaseUrl(baseUrl) }
  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log("Signed out.")
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

  console.log(`${brand("ctxpipe")} ${muted(data.version)}`)
  console.log(`${muted("node")} ${data.node}`)
  console.log(`${muted("cwd")} ${data.cwd}`)
  console.log("")
  console.log(stepLabel("Detected clients"))
  for (const client of CLIENTS) {
    const found = data.detectedClients[client] ? successText("yes") : muted("no")
    console.log(`  ${CLIENT_LABELS[client]} ${found}`)
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

  console.log(stepLabel("Review"))
  console.log(`${brand("ctxpipe")} will:`)
  for (const op of operations) {
    console.log(`  ${teal("+")} ${describeOperationStyled(op)}`)
  }

  if (dryRun) {
    console.log("")
    console.log(muted("Dry run only. No files or client configs were changed."))
    return
  }

  if (!boolFlag(parsed, "yes")) {
    if (!interactive) {
      throw new Error("Refusing to apply changes without --yes in non-interactive mode")
    }
    const ok = await promptConfirm("Apply these changes?", true)
    if (!ok) {
      console.log(muted("No changes made."))
      return
    }
  }

  const result = applyOperations(operations)
  for (const item of result.operations) {
    console.log(describeAppliedItem(item))
  }
  console.log("")
  console.log(successText("ctxpipe is connected"))
  console.log(
    muted("Your agents may ask you to approve ctx| the first time they use MCP."),
  )
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

function describeOperationStyled(op) {
  const description = describeOperation(op)
  if (op.type !== "write-json") return description

  const rel = relative(op.path)
  if (description.startsWith("write repo ctxpipe config")) {
    return `save repo setup ${pathText(rel)}`
  }
  if (description.includes("configure Cursor")) {
    return `connect Cursor ${pathText(rel)}`
  }
  if (description.includes("configure Claude Code")) {
    return `connect Claude Code ${pathText(rel)}`
  }
  if (description.includes("configure OpenCode")) {
    return `connect OpenCode ${pathText(rel)}`
  }
  if (description.includes("configure VS Code")) {
    return `connect VS Code ${pathText(rel)}`
  }
  return `${description} ${pathText(rel)}`
}

function describeAppliedItem(item) {
  if (item.status === "manual") return `${warnText("!")} ${item.detail}`
  if (item.status === "ran") return `${successText("✓")} ${item.detail}`
  if (item.status === "written") {
    return `${successText("✓")} ${pathText(relative(item.path))}`
  }
  if (item.status === "unchanged") {
    return `${muted("•")} ${pathText(relative(item.path))} ${muted("already up to date")}`
  }
  return String(item.detail ?? item.path ?? item.status)
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
  printWizardHeader()

  const answers = {}
  if (!current.org) {
    answers.org = await promptSetupOrg(current.baseUrl)
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

async function promptSetupOrg(baseUrl) {
  const fallbackOrg = detectDefaultOrgSlug()
  let auth = readStoredAuth(baseUrl)
  let orgs = []
  let session = null

  if (auth) {
    ;[orgs, session] = await Promise.all([
      fetchOrganizations({ baseUrl, accessToken: auth.accessToken }).catch(() => []),
      fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(() => null),
    ])
  }

  if (orgs.length === 0) {
    console.log(stepLabel("Sign in"))
    console.log(muted("Sign in to ctx| so we can load your organizations."))
    auth = await loginWithDeviceFlow({ baseUrl })
    ;[orgs, session] = await Promise.all([
      fetchOrganizations({ baseUrl, accessToken: auth.accessToken }),
      fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(() => null),
    ])
  }

  if (session?.user) {
    const label =
      session.user.email ?? session.user.name ?? session.user.id ?? "your account"
    console.log(`${successText("✓")} Signed in as ${label}.`)
    console.log("")
  }

  if (orgs.length === 1) {
    console.log(stepLabel("Organization"))
    console.log(`  ${orgLabel(orgs[0])}`)
    console.log("")
    return orgs[0].slug
  }

  if (orgs.length > 1) {
    return promptSelect({
      message: "Which ctx| organization should this repo use?",
      initial: fallbackOrg ?? orgs[0]?.slug,
      choices: orgs.map((org) => ({
        title: orgLabel(org),
        value: org.slug,
        description: org.slug,
      })),
    })
  }

  return promptText({
    message: "Which ctx| organization should this repo use?",
    initial: fallbackOrg,
  })
}

async function promptMcpWizard(current) {
  printWizardHeader()
  console.log(stepLabel("MCP"))
  console.log(muted("Choose the clients ctxpipe should configure for this machine or repo."))
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
  const agents = await multiselect({
    message: "Which agents should use ctx|?",
    required: true,
    initialValues: detected,
    options: CLIENTS.map((client) => ({
      label: CLIENT_LABELS[client],
      value: client,
      hint: detected.includes(client)
        ? "Detected on this machine"
        : "Not detected, but ctxpipe can still write project config",
    })),
  })
  return promptValue(agents)
}

async function promptText({ message, initial }) {
  const answer = await text({
    message,
    initialValue: initial,
    validate: (value) => (String(value).trim() ? undefined : "Required"),
  })
  return String(promptValue(answer)).trim()
}

function detectDefaultOrgSlug() {
  const existing = readJsonObject(resolve(process.cwd(), ".ctxpipe", "config.json"))
  if (typeof existing.orgSlug === "string" && existing.orgSlug.trim()) {
    return existing.orgSlug
  }
  return process.env.CTXPIPE_ORG_SLUG || process.env.CTXPIPE_ORG || undefined
}

async function promptSelect({ message, choices, initial }) {
  const answer = await select({
    message,
    initialValue: choices.some((choice) => choice.value === initial)
      ? initial
      : choices[0]?.value,
    options: choices.map((choice) => ({
      label: choice.title,
      value: choice.value,
      hint: choice.description,
    })),
  })
  return promptValue(answer)
}

async function promptConfirm(message, initial) {
  const answer = await confirmPrompt({
    message,
    initialValue: initial,
  })
  return promptValue(answer)
}

function promptValue(value) {
  if (isCancel(value)) {
    throw new Error("Setup cancelled")
  }
  return value
}

function printWizardHeader() {
  console.log("")
  console.log(renderPixelLogo())
  console.log(`${muted("Connect your agents to")} ${brand("ctx")}${teal("|")}`)
  console.log("")
}

function renderPixelLogo() {
  const markLines = PIXEL_MARK.split("\n").filter((line) => line.length > 0)
  const pipeLines = PIXEL_PIPE.split("\n").filter((line) => line.length > 0)
  const width = Math.max(...markLines.map((line) => line.length))
  const height = Math.max(markLines.length, pipeLines.length)
  return Array.from({ length: height }, (_, index) => {
    const mark = markLines[index] ?? ""
    const pipe = pipeLines[index] ?? ""
    return `${brand(mark.padEnd(width))}${teal(pipe)}`
  })
    .join("\n")
}

function brand(value) {
  return chalk.bold.white(value)
}

function muted(value) {
  return chalk.dim(value)
}

function stepLabel(value) {
  return `${teal("◆")} ${chalk.bold.white(value)}`
}

function successText(value) {
  return chalk.green(value)
}

function warnText(value) {
  return chalk.yellow(value)
}

function pathText(value) {
  return chalk.cyan(value)
}

async function loginWithDeviceFlow({ baseUrl }) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const device = await requestDeviceCode(normalizedBaseUrl)
  const verificationUrl = absoluteUrl(
    device.verification_uri_complete ?? device.verification_uri,
    normalizedBaseUrl,
  )
  const userCode = device.user_code

  console.log("")
  console.log(`${teal("◆")} ${chalk.bold("Open this URL")}`)
  console.log(`  ${pathText(verificationUrl)}`)
  if (userCode) {
    console.log(`${teal("◆")} ${chalk.bold("Enter code")}`)
    console.log(`  ${chalk.bold(userCode)}`)
  }
  console.log("")

  openBrowser(verificationUrl)

  const token = await pollDeviceToken({
    baseUrl: normalizedBaseUrl,
    deviceCode: device.device_code,
    interval: Number(device.interval ?? 5),
  })
  const auth = {
    baseUrl: normalizedBaseUrl,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    tokenType: token.token_type ?? "Bearer",
    expiresAt:
      typeof token.expires_in === "number"
        ? new Date(Date.now() + token.expires_in * 1000).toISOString()
        : null,
    createdAt: new Date().toISOString(),
  }
  writeStoredAuth(auth)
  return auth
}

async function requestDeviceCode(baseUrl) {
  const response = await authFetch(baseUrl, "/device/code", {
    method: "POST",
    body: {
      client_id: AUTH_CLIENT_ID,
      scope: "openid profile email",
    },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(authErrorMessage(json, "Could not start ctx| device login"))
  }
  const data = unwrapBetterAuthData(json)
  if (!data?.device_code || !data?.verification_uri) {
    throw new Error("Device login response was missing required fields")
  }
  return data
}

async function pollDeviceToken({ baseUrl, deviceCode, interval }) {
  let pollingInterval = Math.max(interval, 1)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    await sleep(pollingInterval * 1000)
    const response = await authFetch(baseUrl, "/device/token", {
      method: "POST",
      body: {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: AUTH_CLIENT_ID,
      },
    })
    const json = await response.json().catch(() => ({}))
    const data = unwrapBetterAuthData(json)
    if (response.ok && data?.access_token) return data

    const code = authErrorCode(json)
    if (code === "authorization_pending") continue
    if (code === "slow_down") {
      pollingInterval += 5
      continue
    }
    if (code === "access_denied") {
      throw new Error("The ctx| sign-in request was denied")
    }
    if (code === "expired_token") {
      throw new Error("The ctx| sign-in code expired")
    }
    throw new Error(authErrorMessage(json, "ctx| sign-in failed"))
  }
  throw new Error("ctx| sign-in timed out")
}

async function fetchOrganizations({ baseUrl, accessToken }) {
  const response = await authFetch(baseUrl, "/organization/list", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(authErrorMessage(json, "Could not load ctx| organizations"))
  }
  const data = unwrapBetterAuthData(json)
  if (!Array.isArray(data)) return []
  return data
    .map((org) => ({
      id: typeof org.id === "string" ? org.id : null,
      name: typeof org.name === "string" ? org.name : org.slug,
      slug: typeof org.slug === "string" ? org.slug : null,
    }))
    .filter((org) => org.slug)
}

async function fetchSession({ baseUrl, accessToken }) {
  const response = await authFetch(baseUrl, "/get-session", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(authErrorMessage(json, "Could not load ctx| session"))
  }
  return unwrapBetterAuthData(json)
}

async function authFetch(baseUrl, path, options = {}) {
  const url = new URL(`/.auth/api/v1/auth${path}`, baseUrl)
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  } catch (error) {
    throw new Error(authConnectionErrorMessage({ baseUrl, error }))
  }
}

function authConnectionErrorMessage({ baseUrl, error }) {
  const code =
    error instanceof Error && isObject(error.cause) && typeof error.cause.code === "string"
      ? ` (${error.cause.code})`
      : ""
  const localHint = baseUrl.includes(".localhost")
    ? " For local testing, start `pnpm dev` and use `--base-url http://127.0.0.1:3000`."
    : ""
  return `Could not reach ctx| auth at ${baseUrl}${code}.${localHint}`
}

function readStoredAuth(baseUrl) {
  const data = readJsonObject(authStorePath(baseUrl))
  if (typeof data.accessToken !== "string" || !data.accessToken) return null
  return {
    baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : normalizeBaseUrl(baseUrl),
    accessToken: data.accessToken,
    refreshToken:
      typeof data.refreshToken === "string" ? data.refreshToken : null,
    tokenType: typeof data.tokenType === "string" ? data.tokenType : "Bearer",
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
  }
}

function writeStoredAuth(auth) {
  const path = authStorePath(auth.baseUrl)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}

function authStorePath(baseUrl) {
  const safeBase = normalizeBaseUrl(baseUrl)
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
  return join(homedir(), ".config", "ctxpipe", `${safeBase}.auth.json`)
}

function unwrapBetterAuthData(json) {
  if (isObject(json) && "data" in json) return json.data
  return json
}

function authErrorCode(json) {
  if (!isObject(json)) return null
  if (typeof json.error === "string") return json.error
  if (isObject(json.error) && typeof json.error.error === "string") {
    return json.error.error
  }
  return null
}

function authErrorMessage(json, fallback) {
  if (isObject(json)) {
    if (typeof json.error_description === "string") return json.error_description
    if (typeof json.message === "string") return json.message
    if (typeof json.error === "string") return json.error
    if (isObject(json.error)) {
      if (typeof json.error.error_description === "string") {
        return json.error.error_description
      }
      if (typeof json.error.message === "string") return json.error.message
      if (typeof json.error.error === "string") return json.error.error
    }
  }
  return fallback
}

function orgLabel(org) {
  return org.name && org.name !== org.slug ? `${org.name} (${org.slug})` : org.slug
}

function absoluteUrl(value, baseUrl) {
  return new URL(value, baseUrl).toString()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function openBrowser(url) {
  const platform = process.platform
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "win32" ? ["/c", "start", "", url] : [url]
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "ignore",
  })
  return result.status === 0
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
  ctxpipe auth login|whoami|logout
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

function printAuthHelp() {
  console.log(`ctxpipe auth

Usage:
  ctxpipe auth login
  ctxpipe auth whoami
  ctxpipe auth logout
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
