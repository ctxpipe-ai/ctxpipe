import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

const confluenceConfigFileSchema = z.object({
  version: z.number().optional(),
  source: z.literal("confluence").optional(),
  spaces: z.array(
    z.object({
      key: z.string(),
      selectedPageIds: z.array(z.string()).nullable().optional(),
    }),
  ),
})

export type ParsedConfluenceRepoConfig = {
  spaces: Array<{ spaceKey: string; selectedPageIds: string[] | null }>
}

/** Parse `confluence/config.yaml` body from Git; returns undefined when invalid. */
export function parseConfluenceConfigYamlContent(
  raw: string | undefined,
): ParsedConfluenceRepoConfig | undefined {
  if (raw == null || raw.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  const decoded = confluenceConfigFileSchema.safeParse(parsed)
  if (!decoded.success) return undefined
  return {
    spaces: decoded.data.spaces.map((s) => ({
      spaceKey: s.key,
      selectedPageIds:
        s.selectedPageIds === undefined || s.selectedPageIds === null
          ? null
          : [...s.selectedPageIds],
    })),
  }
}

export function renderConfluenceConfigYaml(input: {
  spaces: Array<{ spaceKey: string; selectedPageIds: string[] | null }>
}): string {
  const payload = {
    version: 1,
    source: "confluence",
    spaces: input.spaces.map((space) => ({
      key: space.spaceKey,
      selectedPageIds: space.selectedPageIds ?? [],
    })),
  }
  return stringify(payload)
}

export function hasConfigYamlChanged(input: {
  current: string | undefined
  next: string
}): boolean {
  const current = (input.current ?? "").trim()
  const next = input.next.trim()
  return current !== next
}

export function getConfigPullRequestPayload(input: { orgSlug: string }) {
  return {
    title: "Update Confluence sync configuration",
    body: [
      "This PR updates `confluence/config.yaml` from the Atlassian connector settings.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(confluence): update sync config.yaml",
  }
}
