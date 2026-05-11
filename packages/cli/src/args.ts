import { stdin as input, stdout as output } from "node:process"

export type FlagValue = string | boolean
export type ParsedArgs = {
  flags: Record<string, FlagValue | FlagValue[]>
  positionals: string[]
}

export function parseArgs(rawArgs: string[]): ParsedArgs {
  const flags: ParsedArgs["flags"] = {}
  const positionals: string[] = []

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg === undefined) continue
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

    const [rawName = "", inlineValue] = arg.slice(2).split("=", 2)
    const name = normalizeFlagName(rawName)
    const next = rawArgs[i + 1]
    let value: FlagValue = true
    if (inlineValue !== undefined) {
      value = inlineValue
    } else if (next && !next.startsWith("-")) {
      i += 1
      value = next
    }

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

export function normalizeFlagName(name: string): string {
  switch (name) {
    case "agent":
      return "agents"
    case "clients":
      return "client"
    default:
      return name
  }
}

export function parseClientFlags(parsed: ParsedArgs): string[] {
  const client = parseListFlag(parsed, "client")
  return client.length > 0 ? client : parseListFlag(parsed, "clients")
}

export function parseListFlag(parsed: ParsedArgs, name: string): string[] {
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

export function stringFlag(parsed: ParsedArgs, name: string): string | null {
  const value = parsed.flags[name]
  if (value == null || value === true || value === false) return null
  return Array.isArray(value) ? String(value.at(-1)) : String(value)
}

export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === "true"
}

export function parseBoolish(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback
  if (value === true || value === "true" || value === "yes") return true
  if (value === false || value === "false" || value === "no") return false
  return fallback
}

export function isInteractive(parsed: ParsedArgs): boolean {
  return !boolFlag(parsed, "yes") && !boolFlag(parsed, "json") && input.isTTY && output.isTTY
}
