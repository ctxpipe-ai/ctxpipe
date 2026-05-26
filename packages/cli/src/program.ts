import { Command } from "commander"
import { DEFAULT_BASE_URL } from "./constants.js"
import { packageVersion } from "./version.js"
import {
  runAuthLogin,
  runAuthLogout,
  runAuthWhoami,
  runDoctor,
  runInit,
  runMcpAdd,
} from "./commands.js"
import {
  runMemoryDoctor,
  runMemoryHook,
  runMemoryMcp,
  runMemoryStatus,
  runMemoryStop,
} from "./memory/index.js"

function collectList(value: string, previous: string[]): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  ]
}

export async function runProgram(argv: string[]): Promise<void> {
  const program = new Command()
    .name("ctxpipe")
    .description("Initialize repos and connect ctx| MCP to your agents.")
    .version(packageVersion, "-V, --version", "output the version number")
    .addHelpText(
      "after",
      `
Human setup:
  npx ctxpipe init

Examples (non-interactive):
  npx ctxpipe init --org acme --agents codex,claude --scope repo --yes
  npx ctxpipe mcp add --org acme --client cursor --scope repo --yes
  npx ctxpipe doctor --json
`,
    )

  program
    .command("init")
    .description(
      "Initialize the current repo (or user scope) for ctx|. Writes .ctxpipe/config.json and optional MCP client configs.",
    )
    .option("--org <slug>", "ctx| organization slug (required when not interactive)")
    .option(
      "--base-url <url>",
      `ctx| app origin for auth and MCP (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .option(
      "--scope <repo|user|both>",
      "Where to apply setup: this repo, your user account, or both (required when not interactive)",
    )
    .option(
      "--agents <names>",
      "Comma-separated client ids (cursor, claude, codex, opencode, vscode). Repeatable; merged with --agent and --client.",
      collectList,
      [] as string[],
    )
    .option(
      "--agent <names>",
      "Alias for --agents (same comma-separated / repeatable rules).",
      collectList,
      [] as string[],
    )
    .option(
      "--client <names>",
      "Alias for --agents (same comma-separated / repeatable rules).",
      collectList,
      [] as string[],
    )
    .option("--dry-run", "Print planned changes without writing files", false)
    .option(
      "--json",
      "Print machine-readable JSON (use with --yes to apply; init only for apply summary)",
      false,
    )
    .option("-y, --yes", "Do not prompt; required for non-interactive apply", false)
    .option(
      "--no-mcp",
      "Skip MCP client configuration (still writes .ctxpipe/config.json with org and MCP URL)",
    )
    .option(
      "--memory",
      "Enable local ctxpipe-memory MCP and create .ai/memory in this repo",
    )
    .option(
      "--no-memory",
      "Skip local memory setup even if interactive selection would suggest it",
    )
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as {
        org?: string
        baseUrl: string
        scope?: string
        agents: string[]
        agent: string[]
        client: string[]
        dryRun: boolean
        json: boolean
        yes: boolean
        mcp: boolean
        memory?: boolean
      }
      const agents = [
        ...(opts.agents ?? []),
        ...(opts.agent ?? []),
        ...(opts.client ?? []),
      ]
      await runInit({
        baseUrl: opts.baseUrl,
        org: opts.org,
        scope: opts.scope,
        agents,
        dryRun: opts.dryRun,
        json: opts.json,
        yes: opts.yes,
        mcp: opts.mcp,
        memory: opts.memory,
      })
    })

  program
    .command("doctor")
    .description("Print environment diagnostics (Node version, cwd, detected client CLIs).")
    .option("--json", "Print diagnostics as JSON", false)
    .action((rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { json: boolean }
      runDoctor({ json: opts.json })
    })

  const mcp = program.command("mcp").description("MCP-only commands for ctx|.")

  mcp
    .command("add")
    .description("Configure ctx| MCP for one or more clients without re-running full init.")
    .option("--org <slug>", "ctx| organization slug (required when not interactive)")
    .option(
      "--base-url <url>",
      `ctx| app origin for MCP URL (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .option(
      "--scope <repo|user|both>",
      "Where to write MCP config: repo, user, or both (required when not interactive)",
    )
    .option(
      "--client <names>",
      "Comma-separated client ids. Repeatable; merged with --clients.",
      collectList,
      [] as string[],
    )
    .option(
      "--clients <names>",
      "Alias for --client (same comma-separated / repeatable rules).",
      collectList,
      [] as string[],
    )
    .option("--dry-run", "Print planned changes without writing files", false)
    .option(
      "--json",
      "Print machine-readable JSON (use with --yes to apply)",
      false,
    )
    .option("-y, --yes", "Do not prompt; required for non-interactive apply", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as {
        org: string
        baseUrl: string
        scope?: string
        client: string[]
        clients: string[]
        dryRun: boolean
        json: boolean
        yes: boolean
      }
      const clients = [...(opts.client ?? []), ...(opts.clients ?? [])]
      await runMcpAdd({
        baseUrl: opts.baseUrl,
        org: opts.org,
        scope: opts.scope,
        clients,
        dryRun: opts.dryRun,
        json: opts.json,
        yes: opts.yes,
      })
    })

  const auth = program.command("auth").description("Setup sign-in for listing organizations (separate from MCP OAuth).")

  auth
    .command("login")
    .description("Sign in with a browser/device code and store credentials for setup commands.")
    .option(
      "--base-url <url>",
      `ctx| app origin for auth (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string }
      await runAuthLogin({ baseUrl: opts.baseUrl })
    })

  auth
    .command("whoami")
    .description("Show whether you are signed in for setup and which user the server reports.")
    .option(
      "--base-url <url>",
      `ctx| app origin (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .option("--json", "Print status as JSON", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string; json: boolean }
      await runAuthWhoami({ baseUrl: opts.baseUrl, json: opts.json })
    })

  auth
    .command("logout")
    .description("Remove locally stored setup credentials for this base URL.")
    .option(
      "--base-url <url>",
      `ctx| app origin (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .option("--json", "Print status as JSON", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string; json: boolean }
      await runAuthLogout({ baseUrl: opts.baseUrl, json: opts.json })
    })

  const memory = program
    .command("memory")
    .description(
      "Local agent memory backed by AgentMemory and hydrated from .ai/memory.",
    )

  memory
    .command("mcp")
    .description(
      "Stdio MCP server invoked by agent clients (not for humans). Speaks newline-delimited JSON-RPC 2.0.",
    )
    .option(
      "--base-url <url>",
      `ctx| app origin (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string }
      await runMemoryMcp({ baseUrl: opts.baseUrl })
    })

  memory
    .command("status")
    .description(
      "Report current local memory mode, runtime state, and hosted model availability.",
    )
    .option(
      "--base-url <url>",
      `ctx| app origin (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .option("--json", "Print status as JSON", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string; json: boolean }
      await runMemoryStatus({ baseUrl: opts.baseUrl, json: opts.json })
    })

  memory
    .command("doctor")
    .description(
      "Diagnose local memory setup: runtime package, ports, auth, hydration manifest.",
    )
    .option(
      "--base-url <url>",
      `ctx| app origin (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .option("--json", "Print diagnostics as JSON", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string; json: boolean }
      await runMemoryDoctor({ baseUrl: opts.baseUrl, json: opts.json })
    })

  memory
    .command("stop")
    .description("Stop the per-repo AgentMemory runtime started by ctxpipe.")
    .option("--json", "Print result as JSON", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { json: boolean }
      await runMemoryStop({ json: opts.json })
    })

  memory
    .command("hook <name>")
    .description(
      "Run a ctxpipe memory hook (used by agent-native hook configs, e.g. Claude Code).",
    )
    .option(
      "--base-url <url>",
      `ctx| app origin (default: ${DEFAULT_BASE_URL})`,
      DEFAULT_BASE_URL,
    )
    .action(async (name: string, rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { baseUrl: string }
      await runMemoryHook({ name, baseUrl: opts.baseUrl })
    })

  if (argv.length === 0) {
    program.outputHelp()
    return
  }

  await program.parseAsync(argv, { from: "user" })
}
