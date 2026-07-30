import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

const notionConfigFileSchema = z.object({
  version: z.number().optional(),
  source: z.literal("notion").optional(),
  resources: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["page", "database"]),
        title: z.string().optional(),
      }),
    )
    .default([]),
})

export type ParsedNotionRepoConfig = {
  resources: Array<{
    externalId: string
    type: "page" | "database"
    title: string
  }>
}

function sortNotionResources(
  resources: ParsedNotionRepoConfig["resources"],
): ParsedNotionRepoConfig["resources"] {
  return [...resources].sort((a, b) =>
    `${a.type}:${a.externalId}`.localeCompare(`${b.type}:${b.externalId}`),
  )
}

function parseNotionConfigDocument(raw: string | undefined):
  | {
      version: number
      source: "notion"
      resources: ParsedNotionRepoConfig["resources"]
    }
  | undefined {
  if (raw == null) return undefined
  if (raw.trim() === "") {
    return { version: 1, source: "notion", resources: [] }
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  if (parsed === null || parsed === undefined) {
    return { version: 1, source: "notion", resources: [] }
  }
  const decoded = notionConfigFileSchema.safeParse(parsed)
  if (!decoded.success) return undefined
  return {
    version: decoded.data.version ?? 1,
    source: decoded.data.source ?? "notion",
    resources: decoded.data.resources.map((resource) => ({
      externalId: resource.id,
      type: resource.type,
      title: resource.title ?? "Untitled",
    })),
  }
}

export function parseNotionConfigYamlContent(
  raw: string | undefined,
): ParsedNotionRepoConfig | undefined {
  const parsed = parseNotionConfigDocument(raw)
  return parsed ? { resources: parsed.resources } : undefined
}

export function renderNotionConfigYaml(input: {
  resources: Array<{
    externalId: string
    type: "page" | "database"
    title: string
  }>
}): string {
  return stringify({
    version: 1,
    source: "notion",
    resources: sortNotionResources(input.resources).map((resource) => ({
      id: resource.externalId,
      type: resource.type,
      title: resource.title,
    })),
  })
}

export function hasNotionConfigYamlChanged(input: {
  current: string | undefined
  next: string
}): boolean {
  const currentConfig = parseNotionConfigDocument(input.current)
  const nextConfig = parseNotionConfigDocument(input.next)
  if (currentConfig && nextConfig) {
    return (
      JSON.stringify({
        ...currentConfig,
        resources: sortNotionResources(currentConfig.resources),
      }) !==
      JSON.stringify({
        ...nextConfig,
        resources: sortNotionResources(nextConfig.resources),
      })
    )
  }
  return (input.current ?? "").trim() !== input.next.trim()
}

export function getNotionConfigPullRequestPayload(input: { orgSlug: string }) {
  return {
    title: "Update Notion sync configuration",
    body: [
      "This PR updates `notion/config.yaml` from the Notion connector settings.",
      "",
      "Selected page resources include their descendant pages; selected databases include their rows.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(notion): update sync config.yaml",
  }
}
