import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import { stringify } from "yaml"
import { z } from "zod"

/*
 * The public chat of an org twin (OrgBench, CTX-1661): the messages of the
 * web-public channels of a Zulip server, read with no credential, as one
 * Markdown file for each topic. The same files go into the context repo of
 * the twin and are the chat files of the files arm.
 *
 * No real name, email address or user id goes into a file. Each person gets
 * a pseudonym (`person-0001`) in the order of the first message that names
 * the person. The same slice gives the same pseudonyms, and a later end
 * date only adds new ones.
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

/** The fields of a Zulip message that the export reads. */
type ZulipMessage = {
  id: number
  sender_id: number
  sender_full_name: string
  content: string
  timestamp: number
  stream_id: number
  display_recipient: string
  subject: string
  last_edit_timestamp?: number
  last_moved_timestamp?: number
  /** Each entry holds the text or the topic from before that edit. */
  edit_history?: Array<{
    timestamp: number
    prev_content?: string
    prev_topic?: string
  }>
}

type ZulipPage = {
  result: string
  msg?: string
  messages: ZulipMessage[]
  found_oldest?: boolean
  found_newest?: boolean
}

/** How the export reads the server. Tests give a fetch and no pause. */
export type ZulipAccess = {
  fetch: (url: URL) => Promise<Response>
  /**
   * The wait before each request. The server asks for at most 5 requests
   * in 10 seconds.
   */
  pause: () => Promise<void>
}

export const politeZulipAccess: ZulipAccess = {
  fetch: (url) => fetch(url),
  pause: () => sleep(2_000),
}

async function page(
  access: ZulipAccess,
  realm: string,
  query: {
    anchor: number | "newest"
    before: number
    after: number
    channel?: number
    includeAnchor?: boolean
  },
): Promise<ZulipPage> {
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
    await access.pause()
    const response = await access.fetch(url)
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after") ?? "10")
      await sleep(Math.max(1, seconds) * 1_000)
      continue
    }
    const body = (await response.json()) as ZulipPage
    if (!response.ok || body.result !== "success")
      throw new Error(
        `${realm} refused a message request: ${response.status} ${body.msg ?? ""}`,
      )
    return body
  }
}

/**
 * The id of the last web-public message of the server at or before `time`,
 * by binary search over the message ids. Message ids grow with time.
 */
async function lastIdAt(
  access: ZulipAccess,
  realm: string,
  time: number,
): Promise<number> {
  const newest = (
    await page(access, realm, {
      anchor: "newest",
      before: 1,
      after: 0,
    })
  ).messages.at(-1)
  if (!newest || newest.timestamp <= time) return newest?.id ?? 0
  // Each id up to `low` is at or before `time`; `high` is after it.
  let low = 0
  let high = newest.id
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    const next = (
      await page(access, realm, {
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
  access: ZulipAccess,
  log: (line: string) => void,
): Promise<ZulipMessage[]> {
  const since = Date.parse(chat.since) / 1_000
  const end = until.getTime() / 1_000
  const last = await lastIdAt(access, chat.realm, end)
  const messages: ZulipMessage[] = []
  for (const channel of chat.channels) {
    let anchor = last + 1
    let count = 0
    for (;;) {
      const batch = await page(access, chat.realm, {
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

const MENTION = /@_?\*\*([^*|\n]+?)(?:\|(\d+))?\*\*/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
// Links to a direct message or a user profile name the person by id.
const PERSON_LINK = /#narrow\/(?:dm|pm-with|sender)\/[\w.,-]+|#user\/\d+/g
const RESOLVED = "✔ "

/** The stable pseudonyms of the people of a slice. */
class Pseudonyms {
  private readonly byId = new Map<number, string>()
  private readonly byName = new Map<string, number>()

  /** Assign in the order of the messages: the sender, then each mention. */
  constructor(messages: ZulipMessage[]) {
    for (const message of messages) {
      this.add(message.sender_id, message.sender_full_name)
      for (const [, name = "", id] of message.content.matchAll(MENTION))
        if (id) this.add(Number(id), name.trim())
    }
  }

  private add(id: number, name: string) {
    if (!this.byId.has(id))
      this.byId.set(id, `person-${String(this.byId.size + 1).padStart(4, "0")}`)
    if (name && !this.byName.has(name)) this.byName.set(name, id)
  }

  get count() {
    return this.byId.size
  }

  of(id: number): string {
    return this.byId.get(id) ?? "someone"
  }

  /** The text with each mention, known full name and email address replaced. */
  scrub(text: string): string {
    let result = text.replace(MENTION, (_match, name: string, id?: string) => {
      const person = id ? Number(id) : this.byName.get(name.trim())
      return `@${person === undefined ? "someone" : this.of(person)}`
    })
    result = result.replace(EMAIL, "[email]")
    result = result.replace(PERSON_LINK, "#narrow/[person]")
    // A full name of two or more words, longest first. A one-word name can
    // be a common word or code, so it stays.
    const names = [...this.byName.keys()]
      .filter((name) => /\s/.test(name.trim()))
      .sort((left, right) => right.length - left.length)
    for (const name of names) {
      const id = this.byName.get(name)
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      if (id !== undefined)
        result = result.replace(
          new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"),
          this.of(id),
        )
    }
    return result
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "channel"
  )
}

function iso(seconds: number): string {
  return new Date(seconds * 1_000).toISOString().replace(/\.000Z$/, "Z")
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
  /** Messages whose text or topic the edit history set back to `until`. */
  restoredFromHistory: number
  /** Messages edited after `until` with no edit history: their text is left out. */
  leftOut: number
  channels: Array<{
    id: number
    name: string
    topics: number
    messages: number
  }>
  files: Array<{
    path: string
    sha256: string
    firstMessageId: number
    messages: number
  }>
}

/**
 * The text and the topic of a message as they were at `end`. The edit
 * history gives the text and the topic from before each later edit, so the
 * oldest later edit gives the state at `end`. With no history, a later
 * edit leaves the text out (`null`), and a later move removes the resolved
 * mark, which can be later than `end`.
 */
function atCutoff(message: ZulipMessage, end: number) {
  const later = (message.edit_history ?? [])
    .filter((edit) => edit.timestamp > end)
    .sort((left, right) => left.timestamp - right.timestamp)
  const content = later.find((edit) => edit.prev_content !== undefined)
  const topic = later.find((edit) => edit.prev_topic !== undefined)
  const history = message.edit_history !== undefined
  const editedLater = (message.last_edit_timestamp ?? 0) > end
  const movedLater = (message.last_moved_timestamp ?? 0) > end
  return {
    ...message,
    content:
      content?.prev_content ??
      (editedLater && !history ? null : message.content),
    subject:
      topic?.prev_topic ??
      (movedLater && !history && message.subject.startsWith(RESOLVED)
        ? message.subject.slice(RESOLVED.length)
        : message.subject),
    restored: content !== undefined || topic !== undefined,
  }
}

/**
 * One Markdown file for each topic as it was at `until`, at
 * `chat/zulip/<channel>/<first message id>.md`. The path holds no topic
 * name, so the manifest holds none.
 */
export function renderZulipChat(
  chat: ZulipChat,
  until: Date,
  messages: ZulipMessage[],
): { files: ChatFile[]; manifest: ChatManifest } {
  const end = until.getTime() / 1_000
  const restored = messages.map((message) => atCutoff(message, end))
  const people = new Pseudonyms(
    restored.map((message) => ({ ...message, content: message.content ?? "" })),
  )
  const topics = new Map<string, typeof restored>()
  for (const message of restored) {
    const key = `${message.stream_id}\n${message.subject}`
    topics.set(key, [...(topics.get(key) ?? []), message])
  }
  const manifest: ChatManifest = {
    realm: chat.realm,
    since: chat.since,
    until: until.toISOString(),
    topics: topics.size,
    messages: messages.length,
    people: people.count,
    restoredFromHistory: restored.filter((message) => message.restored).length,
    leftOut: restored.filter((message) => message.content === null).length,
    channels: [],
    files: [],
  }
  const files: ChatFile[] = []
  const channels = new Map<number, ChatManifest["channels"][number]>()
  for (const thread of topics.values()) {
    const first = thread[0] as (typeof restored)[number]
    const last = thread.at(-1) as (typeof restored)[number]
    const topic = people.scrub(first.subject)
    const header = {
      source: "zulip",
      type: "topic",
      realm: chat.realm,
      channel: first.display_recipient,
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
          : people.scrub(message.content).trim() || "_No text._"
      return `### ${people.of(message.sender_id)} · ${iso(message.timestamp)}\n\n${text}`
    })
    const content = `---\n${stringify(header).trimEnd()}\n---\n\n# ${topic}\n\n${body.join("\n\n")}\n`
    const path = `chat/zulip/${first.stream_id}-${slug(first.display_recipient)}/${first.id}.md`
    files.push({ path, content })
    manifest.files.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      firstMessageId: first.id,
      messages: thread.length,
    })
    const channel = channels.get(first.stream_id) ?? {
      id: first.stream_id,
      name: first.display_recipient,
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
