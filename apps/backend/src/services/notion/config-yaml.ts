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

export function parseNotionConfigYamlContent(
  raw: string | undefined,
): ParsedNotionRepoConfig | undefined {
  if (raw == null) return undefined
  if (raw.trim() === "") return { resources: [] }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  if (parsed === null || parsed === undefined) return { resources: [] }
  const decoded = notionConfigFileSchema.safeParse(parsed)
  if (!decoded.success) return undefined
  return {
    resources: decoded.data.resources.map((resource) => ({
      externalId: resource.id,
      type: resource.type,
      title: resource.title ?? "Untitled",
    })),
  }
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
    resources: input.resources.map((resource) => ({
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
  return (input.current ?? "").trim() !== input.next.trim()
}

export function getNotionConfigPullRequestPayload(input: { orgSlug: string }) {
  return {
    title: "Update Notion sync configuration",
    body: [
      "This PR updates `notion/config.yaml` from the Notion connector settings.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(notion): update sync config.yaml",
  }
}
