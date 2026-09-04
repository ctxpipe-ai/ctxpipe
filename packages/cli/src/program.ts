import { Command, Option } from "commander"
import {
  runAuthLogin,
  runAuthLogout,
  runAuthWhoami,
  runDoctor,
  runInit,
  runMcpAdd,
  runMcpDoctor,
} from "./commands.js"
import { DEFAULT_BASE_URL } from "./constants.js"
import {
  runMemoryCaptureDismiss,
  runMemoryCaptureFinalize,
  runMemoryCaptureObserve,
  runMemoryCapturePromote,
  runMemoryCaptureSummary,
  runMemoryDoctor,
  runMemoryInit,
  runMemoryStatus,
  runMemoryStop,
} from "./memory/index.js"
import { packageVersion } from "./version.js"

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

function addMcpAuthOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        "--auth <oauth|api-key>",
        "MCP auth: oauth writes URL-only config for any scope (default); api-key writes x-api-key only to user-level client config, never repo files",
      )
        .choices(["oauth", "api-key"]),
    )
    .option(
      "--api-key <key>",
      "API key for --auth api-key (or set CTXPIPE_API_KEY). Written only to user-level client config",
    )
}

function addNonInteractiveOption(command: Command): Command {
  return command
    .option(
      "--non-interactive, -y",
      "Apply without prompts; required for scripts/CI when stdin is not a TTY",
      false,
    )
    .addOption(
      new Option("--yes", "Deprecated alias for --non-interactive").hideHelp(),
    )
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
  npx ctxpipe mcp add --org acme --client cursor --scope user --auth api-key --api-key "$CTXPIPE_API_KEY" --non-interactive
  npx ctxpipe doctor --json
  npx ctxpipe doctor mcp --url "https://app.example.com/mcp?orgSlug=acme"
`,
    )

  addMcpAuthOptions(
    addNonInteractiveOption(
      program
        .command("init")
        .description(
          "Initialize the current repo (or user scope) for ctx|. Writes .ctxpipe/config.json and optional MCP client configs.",
        )
        .option(
          "--org <slug>",
          "ctx| organization slug (required when not interactive)",
        )
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
        )
        .addHelpText(
          "after",
          `
MCP auth:
  Default is OAuth: URL-only config for repo, user, or both. The client completes browser OAuth.
  --auth api-key writes the x-api-key header only to user-level client config (never repository files).
  --scope repo or both with an API key skips repo MCP writes.
`,
        ),
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
      auth?: string
      apiKey?: string
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
      auth: opts.auth,
      apiKey: opts.apiKey,
    })
  })

  const doctor = program
    .command("doctor")
    .description(
      "Print environment diagnostics (Node version, cwd, detected client CLIs).",
    )
    .option("--json", "Print diagnostics as JSON", false)
    .action((rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { json: boolean }
      runDoctor({ json: opts.json })
    })

  doctor
    .command("mcp")
    .description(
      "Diagnose a ctx| Streamable HTTP endpoint and its OAuth discovery metadata.",
    )
    .requiredOption(
      "--url <url>",
      "ctx| MCP URL, including /mcp (optional ?orgSlug=<slug>)",
    )
    .option("--timeout <ms>", "Per-request timeout in milliseconds", "10000")
    .option("--json", "Print diagnostics as JSON", false)
    .addHelpText(
      "after",
      `
This command diagnoses ctx| HTTP routing, TLS/reachability, the unauthenticated
Bearer challenge, and OAuth discovery. It does not run browser OAuth, list
authenticated tools, invoke ctx_advisor, or test STDIO servers. A successful
result means the endpoint is ready for OAuth, not that authenticated tools work.
`,
    )
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as {
        url: string
        timeout: string
        json: boolean
      }
      const timeoutMs = Number(opts.timeout)
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout must be a positive integer")
      }
      await runMcpDoctor({
        url: opts.url,
        timeoutMs,
        json: opts.json,
      })
    })

  const mcp = program.command("mcp").description("MCP-only commands for ctx|.")

  addMcpAuthOptions(
    addNonInteractiveOption(
      mcp
        .command("add")
        .description(
          "Configure ctx| MCP for one or more clients without re-running full init.",
        )
        .option(
          "--org <slug>",
          "ctx| organization slug (required when not interactive)",
        )
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
        )
        .addHelpText(
          "after",
          `
MCP auth:
  Default is OAuth: URL-only config for repo, user, or both. The client completes browser OAuth.
  --auth api-key writes the x-api-key header only to user-level client config (never repository files).
  --scope repo or both with an API key skips repo MCP writes.
`,
        ),
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
      auth?: string
      apiKey?: string
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
      auth: opts.auth,
      apiKey: opts.apiKey,
    })
  })

  const auth = program
    .command("auth")
    .description(
      "Setup sign-in for listing organizations (separate from MCP OAuth).",
    )

  auth
    .command("login")
    .description(
      "Sign in with a browser/device code and store credentials for setup commands.",
    )
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
    .description(
      "Show whether you are signed in for setup and which user the server reports.",
    )
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
      .option(
        "--json",
        "Print machine-readable JSON (use with --non-interactive to apply)",
        false,
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

  capture
    .command("finalize")
    .description(
      "Observe stdin JSON then print a candidate summary (serialized Stop hook for Claude).",
    )
    .requiredOption(
      "--host <name>",
      "Host id: cursor | claude | codex | opencode | vscode",
    )
    .option("--event <type>", "Host event type", "Stop")
    .action(async (rawOpts: Record<string, unknown>) => {
      const opts = rawOpts as { host: string; event: string }
      await runMemoryCaptureFinalize({ host: opts.host, event: opts.event })
    })

  capture
    .command("promote")
    .description(
      "Mark candidate ids as promoted into durable Markdown (pending/surfaced → promoted).",
    )
    .argument("<ids...>", "Candidate ids from capture summary")
    .action(async (ids: string[]) => {
      await runMemoryCapturePromote(ids)
    })

  capture
    .command("dismiss")
    .description(
      "Mark candidate ids as dismissed without promoting (pending/surfaced → dismissed).",
    )
    .argument("<ids...>", "Candidate ids from capture summary")
    .action(async (ids: string[]) => {
      await runMemoryCaptureDismiss(ids)
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
    .description(
      "Diagnose local Markdown memory setup (layout, indexes, events).",
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
    .description(
      "No-op compatibility command (no local memory runtime in Markdown-only mode).",
    )
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
