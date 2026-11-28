import {
  JEV_PROVIDER,
  knowledgePlaneSettingsProblem,
} from "../../../../packages/aws-cdk/src/knowledge-plane-settings.js"
/**
 * The env contract of the two self-host deployments (CTX-1743): the
 * `@ctxpipe/aws-cdk` construct and the Compose `deploy` profile. Two tests
 * apply it. `packages/aws-cdk/src/env-contract.test.ts` applies it to each
 * container of the synth output. `deploy-env.contract.test.ts` here applies
 * it to `docker compose --profile deploy config`.
 *
 * The operator gives every setting of the self-host docs. Then the env of
 * each service must pass the start check of its own app (`parseEnv`), the
 * knowledge plane rule (`knowledgePlaneSettingsProblem`), and hold each
 * setting of `SERVICE_SETTINGS`.
 */
import { parseEnv as parseCodesearchEnv } from "../../../codesearch/src/config/env.js"
import { parseEnv } from "./env.js"

type Deployment = "construct" | "compose"

type Service = "backend" | "worker" | "codesearch"

const parsers: Record<Service, (env: Record<string, string>) => unknown> = {
  backend: parseEnv,
  worker: parseEnv,
  codesearch: parseCodesearchEnv,
}

export const SERVICES = Object.keys(parsers) as Service[]

/**
 * The settings that each service must get: in `all` deployments, or only in
 * one. `parseEnv` cannot see a dropped setting, because the schema makes it
 * optional.
 */
const SERVICE_SETTINGS: Record<
  Service,
  Partial<Record<"all" | Deployment, readonly string[]>>
> = {
  backend: {
    all: [
      "DATABASE_URL",
      "AUTH_SECRET",
      "AUTH_BASE_URL",
      "CODESEARCH_URL",
      "CLICKHOUSE_URL",
      "MODEL_PROVIDER_ALLOWLIST",
      "SMTP_CONNECTION_URL",
      "EMAIL_FROM_ADDRESS",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_SLUG",
    ],
    // The construct and its docs page offer GitHub sign-in only.
    compose: [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
    ],
  },
  worker: {
    all: [
      "DATABASE_URL",
      "AUTH_SECRET",
      "CLICKHOUSE_URL",
      "MODEL_PROVIDER_ALLOWLIST",
      // Only the worker reads images (the knowledge plane projection).
      "MODEL_VISION_NAME",
      "GITHUB_APP_ID",
      "GITHUB_PRIVATE_KEY",
    ],
    // Without it, the worker uses http://codesearch:3001, the Compose service.
    construct: ["CODESEARCH_URL"],
  },
  codesearch: { all: ["DATABASE_URL", "AUTH_SECRET"] },
}

/**
 * The known gaps on `main`: the reviewed list of findings, each with the
 * Linear issue that removes it. A new finding fails the test of its
 * deployment. A listed finding that does not occur also fails it, so
 * remove the entry in the change that fixes the gap. The list only gets
 * shorter.
 */
const KNOWN_GAPS: ReadonlyArray<{
  readonly issue: string
  readonly findings: readonly string[]
}> = [
  {
    // The construct sets no allowlist and no vision model, and its Bedrock
    // kind cannot reach OpenRouter.
    issue: "CTX-1738",
    findings: [
      "construct backend (bedrock): plane not-openrouter",
      "construct backend: missing MODEL_PROVIDER_ALLOWLIST",
      "construct worker (bedrock): plane not-openrouter",
      "construct worker: missing MODEL_PROVIDER_ALLOWLIST",
      "construct worker: missing MODEL_VISION_NAME",
    ],
  },
  {
    issue: "CTX-1739",
    findings: ["construct backend: missing GITHUB_APP_SLUG"],
  },
  {
    // Compose does not pass the vision model, email, social sign-in and the
    // GitHub App settings.
    issue: "CTX-1740",
    findings: [
      "compose backend: missing EMAIL_FROM_ADDRESS",
      "compose backend: missing GITHUB_APP_ID",
      "compose backend: missing GITHUB_APP_SLUG",
      "compose backend: missing GITHUB_CLIENT_ID",
      "compose backend: missing GITHUB_CLIENT_SECRET",
      "compose backend: missing GITHUB_PRIVATE_KEY",
      "compose backend: missing GITHUB_WEBHOOK_SECRET",
      "compose backend: missing GOOGLE_CLIENT_ID",
      "compose backend: missing GOOGLE_CLIENT_SECRET",
      "compose backend: missing MICROSOFT_CLIENT_ID",
      "compose backend: missing MICROSOFT_CLIENT_SECRET",
      "compose backend: missing SMTP_CONNECTION_URL",
      "compose worker: missing GITHUB_APP_ID",
      "compose worker: missing GITHUB_PRIVATE_KEY",
      "compose worker: missing MODEL_VISION_NAME",
    ],
  },
]

/** The known findings of a deployment, sorted. */
export function knownFindings(deployment: Deployment): string[] {
  const all = KNOWN_GAPS.flatMap(({ findings }) => findings)
  // An entry that names neither deployment would pass both tests unseen.
  const stray = all.filter((finding) => !/^(construct|compose) /.test(finding))
  if (stray.length)
    throw new Error(`KNOWN_GAPS names no deployment: ${stray.join(", ")}`)
  return all.filter((finding) => finding.startsWith(`${deployment} `)).sort()
}

/** A valid sample value of a setting, for a value that the test cannot know. */
export function sampleValue(name: string): string {
  if (name === "EMAIL_FROM_ADDRESS") return "noreply@example.com"
  if (name === "MODEL_PROVIDER_ALLOWLIST") return `azure,${JEV_PROVIDER}`
  if (/_(URL|URI)$/.test(name)) return "https://set.example.com/"
  // 64 hex characters: valid for AUTH_SECRET (32 or more characters) and
  // CONNECTION_SECRETS_ENCRYPTION_KEY (a 32-byte hex key).
  return "0123456789abcdef".repeat(4)
}

/** Each setting that the operator gives: a sample value for each name. */
export function operatorSettings(): Record<string, string> {
  const settings: Record<string, string> = {}
  for (const lists of Object.values(SERVICE_SETTINGS))
    for (const name of Object.values(lists).flat())
      settings[name] = sampleValue(name)
  return settings
}

/**
 * The problems of one service env. A plane problem names its `label` (for
 * example the model kind), because only some configurations have it.
 */
export function serviceFindings(
  deployment: Deployment,
  service: Service,
  env: Record<string, string>,
  label?: string,
): string[] {
  const findings: string[] = []
  const add = (problem: string, labelled = false) =>
    findings.push(
      `${deployment} ${service}${labelled && label ? ` (${label})` : ""}: ${problem}`,
    )
  try {
    parsers[service](env)
  } catch (error) {
    const issues = (
      error as { issues?: Array<{ path: unknown[]; message: string }> }
    ).issues ?? [{ path: [], message: String(error) }]
    for (const issue of issues)
      add(`parseEnv ${issue.path.join(".")}: ${issue.message}`)
  }
  if (service !== "codesearch") {
    const plane = knowledgePlaneSettingsProblem(env)
    if (plane) add(`plane ${plane.code}`, true)
  }
  const { all = [], [deployment]: own = [] } = SERVICE_SETTINGS[service]
  for (const name of [...all, ...own])
    if (!env[name]?.trim()) add(`missing ${name}`)
  return findings
}
