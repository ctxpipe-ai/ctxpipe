import { Command, Option } from "commander"
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
  runMemoryCaptureObserve,
  runMemoryCaptureSummary,
  runMemoryDoctor,
  runMemoryInit,
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

function resolveNonInteractive(raw: Record<string, unknown>): boolean {
  return Boolean(raw.nonInteractive || raw.yes)
}

function addNonInteractiveOption(command: Command): Command {
  return command
    .option(
      "--non-interactive, -y",
      "Apply without prompts; required for scripts/CI when stdin is not a TTY",
      false,
    )
    .addOption(new Option("--yes", "Deprecated alias for --non-interactive").hideHelp())
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
  npx ctxpipe init --org acme --agents codex,claude --scope repo --non-interactive
  npx ctxpipe mcp add --org acme --client cursor --scope repo --non-interactive
  npx ctxpipe doctor --json
`,
    )

  addNonInteractiveOption(
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
        "Print machine-readable JSON (use with --non-interactive to apply; init only for apply summary)",
        false,
      )
      .option(
        "--no-mcp",
        "Skip MCP client configuration (still writes .ctxpipe/config.json with org and MCP URL)",
      )
      .option(
        "--memory",
        "Enable Markdown .ai/memory layout, capture skills/rule, and host hooks for selected agents",
      )
      .option(
        "--no-memory",
        "Skip local memory setup even if interactive selection would suggest it",
      ),
  ).action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as {
        org?: string
        baseUrl: string
        scope?: string
        agents: string[]
        agent: string[]
        client: string[]
        dryRun: boolean
        json: boolean
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
        nonInteractive: resolveNonInteractive(rawOpts),
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

  addNonInteractiveOption(
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
        "Print machine-readable JSON (use with --non-interactive to apply)",
        false,
      ),
  ).action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as {
        org: string
        baseUrl: string
        scope?: string
        client: string[]
        clients: string[]
        dryRun: boolean
        json: boolean
      }
      const clients = [...(opts.client ?? []), ...(opts.clients ?? [])]
      await runMcpAdd({
        baseUrl: opts.baseUrl,
        org: opts.org,
        scope: opts.scope,
        clients,
        dryRun: opts.dryRun,
        json: opts.json,
        nonInteractive: resolveNonInteractive(rawOpts),
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
      "Markdown-only local agent memory under .ai/memory with candidate capture hooks.",
    )

  addNonInteractiveOption(
    memory
      .command("init")
      .description(
        "Seed .ai/memory layout, capture skills/rule, and install host hooks for selected agents (no remote ctxpipe MCP).",
      )
      .option(
        "--org <slug>",
        "ctx| organization slug (optional; stored in .ctxpipe/config.json)",
      )
      .option(
        "--base-url <url>",
        `ctx| app origin for auth (default: ${DEFAULT_BASE_URL})`,
        DEFAULT_BASE_URL,
      )
      .option(
        "--scope <repo|user|both>",
        "Where to install host hooks (non-interactive default: repo)",
      )
      .option(
        "--agents <names>",
        "Comma-separated client ids. Repeatable; merged with --agent and --client.",
        collectList,
        [] as string[],
      )
      .option(
        "--agent <names>",
        "Alias for --agents.",
        collectList,
        [] as string[],
      )
      .option(
        "--client <names>",
        "Alias for --agents.",
        collectList,
        [] as string[],
      )
      .option("--dry-run", "Print planned changes without writing files", false)
      .option("--json", "Print machine-readable JSON (use with --non-interactive to apply)", false),
  ).action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as {
        org?: string
        baseUrl: string
        scope?: string
        agents: string[]
        agent: string[]
        client: string[]
        dryRun: boolean
        json: boolean
      }
      const agents = [
        ...(opts.agents ?? []),
        ...(opts.agent ?? []),
        ...(opts.client ?? []),
      ]
      await runMemoryInit({
        baseUrl: opts.baseUrl,
        org: opts.org,
        scope: opts.scope,
        agents,
        dryRun: opts.dryRun,
        json: opts.json,
        nonInteractive: resolveNonInteractive(rawOpts),
      })
    })

  const capture = memory
    .command("capture")
    .description(
      "Candidate capture pipeline invoked by host hooks (observe/summary).",
    )

  capture
    .command("observe")
    .description(
      "Classify stdin JSON from a host hook and append candidates under .ai/memory/events/ (fail-open).",
    )
    .requiredOption(
      "--host <name>",
      "Host id: cursor | claude | codex | opencode | vscode",
    )
    .option("--event <type>", "Host event type", "unknown")
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { host: string; event: string }
      await runMemoryCaptureObserve({ host: opts.host, event: opts.event })
    })

  capture
    .command("summary")
    .description(
      "Print unsummarized memory candidates as JSON for the host stop hook (does not write durable Markdown).",
    )
    .action(async () => {
      await runMemoryCaptureSummary()
    })

  memory
    .command("status")
    .description("Report Markdown memory layout status for this repo.")
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
    .description("Diagnose local Markdown memory setup (layout, indexes, events).")
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
    .description("No-op compatibility command (no local memory runtime in Markdown-only mode).")
    .option("--json", "Print result as JSON", false)
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { json: boolean }
      await runMemoryStop({ json: opts.json })
    })

  if (argv.length === 0) {
    program.outputHelp()
    return
  }

  await program.parseAsync(argv, { from: "user" })
}
