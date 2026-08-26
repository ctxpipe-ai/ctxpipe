import { extname } from "node:path"
import slugify from "@sindresorhus/slugify"
import { canonicalConnectorAssetUrl, gitBlobSha } from "../connectors/assets.js"

const MANAGED_ROOT = "slack"

export type SlackCaptureAssetLink = {
  label: string
  path: string
  kind: "image" | "file"
}

export type SlackCaptureMessage = {
  ts: string
  userId?: string
  userDisplay?: string
  text: string
  assetLinks?: SlackCaptureAssetLink[]
}

export type SlackCollectedMedia = {
  sourceKey: string
  filename: string
  downloadUrl?: string
  permalink?: string
  mimetype?: string
}

export type SlackMediaFile = {
  id?: string
  name?: string
  title?: string
  mimetype?: string
  permalink?: string
  permalink_public?: string
  url_private?: string
  url_private_download?: string
}

export type SlackMediaMessage = {
  text?: string
  files?: SlackMediaFile[]
  blocks?: unknown[]
  attachments?: Array<{
    image_url?: string
    thumb_url?: string
    video_url?: string
    title?: string
    is_app_unfurl?: boolean
    is_msg_unfurl?: boolean
    files?: SlackMediaFile[]
  }>
}

export function getManagedSlackRootPath(): string {
  return `${MANAGED_ROOT}/`
}

function titleSlug(title: string): string {
  const s = slugify(title, { lowercase: true })
  return s.length > 0 ? s : "channel"
}

export type SlackChannelPathInput = {
  channelId: string
  channelName: string
  /** Already-slugified directory segment; display name stays `channelName`. */
  pathSlug?: string
}

function channelPathSegment(input: SlackChannelPathInput): string {
  const slug = input.pathSlug?.trim()
  return slug && slug.length > 0 ? slug : titleSlug(input.channelName)
}

export function getSlackChannelIndexPath(input: SlackChannelPathInput): string {
  return `${MANAGED_ROOT}/channels/${channelPathSegment(input)}--${input.channelId}/index.md`
}

export function getSlackThreadDirPath(
  input: SlackChannelPathInput & { threadTs: string },
): string {
  const d = new Date(Number(input.threadTs) * 1000)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${MANAGED_ROOT}/channels/${channelPathSegment(input)}--${input.channelId}/threads/${yyyy}/${mm}/${input.threadTs}`
}

export function getSlackThreadPath(
  input: SlackChannelPathInput & { threadTs: string },
): string {
  return `${getSlackThreadDirPath(input)}/thread.md`
}

function parseSlackChannelRoot(
  path: string,
): { slug: string; channelId: string } | undefined {
  const segment = path.match(/^slack\/channels\/([^/]+)/)?.[1]
  if (!segment) return undefined
  const split = segment.lastIndexOf("--")
  if (split <= 0 || split + 2 >= segment.length) return undefined
  return {
    slug: segment.slice(0, split),
    channelId: segment.slice(split + 2),
  }
}

function pathContainsThreadTs(path: string, threadTs: string): boolean {
  return (
    path.includes("/threads/") &&
    (path.includes(`/${threadTs}/`) || path.endsWith(`/${threadTs}`))
  )
}

/** Prefer the existing managed root so a channel rename does not fork the tree. */
export function resolveSlackChannelPathSlug(input: {
  existingPaths: readonly string[]
  channelId: string
  threadTs: string
  channelName: string
}): string {
  let fallbackSlug: string | undefined
  for (const path of input.existingPaths) {
    const root = parseSlackChannelRoot(path)
    if (!root || root.channelId !== input.channelId) continue
    if (pathContainsThreadTs(path, input.threadTs)) return root.slug
    fallbackSlug ??= root.slug
  }
  return fallbackSlug ?? titleSlug(input.channelName)
}

export function slackMentionUserIds(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/gi)) {
    const id = match[1]
    if (id) ids.push(id)
  }
  return ids
}

/** Minimal mrkdwn → Markdown (links, code, bold/italic approximations). */
export function slackMrkdwnToMarkdown(
  text: string,
  mentionHandles?: ReadonlyMap<string, string>,
): string {
  return text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, "#$2")
    .replace(/<#([A-Z0-9]+)>/g, "#$1")
    .replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/gi, (_match, userId: string) => {
      const handle = mentionHandles?.get(userId)
      return `@${handle ?? "unknown-user"}`
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

export function toSlackChannelIndexFile(
  input: SlackChannelPathInput & {
    isPrivate: boolean
    teamId?: string | null
    topic?: string | null
    purpose?: string | null
  },
): { path: string; content: string } {
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

function renderAssetLink(asset: SlackCaptureAssetLink): string {
  if (!asset.path) return `[file: ${asset.label} unavailable]`
  if (asset.kind === "image" && !/^(https?:|#)/i.test(asset.path)) {
    return `![${asset.label}](${asset.path})`
  }
  return `[${asset.label}](${asset.path})`
}

export function toSlackThreadMarkdownFile(
  input: SlackChannelPathInput & {
    isPrivate: boolean
    teamId?: string | null
    threadTs: string
    permalink?: string | null
    truncated?: boolean
    capturedAt?: string | null
    capturedBy?: { handle: string; name: string } | null
    mentionHandles?: ReadonlyMap<string, string>
    messages: SlackCaptureMessage[]
  },
): { path: string; content: string } {
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
  const capturedBy = input.capturedBy
  const frontmatter = [
    "---",
    "source: slack",
    `channel_id: ${JSON.stringify(input.channelId)}`,
    `channel_name: ${JSON.stringify(input.channelName)}`,
    `is_private: ${input.isPrivate}`,
    `thread_ts: ${JSON.stringify(input.threadTs)}`,
    input.teamId ? `team_id: ${JSON.stringify(input.teamId)}` : null,
    input.permalink ? `permalink: ${JSON.stringify(input.permalink)}` : null,
    input.capturedAt
      ? `captured_at: ${JSON.stringify(input.capturedAt)}`
      : null,
    capturedBy ? "captured_by:" : null,
    capturedBy ? `  handle: ${JSON.stringify(capturedBy.handle)}` : null,
    capturedBy ? `  name: ${JSON.stringify(capturedBy.name)}` : null,
    `message_count: ${input.messages.length}`,
    input.truncated ? "truncated: true" : null,
    `participant_ids: ${JSON.stringify(participants)}`,
    oldest ? `oldest: ${JSON.stringify(oldest)}` : null,
    latest ? `latest: ${JSON.stringify(latest)}` : null,
    "---",
  ]
    .filter(Boolean)
    .join("\n")

  const bodyLines: string[] = [`# Thread in #${input.channelName}`, ""]
  if (input.truncated) {
    bodyLines.push(
      `_Oldest ${input.messages.length} messages captured; later replies were omitted._`,
      "",
    )
  }
  for (const message of input.messages) {
    const who = message.userDisplay ?? "unknown"
    const when = new Date(Number(message.ts) * 1000).toISOString()
    bodyLines.push(`### ${who} · ${when}`, "")
    bodyLines.push(
      slackMrkdwnToMarkdown(message.text || "_(empty)_", input.mentionHandles),
      "",
    )
    for (const asset of message.assetLinks ?? []) {
      bodyLines.push(renderAssetLink(asset))
    }
    if ((message.assetLinks?.length ?? 0) > 0) bodyLines.push("")
  }

  return { path, content: `${frontmatter}\n\n${bodyLines.join("\n")}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function slackUrlSourceKey(url: string): string {
  return `src-${gitBlobSha(Buffer.from(canonicalConnectorAssetUrl(url))).slice(
    0,
    12,
  )}`
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const leaf = decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).pop() || "",
    )
    return leaf || fallback
  } catch {
    return fallback
  }
}

export function slackMediaFromFile(
  file: SlackMediaFile,
): SlackCollectedMedia | undefined {
  const downloadUrl =
    file.url_private_download?.trim() || file.url_private?.trim() || undefined
  const permalink = file.permalink?.trim() || undefined
  const sourceKey =
    file.id?.trim() ||
    (downloadUrl
      ? slackUrlSourceKey(downloadUrl)
      : permalink
        ? slackUrlSourceKey(permalink)
        : "")
  if (!sourceKey) return undefined
  return {
    sourceKey,
    filename:
      file.name?.trim() || file.title?.trim() || file.id || "attachment",
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(permalink ? { permalink } : {}),
    ...(file.mimetype ? { mimetype: file.mimetype } : {}),
  }
}

function preferredFilename(
  url: string | undefined,
  hint: string | undefined,
): string {
  const fromUrl = url ? filenameFromUrl(url, "") : ""
  if (fromUrl && extname(fromUrl)) return fromUrl
  if (hint?.trim()) return hint.trim()
  return fromUrl || "image"
}

function mediaFromImageFields(input: {
  imageUrl?: string
  slackFile?: { id?: string; url?: string }
  filename?: string
}): SlackCollectedMedia | undefined {
  const slackFileUrl = input.slackFile?.url?.trim()
  const imageUrl = input.imageUrl?.trim()
  const downloadUrl = slackFileUrl || imageUrl
  if (!downloadUrl && !input.slackFile?.id) return undefined
  const sourceKey =
    input.slackFile?.id?.trim() ||
    (downloadUrl ? slackUrlSourceKey(downloadUrl) : "")
  if (!sourceKey) return undefined
  return {
    sourceKey,
    filename: preferredFilename(downloadUrl, input.filename),
    ...(downloadUrl ? { downloadUrl } : {}),
  }
}

function collectImageBlock(
  block: Record<string, unknown>,
): SlackCollectedMedia | undefined {
  const slackFile = isRecord(block.slack_file)
    ? {
        id:
          typeof block.slack_file.id === "string"
            ? block.slack_file.id
            : undefined,
        url:
          typeof block.slack_file.url === "string"
            ? block.slack_file.url
            : undefined,
      }
    : undefined
  const imageUrl =
    typeof block.image_url === "string" ? block.image_url : undefined
  const filename =
    typeof block.alt_text === "string"
      ? block.alt_text
      : typeof block.title === "string"
        ? block.title
        : isRecord(block.title) && typeof block.title.text === "string"
          ? block.title.text
          : undefined
  return mediaFromImageFields({ imageUrl, slackFile, filename })
}

function collectExplicitBlockMedia(blocks: unknown[]): SlackCollectedMedia[] {
  const collected: SlackCollectedMedia[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === "video") {
      const title =
        typeof block.title === "string"
          ? block.title
          : isRecord(block.title) && typeof block.title.text === "string"
            ? block.title.text
            : undefined
      for (const field of ["video_url", "thumbnail_url"] as const) {
        const url = typeof block[field] === "string" ? block[field] : undefined
        const media = mediaFromImageFields({
          imageUrl: url,
          filename:
            field === "thumbnail_url" && title ? `${title}-thumbnail` : title,
        })
        if (media) collected.push(media)
      }
      continue
    }
    if (block.type === "image") {
      const media = collectImageBlock(block)
      if (media) collected.push(media)
      continue
    }
    if (block.type === "file") {
      const slackFile = isRecord(block.slack_file)
        ? {
            id:
              typeof block.slack_file.id === "string"
                ? block.slack_file.id
                : typeof block.file_id === "string"
                  ? block.file_id
                  : undefined,
            url:
              typeof block.slack_file.url === "string"
                ? block.slack_file.url
                : undefined,
          }
        : typeof block.file_id === "string"
          ? { id: block.file_id }
          : undefined
      const media = mediaFromImageFields({ slackFile })
      if (media) collected.push(media)
      continue
    }
    if (
      block.type === "section" &&
      isRecord(block.accessory) &&
      block.accessory.type === "image"
    ) {
      const media = collectImageBlock(block.accessory)
      if (media) collected.push(media)
      continue
    }
    if (block.type === "context" && Array.isArray(block.elements)) {
      for (const element of block.elements) {
        if (isRecord(element) && element.type === "image") {
          const media = collectImageBlock(element)
          if (media) collected.push(media)
        }
      }
    }
  }
  return collected
}

export function collectSlackMessageMedia(
  message: SlackMediaMessage,
): SlackCollectedMedia[] {
  const byKey = new Map<string, SlackCollectedMedia>()
  const add = (media: SlackCollectedMedia | undefined) => {
    if (!media || byKey.has(media.sourceKey)) return
    byKey.set(media.sourceKey, media)
  }

  for (const file of message.files ?? []) {
    add(slackMediaFromFile(file))
  }
  for (const media of collectExplicitBlockMedia(message.blocks ?? [])) {
    add(media)
  }
  for (const attachment of message.attachments ?? []) {
    if (attachment.is_msg_unfurl || attachment.is_app_unfurl) continue
    for (const url of [
      attachment.image_url,
      attachment.thumb_url,
      attachment.video_url,
    ]) {
      if (!url) continue
      add(
        mediaFromImageFields({
          imageUrl: url,
          filename: attachment.title,
        }),
      )
    }
    for (const file of attachment.files ?? []) {
      add(slackMediaFromFile(file))
    }
  }
  return [...byKey.values()]
}

export function slackAssetKind(
  filename: string,
  contentType?: string | null,
  mimetype?: string | null,
): "image" | "file" {
  const type = contentType || mimetype || ""
  if (type.startsWith("image/")) return "image"
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filename)) return "image"
  return "file"
}
