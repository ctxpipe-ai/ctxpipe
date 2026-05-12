import { intro, log } from "@clack/prompts"
import chalk from "chalk"
import { CLIENT_LABELS, CLIENTS, DEFAULT_BASE_URL, VERSION } from "./constants.js"
import type { ParsedArgs } from "./args.js"
import { boolFlag } from "./args.js"
import type { ApplyOperationResult } from "./fs-operations.js"
import type { Operation } from "./mcp/mcp-operations.js"
import { relativePath } from "./mcp/paths.js"

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

export function printWizardHeader(): void {
  console.log("")
  console.log(renderPixelLogo())
  intro(`${brandName()} setup`)
  log.message(`${muted("Connect your agents to")} ${brandName()}`)
}

export function renderPixelLogo(): string {
  const markLines = PIXEL_MARK.split("\n").filter((line) => line.length > 0)
  const pipeLines = PIXEL_PIPE.split("\n").filter((line) => line.length > 0)
  const width = Math.max(...markLines.map((line) => line.length))
  const height = Math.max(markLines.length, pipeLines.length)
  return Array.from({ length: height }, (_, index) => {
    const mark = markLines[index] ?? ""
    const pipe = pipeLines[index] ?? ""
    return `${brand(mark.padEnd(width))}${teal(pipe)}`
  }).join("\n")
}

export function brand(value: string): string {
  return chalk.bold.white(value)
}

export function brandName(): string {
  return `${brand("ctx")}${teal("|")}`
}

export function muted(value: string): string {
  return chalk.dim(value)
}

export function stepLabel(value: string): string {
  return `${teal("◆")} ${chalk.bold.white(value)}`
}

export function successText(value: string): string {
  return chalk.green(value)
}

export function warnText(value: string): string {
  return chalk.yellow(value)
}

export function pathText(value: string): string {
  return chalk.cyan(value)
}

export function describeOperation(op: Operation): string {
  if (op.description) return op.description
  if (op.type === "write-json") return `write ${relativePath(op.path, process.cwd())}`
  if (op.type === "run") return `run ${op.command.join(" ")}`
  return op.detail
}

export function describeOperationStyled(op: Operation): string {
  const description = describeOperation(op)
  if (op.type !== "write-json") return description

  const rel = relativePath(op.path, process.cwd())
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

export function describeAppliedItem(item: ApplyOperationResult): string {
  if (item.status === "manual") return `${warnText("!")} ${item.detail}`
  if (item.status === "ran") return `${successText("✓")} ${item.detail}`
  if (item.status === "written") {
    return `${successText("✓")} ${pathText(relativePath(item.path, process.cwd()))}`
  }
  if (item.status === "unchanged") {
    return `${muted("•")} ${pathText(relativePath(item.path, process.cwd()))} ${muted(
      "already up to date",
    )}`
  }
  return item.status
}

export function writeResult(parsed: ParsedArgs, result: unknown): void {
  if (boolFlag(parsed, "json")) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (typeof result === "object" && result !== null && "status" in result) {
    console.log(String(result.status))
    return
  }
  console.log(String(result))
}

export function printHelp(): void {
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

export function printInitHelp(): void {
  console.log(`ctxpipe init

Initialize the current repo or user environment for ctx|.

Examples:
  ctxpipe init
  ctxpipe init --org acme --agents codex,claude --scope repo --yes
  ctxpipe init --org acme --agents cursor --scope user --dry-run
`)
}

export function printMcpHelp(): void {
  console.log(`ctxpipe mcp

Usage:
  ctxpipe mcp add --org <slug> --client <name> --scope repo|user|both
`)
}

export function printAuthHelp(): void {
  console.log(`ctxpipe auth

Usage:
  ctxpipe auth login
  ctxpipe auth whoami
  ctxpipe auth logout
`)
}

export function printMcpAddHelp(): void {
  console.log(`ctxpipe mcp add

Configure ctx| MCP for one or more clients.

Examples:
  ctxpipe mcp add --org acme --client cursor --scope repo --yes
  ctxpipe mcp add --org acme --client claude,codex --scope user --dry-run

Supported clients:
  ${CLIENTS.join(", ")}
`)
}

export function printDoctorTable(data: {
  version: string
  node: string
  cwd: string
  detectedClients: Record<string, boolean>
}): void {
  log.info(`${brand("ctxpipe")} ${muted(data.version)}`)
  log.message(`${muted("node")} ${data.node}`)
  log.message(`${muted("cwd")} ${data.cwd}`)
  log.step("Detected clients")
  for (const client of CLIENTS) {
    const found = data.detectedClients[client] ? successText("yes") : muted("no")
    log.message(`${CLIENT_LABELS[client]} ${found}`)
  }
}
