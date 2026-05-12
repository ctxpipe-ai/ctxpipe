import { resolve } from "node:path"
import {
  confirm as confirmPrompt,
  isCancel,
  log,
  multiselect,
  select,
  spinner,
  text,
} from "@clack/prompts"
import { CLIENT_COMMANDS, CLIENT_LABELS, CLIENTS, type Client } from "./constants.js"
import {
  fetchOrganizations,
  fetchSession,
  loginWithDeviceFlow,
  orgLabel,
  readStoredAuth,
  userLabel,
} from "./auth.js"
import type { Organization } from "./auth.js"
import { readJsonObject } from "./fs-operations.js"
import { commandExists } from "./system.js"
import { muted, printWizardHeader } from "./ui.js"

type Choice<T extends string> = {
  title: string
  value: T
  description?: string
}

export type InitPromptState = {
  org: string | null
  baseUrl: string
  agents: string[]
  scope: string | null
  mcp: boolean
}

export type InitPromptAnswers = {
  org?: string
  scope?: "repo" | "user" | "both"
  agents?: Client[]
}

export type McpPromptState = {
  org: string | null
  clients: string[]
  scope: string | null
}

export type McpPromptAnswers = {
  org?: string
  scope?: "repo" | "user" | "both"
  clients?: Client[]
}

export async function promptInitWizard(
  current: InitPromptState,
): Promise<InitPromptAnswers> {
  printWizardHeader()

  const answers: InitPromptAnswers = {}
  if (!current.org) {
    answers.org = await promptSetupOrg(current.baseUrl)
  }
  if (!current.scope) {
    answers.scope = await promptSelect<"repo" | "user" | "both">({
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
  if (current.mcp && current.agents.length === 0) {
    answers.agents = await promptAgents()
  }

  return answers
}

async function promptSetupOrg(baseUrl: string): Promise<string> {
  const fallbackOrg = detectDefaultOrgSlug()
  let auth = readStoredAuth(baseUrl)
  let orgs: Organization[] = []
  let session: Record<string, unknown> | null = null

  if (auth) {
    const sessionSpinner = spinner()
    sessionSpinner.start("Checking existing ctx| session")
    try {
      ;[orgs, session] = await Promise.all([
        fetchOrganizations({ baseUrl, accessToken: auth.accessToken }).catch(() => []),
        fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(() => null),
      ])
      sessionSpinner.stop(
        orgs.length > 0 ? "Loaded ctx| organizations" : "Sign-in required",
      )
    } catch (error) {
      sessionSpinner.stop("Could not check saved sign-in")
      throw error
    }
  }

  if (orgs.length === 0) {
    log.step("Sign in")
    log.message(muted("Sign in to ctx| so we can load your organizations."))
    auth = await loginWithDeviceFlow({ baseUrl })
    const orgSpinner = spinner()
    orgSpinner.start("Loading ctx| organizations")
    try {
      ;[orgs, session] = await Promise.all([
        fetchOrganizations({ baseUrl, accessToken: auth.accessToken }),
        fetchSession({ baseUrl, accessToken: auth.accessToken }).catch(() => null),
      ])
      orgSpinner.stop("Loaded ctx| organizations")
    } catch (error) {
      orgSpinner.stop("Could not load ctx| organizations")
      throw error
    }
  }

  const label = userLabel(session)
  if (label) {
    log.success(`Signed in as ${label}.`)
  }

  if (orgs.length === 1) {
    const org = orgs[0]
    if (!org) throw new Error("Could not load ctx| organization")
    log.step("Organization")
    log.message(orgLabel(org))
    return org.slug
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

export async function promptMcpWizard(
  current: McpPromptState,
): Promise<McpPromptAnswers> {
  printWizardHeader()
  log.step("MCP")
  log.message(muted("Choose the clients ctxpipe should configure for this machine or repo."))

  const answers: McpPromptAnswers = {}
  if (!current.org) {
    answers.org = await promptText({
      message: "Which ctx| organization should this MCP server use?",
      initial: detectDefaultOrgSlug(),
    })
  }
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
  if (current.clients.length === 0) {
    answers.clients = await promptAgents()
  }
  return answers
}

async function promptAgents(): Promise<Client[]> {
  const detectSpinner = spinner()
  detectSpinner.start("Detecting installed agents")
  const detected = CLIENTS.filter((client) => commandExists(CLIENT_COMMANDS[client]))
  detectSpinner.stop(
    detected.length > 0
      ? `Detected ${detected.length} agent${detected.length === 1 ? "" : "s"}`
      : "No supported agents detected",
  )
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
  return promptValue(agents) as Client[]
}

async function promptText({
  message,
  initial,
}: {
  message: string
  initial?: string
}): Promise<string> {
  const answer = await text({
    message,
    initialValue: initial,
    validate: (value) => (String(value).trim() ? undefined : "Required"),
  })
  return String(promptValue(answer)).trim()
}

export function detectDefaultOrgSlug(): string | undefined {
  const existing = readJsonObject(resolve(process.cwd(), ".ctxpipe", "config.json"))
  if (typeof existing.orgSlug === "string" && existing.orgSlug.trim()) {
    return existing.orgSlug
  }
  return process.env.CTXPIPE_ORG_SLUG || process.env.CTXPIPE_ORG || undefined
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
