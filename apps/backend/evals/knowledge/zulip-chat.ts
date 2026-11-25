import { createHash } from "node:crypto"

import { stringify } from "yaml"
import { z } from "zod"

import { Pseudonyms } from "./pseudonyms.js"

/*
 * The public chat of an org twin (OrgBench, CTX-1661): the messages of the
 * web-public channels of a Zulip server, read with no credential, as one
 * Markdown file for each topic as it was at the cut-off date. The same
 * files go into the context repo of the twin and are the chat files of the
 * files arm. No real name, email address or user id goes into a file
 * (`pseudonyms.ts`).
 */

/** The chat slice of a corpus in a plan. The end of the slice is the plan's cut-off date. */
export const zulipChatSchema = z.strictObject({
  /** The Zulip server, for example `https://chat.zulip.org`. */
  realm: z.url({ protocol: /^https$/ }),
  /** The start of the slice. */
  since: z.iso.datetime({ offset: true }),
  /** The ids of the web-public channels to read. */
  channels: z.array(z.number().int().positive()).min(1),
})

export type ZulipChat = z.infer<typeof zulipChatSchema>

const id = z.number().int().positive()

/** The fields of a Zulip message that the export reads. The server is not trusted. */
const messageSchema = z.object({
  id,
  sender_id: id,
  sender_full_name: z.string(),
  content: z.string(),
  timestamp: z.number().int(),
  stream_id: id,
  display_recipient: z.string(),
  subject: z.string(),
  last_edit_timestamp: z.number().optional(),
  last_moved_timestamp: z.number().optional(),
  /** Each entry holds the text, topic or channel from before that edit. */
  edit_history: z
    .array(
      z.object({
        timestamp: z.number(),
        prev_content: z.string().optional(),
        prev_topic: z.string().optional(),
        prev_stream: id.optional(),
      }),
    )
    .optional(),
})

export type ZulipMessage = z.infer<typeof messageSchema>

const pageSchema = z.object({
  result: z.literal("success"),
  messages: z.array(messageSchema),
  found_oldest: z.boolean().optional(),
})

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

async function page(
  realm: string,
  query: {
    anchor: number | "newest"
    before: number
    after: number
    channel?: number
    includeAnchor?: boolean
  },
) {
  // The web-public operator lets a request with no credential read.
  const narrow = [
    { operator: "channels", operand: "web-public" },
    ...(query.channel === undefined
      ? []
      : [{ operator: "channel", operand: query.channel }]),
  ]
  const url = new URL("/json/messages", realm)
  url.search = new URLSearchParams({
    anchor: String(query.anchor),
    num_before: String(query.before),
    num_after: String(query.after),
    include_anchor: String(query.includeAnchor ?? false),
    apply_markdown: "false",
    client_gravatar: "true",
    narrow: JSON.stringify(narrow),
  }).toString()
  for (;;) {
    // The server asks for at most 5 requests in 10 seconds.
    await wait(2_000)
    const response = await fetch(url)
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after")) || 10
      await wait(Math.max(1, seconds) * 1_000)
      continue
    }
    if (!response.ok)
      throw new Error(`${realm} refused a message request: ${response.status}`)
    return pageSchema.parse(await response.json())
  }
}

/**
 * The id of the last web-public message of the server at or before `time`,
 * by binary search over the message ids. Message ids grow with time.
 */
async function lastIdAt(realm: string, time: number): Promise<number> {
  const newest = (
    await page(realm, { anchor: "newest", before: 1, after: 0 })
  ).messages.at(-1)
  if (!newest || newest.timestamp <= time) return newest?.id ?? 0
  // Each id up to `low` is at or before `time`; each id from `high` is after it.
  let low = 0
  let high = newest.id
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    const next = (
      await page(realm, {
        anchor: middle,
        before: 0,
        after: 1,
        includeAnchor: true,
      })
    ).messages[0]
    // `next` is the first message at or after `middle`. When it is after
    // `time`, or there is none, the last message at `time` is below `middle`.
    if (next && next.id < high && next.timestamp <= time) low = next.id
    else high = middle
  }
  return low
}

/**
 * The messages of each channel from `since` to `until`, oldest first. The
 * export reads backward from the last message at `until`, 100 messages for
 * each request, as the server asks.
 */
export async function readZulipChat(
  chat: ZulipChat,
  until: Date,
  log: (line: string) => void,
): Promise<ZulipMessage[]> {
  const since = Date.parse(chat.since) / 1_000
  const end = until.getTime() / 1_000
  const last = await lastIdAt(chat.realm, end)
  const messages: ZulipMessage[] = []
  for (const channel of chat.channels) {
    let anchor = last + 1
    let count = 0
    for (;;) {
      const batch = await page(chat.realm, {
        anchor,
        before: 100,
        after: 0,
        channel,
      })
      const kept = batch.messages.filter(
        (message) =>
          message.id < anchor &&
          message.timestamp >= since &&
          message.timestamp <= end,
      )
      messages.push(...kept)
      count += kept.length
      const oldest = batch.messages[0]
      if (
        !oldest ||
        batch.found_oldest ||
        oldest.timestamp < since ||
        oldest.id >= anchor
      )
        break
      anchor = oldest.id
    }
    log(`channel ${channel}: ${count} messages`)
  }
  return messages.sort((left, right) => left.id - right.id)
}

const RESOLVED = "✔ "
const MENTION = /@_?\*\*([^*|\n]+?)(?:\|(\d+))?\*\*/g

/**
 * The text, topic and channel of a message as they were at `end`. The edit
 * history gives the text, topic and channel from before each later edit,
 * so the oldest later edit gives the state at `end`. When the history does
 * not explain a later edit, the text is left out (`null`). When it does not
 * explain a later move, the topic loses its resolved mark, which can be
 * later than `end`, and the move counts as not restored.
 */
function atCutoff(message: ZulipMessage, end: number) {
  const later = (message.edit_history ?? [])
    .filter((edit) => edit.timestamp > end)
    .sort((left, right) => left.timestamp - right.timestamp)
  const first = <K extends "prev_content" | "prev_topic" | "prev_stream">(
    key: K,
  ) => later.find((edit) => edit[key] !== undefined)?.[key]
  const explains = (time: number | undefined) =>
    later.some((edit) => edit.timestamp === time)
  const editedLater = (message.last_edit_timestamp ?? 0) > end
  const movedLater = (message.last_moved_timestamp ?? 0) > end
  const content = first("prev_content")
  const topic = first("prev_topic")
  const stream = first("prev_stream")
  const unexplainedMove = movedLater && !explains(message.last_moved_timestamp)
  return {
    ...message,
    content:
      content ??
      (editedLater && !explains(message.last_edit_timestamp)
        ? null
        : message.content),
    subject:
      topic ??
      (unexplainedMove && message.subject.startsWith(RESOLVED)
        ? message.subject.slice(RESOLVED.length)
        : message.subject),
    stream_id: stream ?? message.stream_id,
    restored:
      content !== undefined || topic !== undefined || stream !== undefined,
    unexplainedMove,
  }
}

export type ChatFile = { path: string; content: string }

/** The record of an export: counts and hashes, no name and no text. */
export type ChatManifest = {
  realm: string
  since: string
  until: string
  topics: number
  messages: number
  people: number
  /** Messages whose text, topic or channel the edit history set back to `until`. */
  restoredFromHistory: number
  /** Messages edited after `until` that the history does not explain: their text is left out. */
  leftOut: number
  /** Messages moved after `until` that the history does not explain. */
  moveNotRestored: number
  /** Messages that were in a channel out of the slice at `until`. */
  outOfSlice: number
  channels: Array<{ id: number; topics: number; messages: number }>
  files: Array<{
    path: string
    sha256: string
    firstMessageId: number
    messages: number
  }>
}

/**
 * One Markdown file for each topic as it was at `until`, at
 * `chat/zulip/<channel id>/<first message id>.md`. The path holds no name,
 * so the manifest holds none. `people` gives the pseudonyms; a corpus step
 * gives the one of its corpus, so that the names of its other sources go
 * too.
 */
export function renderZulipChat(
  chat: ZulipChat,
  until: Date,
  messages: ZulipMessage[],
  people = new Pseudonyms(),
): { files: ChatFile[]; manifest: ChatManifest } {
  const end = until.getTime() / 1_000
  const channelNames = new Map(
    messages.map((message) => [message.stream_id, message.display_recipient]),
  )
  const restored = messages.map((message) => atCutoff(message, end))
  const kept = restored.filter((message) =>
    chat.channels.includes(message.stream_id),
  )
  for (const message of kept) {
    people.add(`zulip:${message.sender_id}`, [message.sender_full_name])
    for (const [, name = "", mentioned] of (message.content ?? "").matchAll(
      MENTION,
    ))
      if (mentioned) people.add(`zulip:${mentioned}`, [name])
  }
  const scrub = (text: string) =>
    people.scrub(
      text
        .replace(
          MENTION,
          (_match, name: string, mentioned?: string) =>
            `@${(mentioned ? people.of(`zulip:${mentioned}`) : people.named(name)) ?? "someone"}`,
        )
        // A narrow link to a direct message or a sender names the person by id.
        .replace(
          /(\/(?:sender|dm|pm-with|dm-including|group-pm-with)\/)[\w,-]+/g,
          "$1[person]",
        )
        .replace(/#user\/\d+/g, "#user/[person]"),
    )
  // Zulip topic names do not depend on case.
  const topics = new Map<string, typeof kept>()
  for (const message of kept) {
    const key = `${message.stream_id}\n${message.subject.toLowerCase()}`
    topics.set(key, [...(topics.get(key) ?? []), message])
  }
  const manifest: ChatManifest = {
    realm: chat.realm,
    since: chat.since,
    until: until.toISOString(),
    topics: topics.size,
    messages: kept.length,
    people: people.count,
    restoredFromHistory: kept.filter((message) => message.restored).length,
    leftOut: kept.filter((message) => message.content === null).length,
    moveNotRestored: kept.filter((message) => message.unexplainedMove).length,
    outOfSlice: restored.length - kept.length,
    channels: [],
    files: [],
  }
  const files: ChatFile[] = []
  const channels = new Map<number, ChatManifest["channels"][number]>()
  for (const thread of topics.values()) {
    const first = thread[0] as (typeof kept)[number]
    const last = thread.at(-1) as (typeof kept)[number]
    const topic = scrub(first.subject)
    const header = {
      source: "zulip",
      type: "topic",
      realm: chat.realm,
      channel: scrub(
        channelNames.get(first.stream_id) ?? `channel ${first.stream_id}`,
      ),
      channelId: first.stream_id,
      topic,
      resolved: topic.startsWith(RESOLVED),
      url: `${chat.realm}/#narrow/channel/${first.stream_id}/near/${first.id}`,
      firstMessageId: first.id,
      firstMessageAt: iso(first.timestamp),
      lastMessageAt: iso(last.timestamp),
      messages: thread.length,
    }
    const body = thread.map((message) => {
      const text =
        message.content === null
          ? "_This message was edited after the snapshot date. Its text is left out._"
          : scrub(message.content).trim() || "_No text._"
      return `### ${people.of(`zulip:${message.sender_id}`)} · ${iso(message.timestamp)}\n\n${text}`
    })
    const content = `---\n${stringify(header).trimEnd()}\n---\n\n# ${topic}\n\n${body.join("\n\n")}\n`
    // Both parts of the path are positive integers (`messageSchema`).
    const path = `chat/zulip/${first.stream_id}/${first.id}.md`
    files.push({ path, content })
    manifest.files.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      firstMessageId: first.id,
      messages: thread.length,
    })
    const channel = channels.get(first.stream_id) ?? {
      id: first.stream_id,
      topics: 0,
      messages: 0,
    }
    channel.topics += 1
    channel.messages += thread.length
    channels.set(first.stream_id, channel)
  }
  manifest.channels = [...channels.values()].sort((a, b) => a.id - b.id)
  manifest.files.sort((a, b) => a.path.localeCompare(b.path))
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, manifest }
}

function iso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString().replace(/\.000Z$/, "Z")
}
