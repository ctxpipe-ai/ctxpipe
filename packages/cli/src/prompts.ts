import {
  confirm as confirmPrompt,
  isCancel,
  log,
  multiselect,
  select,
  spinner,
} from "@clack/prompts"

import {
  CLIENT_COMMANDS,
  CLIENT_LABELS,
  CLIENTS,
  type Client,
  MCP_API_KEY_MINT_HINT,
  type McpAuthMode,
} from "./constants.js"
import { commandExists } from "./system.js"
import { muted, printWizardHeader } from "./ui.js"

type Choice<T extends string> = {
  title: string
  value: T
  description?: string
}

type InitPromptState = {
  agents: string[]
  scope: string | null
  mcp: boolean
  auth: string | null
  /** Tri-state from CLI flags. undefined means "ask". */
  memory?: boolean | undefined
}

type InitPromptAnswers = {
  scope?: "repo" | "user" | "both"
  agents?: Client[]
  memory?: boolean
  auth?: McpAuthMode
}

type McpPromptState = {
  clients: string[]
  scope: string | null
  auth: string | null
}

type McpPromptAnswers = {
  scope?: "repo" | "user" | "both"
  clients?: Client[]
  auth?: McpAuthMode
}

type MemoryInitPromptState = {
  agents: Client[]
  scope: string | null
}

type MemoryInitPromptAnswers = {
  scope?: "repo" | "user" | "both"
  agents?: Client[]
}

export async function promptMemoryInitWizard(
  current: MemoryInitPromptState,
): Promise<MemoryInitPromptAnswers> {
  printWizardHeader()
  log.step("Local memory")
  log.message(
    muted(
      "Seed Markdown .ai/memory, capture skills/rule, and host hooks (no remote ctxpipe MCP).",
    ),
  )

  log.message(muted("Local Markdown memory does not need a ctxpipe sign-in."))
  const answers: MemoryInitPromptAnswers = {}
  if (!current.scope) {
    answers.scope = await promptSelect<"repo" | "user" | "both">({
      message: "Where should memory hooks be installed?",
      initial: "repo",
      choices: [
        {
          title: "This repo",
          value: "repo",
          description: "Write .ai/memory and project hook config in this repo.",
        },
        {
          title: "Globally",
          value: "user",
          description: "Install user-level hooks when supported.",
        },
        {
          title: "Both",
          value: "both",
          description: "Set up this repo and your user-level hook config.",
        },
      ],
    })
  }
  if (current.agents.length === 0) {
    answers.agents = await promptMemoryAgents()
  }
  return answers
}

async function promptMemoryAgents(): Promise<Client[]> {
  const detectSpinner = spinner()
  detectSpinner.start("Detecting installed agents")
  const detected = CLIENTS.filter((client) =>
    commandExists(CLIENT_COMMANDS[client]),
  )
  detectSpinner.stop(
    detected.length > 0
      ? `Detected ${detected.length} agent${detected.length === 1 ? "" : "s"}`
      : "No supported agents detected",
  )
  const agents = await multiselect({
    message: "Which agents should get memory hooks?",
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
  return promptValue(agents) as Client[]
}

export async function promptInitWizard(
  current: InitPromptState,
): Promise<InitPromptAnswers> {
  printWizardHeader()

  const answers: InitPromptAnswers = {}
  if (current.memory === undefined) {
    answers.memory = await promptConfirm(
      "Enable local agent memory for this repo? (writes .ai/memory, capture skills/rule, and host hooks)",
      true,
    )
  }
  if (
    current.agents.length === 0 &&
    (current.mcp || current.memory === true || answers.memory === true)
  ) {
    answers.agents = await promptAgents()
  }
  if (current.mcp) {
    Object.assign(answers, await promptMcpAuth(current))
  }
  if (!current.scope) {
    answers.scope = await promptSelect<"repo" | "user" | "both">({
      message: "Where should ctxpipe apply setup?",
      initial: "repo",
      choices: [
        {
          title: "This repo",
          value: "repo",
          description:
            "Write project files such as .ctxpipe/config.json and MCP config.",
        },
        {
          title: "Globally",
          value: "user",
          description:
            "Configure supported clients for your whole machine when possible.",
        },
        {
          title: "Both",
          value: "both",
          description: "Set up this repo and your user-level client config.",
        },
      ],
    })
  }

  return answers
}

export async function promptMcpWizard(
  current: McpPromptState,
): Promise<McpPromptAnswers> {
  printWizardHeader()
  log.step("MCP")
  log.message(
    muted(
      "Choose the clients ctxpipe should configure for this machine or repo.",
    ),
  )

  const answers: McpPromptAnswers = {}
  if (current.clients.length === 0) {
    answers.clients = await promptAgents()
  }
  Object.assign(answers, await promptMcpAuth(current))
  if (!current.scope) {
    answers.scope = await promptSelect<"repo" | "user" | "both">({
      message: "Where should ctxpipe configure MCP?",
      initial: "repo",
      choices: [
        { title: "This repo", value: "repo" },
        { title: "Globally", value: "user" },
        { title: "Both", value: "both" },
      ],
    })
  }
  return answers
}

async function promptMcpAuth(current: { auth: string | null }): Promise<{
  auth?: McpAuthMode
}> {
  const answers: { auth?: McpAuthMode } = {}
  if (!current.auth) {
    answers.auth = await promptSelect<McpAuthMode>({
      message: "How should this machine authenticate MCP?",
      initial: "oauth",
      choices: [
        {
          title: "OAuth (recommended)",
          value: "oauth",
          description:
            "URL-only config. The client opens a browser to sign in.",
        },
        {
          title: "API key",
          value: "api-key",
          description:
            "Write an x-api-key header that interpolates CTXPIPE_API_KEY. Mint organisation keys in Organisation settings; personal keys under User account.",
        },
      ],
    })
  }
  if ((answers.auth ?? current.auth) === "api-key") {
    log.message(
      muted(
        `${MCP_API_KEY_MINT_HINT} Set CTXPIPE_API_KEY in the MCP client environment. The CLI writes a placeholder, not the secret.`,
      ),
    )
  }
  return answers
}

async function promptAgents(): Promise<Client[]> {
  const detectSpinner = spinner()
  detectSpinner.start("Detecting installed agents")
  const detected = CLIENTS.filter((client) =>
    commandExists(CLIENT_COMMANDS[client]),
  )
  detectSpinner.stop(
    detected.length > 0
      ? `Detected ${detected.length} agent${detected.length === 1 ? "" : "s"}`
      : "No supported agents detected",
  )
  const agents = await multiselect({
    message: "Which agents should use ctxpipe?",
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
  return promptValue(agents) as Client[]
}

async function promptSelect<T extends string>({
  message,
  choices,
  initial,
}: {
  message: string
  choices: Choice<T>[]
  initial?: string
}): Promise<T> {
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
  return promptValue(answer) as T
}

export async function promptConfirm(
  message: string,
  initial: boolean,
): Promise<boolean> {
  const answer = await confirmPrompt({
    message,
    initialValue: initial,
  })
  return promptValue(answer) as boolean
}

function promptValue<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new Error("Setup cancelled")
  }
  return value
}
