import { intro, log } from "@clack/prompts"
import chalk from "chalk"
import { CLIENT_LABELS, CLIENTS } from "./constants.js"
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
  if (op.type === "write-text") return `seed ${relativePath(op.path, process.cwd())}`
  if (op.type === "mkdir") return `create ${relativePath(op.path, process.cwd())}`
  if (op.type === "run") return `run ${op.command.join(" ")}`
  return op.detail
}

export function describeAppliedItem(item: ApplyOperationResult): string {
  if (item.status === "manual") return `${warnText("!")} ${item.detail}`
  if (item.status === "ran") return `${successText("✓")} ${item.detail}`
  if (item.status === "written" || item.status === "created") {
    return `${successText("✓")} ${pathText(relativePath(item.path, process.cwd()))}`
  }
  if (item.status === "skipped") {
    return `${muted("•")} ${pathText(relativePath(item.path, process.cwd()))} ${muted(
      "left as-is",
    )}`
  }
  if (item.status === "unchanged") {
    return `${muted("•")} ${pathText(relativePath(item.path, process.cwd()))} ${muted(
      "already up to date",
    )}`
  }
  return item.status
}

export function writeResult(json: boolean, result: unknown): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (typeof result === "object" && result !== null && "status" in result) {
    console.log(String((result as { status: unknown }).status))
    return
  }
  console.log(String(result))
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
