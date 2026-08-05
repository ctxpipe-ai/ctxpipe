import slugify from "@sindresorhus/slugify"

const MANAGED_ROOT = "slack"

export type SlackMirrorMessage = {
  ts: string
  userId?: string
  userDisplay?: string
  text: string
  /** Relative asset paths already written under the thread folder. */
  assetLinks?: Array<{ label: string; path: string }>
}

export function getManagedSlackRootPath(): string {
  return `${MANAGED_ROOT}/`
}

function titleSlug(title: string): string {
  const s = slugify(title, { lowercase: true })
  return s.length > 0 ? s : "channel"
}

export function getSlackChannelIndexPath(input: {
  channelId: string
  channelName: string
}): string {
  return `${MANAGED_ROOT}/channels/${titleSlug(input.channelName)}--${input.channelId}/index.md`
}

export function getSlackThreadDirPath(input: {
  channelId: string
  channelName: string
  threadTs: string
}): string {
  const d = new Date(Number(input.threadTs) * 1000)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${MANAGED_ROOT}/channels/${titleSlug(input.channelName)}--${input.channelId}/threads/${yyyy}/${mm}/${input.threadTs}`
}

export function getSlackThreadPath(input: {
  channelId: string
  channelName: string
  threadTs: string
}): string {
  return `${getSlackThreadDirPath(input)}/index.md`
}

export function getSlackThreadAssetPath(input: {
  channelId: string
  channelName: string
  threadTs: string
  fileId: string
  fileName: string
}): string {
  const safeName = titleSlug(input.fileName.replace(/\.[^.]+$/, "")) || "file"
  const extMatch = input.fileName.match(/(\.[a-zA-Z0-9]{1,12})$/)
  const ext = extMatch?.[1] ?? ""
  const dir = getSlackThreadPath({
    channelId: input.channelId,
    channelName: input.channelName,
    threadTs: input.threadTs,
  }).replace(/\/index\.md$/, "")
  return `${dir}/assets/${input.fileId}--${safeName}${ext}`
}

/** Minimal mrkdwn → Markdown (links, code, bold/italic approximations). */
export function slackMrkdwnToMarkdown(text: string): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, "#$2")
    .replace(/<#([A-Z0-9]+)>/g, "#$1")
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

export function toSlackChannelIndexFile(input: {
  channelId: string
  channelName: string
  isPrivate: boolean
  teamId?: string | null
  topic?: string | null
  purpose?: string | null
}): { path: string; content: string } {
  const path = getSlackChannelIndexPath(input)
  const frontmatter = [
    "---",
    "source: slack",
    `channel_id: ${JSON.stringify(input.channelId)}`,
    `channel_name: ${JSON.stringify(input.channelName)}`,
    `is_private: ${input.isPrivate}`,
    input.teamId ? `team_id: ${JSON.stringify(input.teamId)}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n")
  const body = [
    `# #${input.channelName}`,
    "",
    input.isPrivate ? "_Private channel._" : "_Public channel._",
    input.topic ? `\n**Topic:** ${input.topic}` : null,
    input.purpose ? `\n**Purpose:** ${input.purpose}` : null,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n")
  return { path, content: `${frontmatter}\n\n${body}` }
}

export function toSlackThreadMarkdownFile(input: {
  channelId: string
  channelName: string
  isPrivate: boolean
  teamId?: string | null
  threadTs: string
  permalink?: string | null
  messages: SlackMirrorMessage[]
}): { path: string; content: string } {
  const path = getSlackThreadPath(input)
  const participants = [
    ...new Set(
      input.messages
        .map((m) => m.userId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const oldest = input.messages[0]?.ts
  const latest = input.messages[input.messages.length - 1]?.ts
  const frontmatter = [
    "---",
    "source: slack",
    `channel_id: ${JSON.stringify(input.channelId)}`,
    `channel_name: ${JSON.stringify(input.channelName)}`,
    `is_private: ${input.isPrivate}`,
    `thread_ts: ${JSON.stringify(input.threadTs)}`,
    input.teamId ? `team_id: ${JSON.stringify(input.teamId)}` : null,
    input.permalink ? `permalink: ${JSON.stringify(input.permalink)}` : null,
    `message_count: ${input.messages.length}`,
    `participant_ids: ${JSON.stringify(participants)}`,
    oldest ? `oldest: ${JSON.stringify(oldest)}` : null,
    latest ? `latest: ${JSON.stringify(latest)}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n")

  const bodyLines: string[] = [
    `# Thread in #${input.channelName}`,
    "",
  ]
  for (const message of input.messages) {
    const who = message.userDisplay ?? message.userId ?? "unknown"
    const when = new Date(Number(message.ts) * 1000).toISOString()
    bodyLines.push(`### ${who} · ${when}`, "")
    bodyLines.push(slackMrkdwnToMarkdown(message.text || "_(empty)_"), "")
    for (const asset of message.assetLinks ?? []) {
      bodyLines.push(`- [${asset.label}](${asset.path})`)
    }
    if ((message.assetLinks?.length ?? 0) > 0) bodyLines.push("")
  }

  return { path, content: `${frontmatter}\n\n${bodyLines.join("\n")}` }
}
