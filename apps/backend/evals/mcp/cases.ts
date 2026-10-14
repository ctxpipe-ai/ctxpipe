/**
 * MCPJam eval cases for the public MCP read tools (ADR-051, CTX-574).
 *
 * The cases run against the P4-1 fixture organizations. Names in prompts are the
 * fixture display names; a check resolves `$harbor` and `$meadow` to the seeded
 * org slugs (`mcp-eval-<run>-harbor`). A case holds only data. `check.ts` judges
 * a transcript against it.
 */

export type Json = string | number | boolean | null

/** Rule for one tool argument. A string that starts with `$` names a seeded org. */
export type ArgRule =
  | { equals: Json }
  | { startsWith: string }
  | { present: true }
  /** The argument is an array with an item that names this repository (handle or URL). */
  | { includesRepository: string }
  | { emptyArray: true }
  | { includes: Json }

export type CallRule = {
  /** One tool name, or a list where any name satisfies the rule. `*` means any tool. */
  tool: string | string[]
  /** Minimum number of matching calls. Default 1. */
  min?: number
  args?: Record<string, ArgRule>
}

export type EvalCase = {
  id: string
  name: string
  prompt: string
  /** Remote URL of the repository the agent works in. `null`: no repository. */
  workingRepository: string | null
  /** Each rule needs a matching call. */
  calls?: CallRule[]
  /** Each group: all these tools run in one assistant step (parallel calls). */
  parallel?: string[][]
  /** No call may match any of these rules. */
  forbidden?: CallRule[]
  /** Tool results must contain each string (result relevance). */
  resultsMention?: string[]
  /** The final answer must contain each string (task success). */
  facts?: string[]
  /** The final answer must not contain any of these strings. */
  notInAnswer?: string[]
  /** If a call fails, a later call succeeds (error recovery). */
  recoversFromError?: true
  /**
   * `search_knowledge` arguments (`$org` placeholders allowed). Before the run
   * moves the Workspace to its second projection, it calls the tool with
   * these arguments and puts the returned cursor into the `{cursor}`
   * placeholder of the prompt. The cursor is then stale.
   */
  cursorFrom?: Record<string, Json>
}

const sshRemote = "git@github.com:example/checkout-app.git"
const httpsRemote = "https://github.com/example/checkout-app"

/** Repository handles of the pinned upstream fixtures, from `manifest.json`. */
const is = "sindresorhus/is"
const queue = "sindresorhus/yocto-queue"

export const evalCases: EvalCase[] = [
  {
    id: "list-workspace-detail",
    name: "Name the repositories of one Workspace",
    prompt:
      "Which repositories does the Payments Workspace of Harbor Labs link, and is it ready to search?",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "list_workspaces",
        args: { org: { equals: "$harbor" }, workspace: { equals: "payments" } },
      },
    ],
    facts: [is, queue],
  },
  {
    id: "design-idempotency-retention",
    name: "Search knowledge before a design choice",
    prompt:
      "I am adding retry handling to the settlement submit path in this repository. How long must we keep idempotency keys? Harbor Labs has a standard for it.",
    workingRepository: sshRemote,
    calls: [{ tool: "search_knowledge", args: { org: { equals: "$harbor" } } }],
    resultsMention: ["knowledge/decisions/idempotency.md"],
    facts: ["48 hours"],
  },
  {
    id: "read-decision-in-full",
    name: "Read a decision by its ref",
    prompt:
      "Open the Harbor Labs decision about idempotency key retention in the Payments Workspace and tell me why they chose that period.",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "read_file",
        args: {
          org: { equals: "$harbor" },
          workspace: { equals: "payments" },
          ref: { equals: "knowledge/decisions/idempotency.md" },
        },
      },
    ],
    facts: ["next day", "duplicate"],
  },
  {
    id: "runbook-replay",
    name: "Find a runbook",
    prompt:
      "A settlement consumer fell behind. How do we replay settlement events safely at Harbor Labs?",
    workingRepository: httpsRemote,
    calls: [{ tool: "search_knowledge", args: { org: { equals: "$harbor" } } }],
    resultsMention: ["knowledge/operations/replay.md"],
    facts: ["consumer", "idempotency key"],
  },
  {
    id: "incident-history",
    name: "Find an incident",
    prompt:
      "Did a settlement replay ever send duplicate payments at Harbor Labs? When did it happen?",
    workingRepository: sshRemote,
    calls: [{ tool: "search_knowledge", args: { org: { equals: "$harbor" } } }],
    resultsMention: ["pagerduty/incidents/HBR-3.md"],
    facts: ["May 12"],
  },
  {
    id: "mirrored-ticket",
    name: "Find a mirrored ticket",
    prompt:
      "Is there a Linear ticket about duplicate settlement at Harbor Labs? What does it ask for?",
    workingRepository: sshRemote,
    calls: [{ tool: "search_knowledge", args: { org: { equals: "$harbor" } } }],
    resultsMention: [
      "linear/teams/HBR/issues/hbr-17--7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.md",
    ],
    facts: ["HBR-17", "key"],
  },
  {
    id: "get-related-governing-decision",
    name: "Follow the graph from a service to its decision",
    prompt:
      "Start from the Harbor Labs settlement service unit in the Payments Workspace (knowledge/services/settlement.md). Which decision governs it? Use the knowledge graph.",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "get_related",
        args: {
          org: { equals: "$harbor" },
          workspace: { equals: "payments" },
          seeds: { includes: "knowledge/services/settlement.md" },
          intent: { equals: "why" },
        },
      },
    ],
    resultsMention: ["knowledge/decisions/idempotency.md"],
    facts: ["idempotency"],
  },
  {
    id: "dependency-of-service",
    name: "Find what a service depends on",
    prompt:
      "What does the Harbor Labs settlement service depend on? Check the Payments Workspace.",
    workingRepository: sshRemote,
    calls: [
      {
        tool: ["get_related", "read_file", "search_knowledge"],
        args: { org: { equals: "$harbor" } },
      },
    ],
    facts: ["ledger"],
  },
  {
    id: "parallel-knowledge-and-code",
    name: "Send independent searches in one turn",
    prompt:
      "Before I design retries here, check both the Harbor Labs knowledge and the code in their other repositories for how a first-in first-out queue and idempotency are handled. Run the independent searches together.",
    workingRepository: sshRemote,
    parallel: [["search_knowledge", "search_code"]],
    facts: ["idempotency"],
  },
  {
    id: "parallel-reads",
    name: "Read two refs in parallel",
    prompt:
      "Read the Harbor Labs settlement service unit and the ledger service unit in the Payments Workspace, and tell me what ERR_LEDGER_FULL means.",
    workingRepository: sshRemote,
    parallel: [["read_file", "read_file"]],
    calls: [
      {
        tool: "read_file",
        min: 2,
        args: { workspace: { equals: "payments" } },
      },
    ],
    facts: ["disk"],
  },
  {
    id: "two-orgs-one-session",
    name: "Compare two orgs, one call for each org",
    prompt:
      "Compare how Harbor Labs and Meadow Works settle payments. I have access to both.",
    workingRepository: sshRemote,
    calls: [
      { tool: "search_knowledge", args: { org: { equals: "$harbor" } } },
      { tool: "search_knowledge", args: { org: { equals: "$meadow" } } },
    ],
    facts: ["idempotency", "midnight"],
  },
  {
    id: "org-scope-respected",
    name: "Do not reach into another org",
    prompt:
      "What is MEADOW_ONLY_42 at Harbor Labs? Search only Harbor Labs for it.",
    workingRepository: sshRemote,
    forbidden: [{ tool: "*", args: { org: { equals: "$meadow" } } }],
    notInAnswer: ["midnight"],
  },
  {
    id: "no-repository-agent",
    name: "An agent outside a repository passes an empty exclusion",
    prompt:
      "I am not in a git repository. Where is the Queue class defined in the Harbor Labs code?",
    workingRepository: null,
    calls: [
      {
        tool: ["find_symbol", "search_code"],
        args: {
          org: { equals: "$harbor" },
          excludeRepositories: { emptyArray: true },
        },
      },
    ],
    resultsMention: [queue],
    facts: ["yocto-queue"],
  },
  {
    id: "current-repository-trap-https",
    name: "Exclude the working repository (HTTPS remote)",
    prompt: `I am working in https://github.com/${is}. Find how another Harbor Labs repository implements a first-in first-out queue with enqueue and dequeue.`,
    workingRepository: `https://github.com/${is}`,
    calls: [
      {
        tool: ["search_code", "find_symbol"],
        args: { excludeRepositories: { includesRepository: is } },
      },
    ],
    forbidden: [{ tool: "read_file", args: { ref: { startsWith: `${is}:` } } }],
    resultsMention: [queue],
    facts: ["yocto-queue"],
  },
  {
    id: "current-repository-trap-ssh",
    name: "Exclude the working repository (SSH remote)",
    prompt: `My checkout has the remote git@github.com:${is}.git. Search the code of the other Harbor Labs repositories for a queue class with a dequeue method.`,
    workingRepository: `git@github.com:${is}.git`,
    calls: [
      {
        tool: ["search_code", "find_symbol"],
        args: { excludeRepositories: { includesRepository: is } },
      },
    ],
    forbidden: [{ tool: "read_file", args: { ref: { startsWith: `${is}:` } } }],
    facts: ["yocto-queue"],
  },
  {
    id: "stale-cursor",
    name: "Recover from a cursor that the server rejects as stale",
    prompt:
      'A colleague saved a page cursor from a Harbor Labs search_knowledge call with the query "idempotency" and limit 1: {cursor}. Continue that search with the same query, limit, and cursor. If the server rejects the cursor, start the search again and tell me how long the payments service keeps idempotency keys.',
    workingRepository: sshRemote,
    cursorFrom: { org: "$harbor", query: "idempotency", limit: 1 },
    calls: [
      {
        tool: "search_knowledge",
        args: { org: { equals: "$harbor" }, cursor: { present: true } },
      },
      { tool: "search_knowledge", min: 2 },
    ],
    resultsMention: ["stale_cursor"],
    recoversFromError: true,
    facts: ["48 hours"],
  },
  {
    id: "structural-search",
    name: "Use a structural pattern",
    prompt:
      "With a syntax-aware (AST) search, find class declarations that define a dequeue method in the other Harbor Labs repositories.",
    workingRepository: httpsRemote,
    calls: [
      {
        tool: "search_code",
        args: {
          mode: { equals: "structural" },
          language: { present: true },
          excludeRepositories: { includesRepository: "example/checkout-app" },
        },
      },
    ],
    resultsMention: [queue],
  },
  {
    id: "regex-search",
    name: "Use a regular expression",
    prompt:
      "Use a regular expression to find exported functions named isString or isNumber in the other Harbor Labs repositories.",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "search_code",
        args: { mode: { equals: "regex" } },
      },
    ],
    resultsMention: [is],
  },
  {
    id: "symbol-definition",
    name: "Look up a symbol definition",
    prompt:
      "Which Harbor Labs repository defines the Queue symbol, and in which file?",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "find_symbol",
        args: {
          org: { equals: "$harbor" },
          relation: { equals: "definition" },
        },
      },
    ],
    resultsMention: [queue],
    facts: ["yocto-queue"],
  },
  {
    id: "folder-structure",
    name: "List the knowledge folders",
    prompt:
      "How is the knowledge folder of the Harbor Labs Payments Workspace organized? Name its sub-folders.",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "list_files",
        args: { org: { equals: "$harbor" }, workspace: { equals: "payments" } },
      },
    ],
    facts: ["decisions", "operations", "services"],
  },
  {
    id: "filter-path-prefix",
    name: "Filter a search by path prefix",
    prompt:
      "Search only the operations runbooks under knowledge/operations in the Harbor Labs Payments Workspace for replay steps.",
    workingRepository: sshRemote,
    calls: [
      {
        tool: "search_knowledge",
        args: {
          org: { equals: "$harbor" },
          pathPrefix: { startsWith: "knowledge/operations" },
        },
      },
    ],
    resultsMention: ["knowledge/operations/replay.md"],
  },
  {
    id: "unknown-workspace-recovery",
    name: "Recover from an unknown Workspace",
    prompt:
      "Search the billing Workspace of Harbor Labs for the idempotency key retention rule.",
    workingRepository: sshRemote,
    calls: [{ tool: "search_knowledge", min: 1 }],
    recoversFromError: true,
    facts: ["48 hours"],
  },
]
