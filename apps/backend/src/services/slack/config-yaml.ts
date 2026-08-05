import { parse as parseYaml, stringify } from "yaml"
import { z } from "zod"

export const SLACK_CONFIG_PATH = "slack/config.yaml"

const slackConfigFileSchema = z.object({
  version: z.number().optional(),
  source: z.literal("slack").optional(),
  teamId: z.string().optional(),
  retention: z
    .object({
      oldestDays: z.number().int().positive().max(3650).optional(),
    })
    .optional(),
  channels: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        isPrivate: z.boolean().optional(),
      }),
    )
    .default([]),
})

export type ParsedSlackRepoConfig = {
  teamId?: string
  oldestDays: number
  channels: Array<{ channelId: string; name: string; isPrivate: boolean }>
}

function sortChannels(
  channels: ParsedSlackRepoConfig["channels"],
): ParsedSlackRepoConfig["channels"] {
  return [...channels].sort((a, b) => a.channelId.localeCompare(b.channelId))
}

export function parseSlackConfigYamlContent(
  raw: string | undefined,
): ParsedSlackRepoConfig | undefined {
  if (raw == null) return undefined
  if (raw.trim() === "") {
    return { oldestDays: 90, channels: [] }
  }
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return undefined
  }
  if (parsed === null || parsed === undefined) {
    return { oldestDays: 90, channels: [] }
  }
  const decoded = slackConfigFileSchema.safeParse(parsed)
  if (!decoded.success) return undefined
  return {
    teamId: decoded.data.teamId,
    oldestDays: decoded.data.retention?.oldestDays ?? 90,
    channels: decoded.data.channels.map((channel) => ({
      channelId: channel.id,
      name: channel.name ?? channel.id,
      isPrivate: channel.isPrivate === true,
    })),
  }
}

export function renderSlackConfigYaml(input: {
  teamId?: string | null
  oldestDays: number
  channels: Array<{ channelId: string; name: string; isPrivate: boolean }>
}): string {
  return stringify({
    version: 1,
    source: "slack",
    teamId: input.teamId ?? undefined,
    retention: { oldestDays: input.oldestDays },
    channels: sortChannels(input.channels).map((channel) => ({
      id: channel.channelId,
      name: channel.name,
      isPrivate: channel.isPrivate,
    })),
  })
}

export function hasSlackConfigYamlChanged(input: {
  current: string | undefined
  next: string
}): boolean {
  const a = parseSlackConfigYamlContent(input.current)
  const b = parseSlackConfigYamlContent(input.next)
  if (a && b) {
    return (
      JSON.stringify({
        teamId: a.teamId ?? null,
        oldestDays: a.oldestDays,
        channels: sortChannels(a.channels),
      }) !==
      JSON.stringify({
        teamId: b.teamId ?? null,
        oldestDays: b.oldestDays,
        channels: sortChannels(b.channels),
      })
    )
  }
  return (input.current ?? "").trim() !== input.next.trim()
}

export function getSlackConfigPullRequestPayload(input: { orgSlug: string }) {
  return {
    title: "Update Slack sync configuration",
    body: [
      "This PR updates `slack/config.yaml` from the Slack connector settings.",
      "",
      "Selected channels are mirrored as Markdown threads under `slack/channels/`.",
      "Private channels are included only when explicitly listed and the bot is a member.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(slack): update sync config.yaml",
  }
}
