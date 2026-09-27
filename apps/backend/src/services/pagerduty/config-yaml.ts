import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

const PagerdutyConfigServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url().optional(),
})

const PagerdutyConfigFileSchema = z.object({
  version: z.literal(1).default(1),
  source: z.literal("pagerduty").default("pagerduty"),
  account: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    subdomain: z.string().min(1),
    region: z.enum(["us", "eu"]),
  }),
  scope: z
    .object({
      services: z.array(PagerdutyConfigServiceSchema).default([]),
    })
    .default({ services: [] }),
})

export type PagerdutyConfigService = {
  id: string
  name: string
  url?: string
}

export type ParsedPagerdutyRepoConfig = {
  accountId: string
  accountName: string
  accountSubdomain: string
  region: "us" | "eu"
  services: PagerdutyConfigService[]
}

function sortServices(
  services: PagerdutyConfigService[],
): PagerdutyConfigService[] {
  return [...services].sort((left, right) => left.id.localeCompare(right.id))
}

export function parsePagerdutyConfigYamlContent(
  raw: string | undefined,
): ParsedPagerdutyRepoConfig | undefined {
  if (raw == null || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  const decoded = PagerdutyConfigFileSchema.safeParse(parsed)
  if (!decoded.success) return undefined
  const ids = decoded.data.scope.services.map((service) => service.id)
  if (new Set(ids).size !== ids.length) return undefined
  return {
    accountId: decoded.data.account.id,
    accountName: decoded.data.account.name,
    accountSubdomain: decoded.data.account.subdomain,
    region: decoded.data.account.region,
    services: sortServices(decoded.data.scope.services),
  }
}

export function renderPagerdutyConfigYaml(input: {
  accountId: string
  accountName: string
  accountSubdomain: string
  region: "us" | "eu"
  services: PagerdutyConfigService[]
}): string {
  return stringify({
    version: 1,
    source: "pagerduty",
    account: {
      id: input.accountId,
      name: input.accountName,
      subdomain: input.accountSubdomain,
      region: input.region,
    },
    scope: {
      services: sortServices(input.services).map((service) => ({
        id: service.id,
        name: service.name,
        ...(service.url ? { url: service.url } : {}),
      })),
    },
  })
}

export function pagerdutyServicesEqual(
  left: PagerdutyConfigService[],
  right: PagerdutyConfigService[],
): boolean {
  return (
    JSON.stringify(sortServices(left).map((service) => [service.id, service.name, service.url ?? ""])) ===
    JSON.stringify(sortServices(right).map((service) => [service.id, service.name, service.url ?? ""]))
  )
}

export function hasPagerdutyConfigYamlChanged(input: {
  current: string | undefined
  next: string
}): boolean {
  const current = parsePagerdutyConfigYamlContent(input.current)
  const next = parsePagerdutyConfigYamlContent(input.next)
  return current && next
    ? JSON.stringify(current) !== JSON.stringify(next)
    : (input.current ?? "").trim() !== input.next.trim()
}

export function getPagerdutyConfigPullRequestPayload(input: {
  orgSlug: string
}) {
  return {
    title: "Update PagerDuty sync configuration",
    body: [
      "This PR updates `pagerduty/config.yaml` from the PagerDuty connector settings.",
      "",
      "Selected services determine which incidents are mirrored. Alert payloads are folded into each incident file.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(pagerduty): update sync config.yaml",
  }
}
