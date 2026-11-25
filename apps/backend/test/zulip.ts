import { HttpResponse, http } from "msw"
import type { SetupServer } from "msw/node"
import { vi } from "vitest"

import type { ZulipMessage } from "../evals/knowledge/zulip-chat.js"

/** A message as `GET /json/messages` of Zulip gives it. Made-up people only. */
export function zulipMessage(
  id: number,
  at: string,
  fields: Partial<ZulipMessage> = {},
): ZulipMessage {
  return {
    id,
    sender_id: 11,
    sender_full_name: "Ada Quill",
    content: "Hello.",
    timestamp: Date.parse(at) / 1_000,
    stream_id: 7,
    display_recipient: "api design",
    subject: "Typing events",
    ...fields,
  }
}

/**
 * A Zulip server at `realm` in msw. It answers `GET /json/messages` as Zulip
 * does for a request with no credential: only a narrow with the web-public
 * operator, and the messages of the narrow around the anchor. It returns
 * the URL of each request.
 */
export function serveZulip(
  server: SetupServer,
  realm: string,
  messages: ZulipMessage[],
): URL[] {
  const requests: URL[] = []
  server.use(
    http.get(`${realm}/json/messages`, ({ request }) => {
      const url = new URL(request.url)
      requests.push(url)
      const narrow = JSON.parse(url.searchParams.get("narrow") ?? "[]") as {
        operator: string
        operand: unknown
      }[]
      if (
        !narrow.some(
          (item) =>
            item.operator === "channels" && item.operand === "web-public",
        )
      )
        return HttpResponse.json(
          { result: "error", msg: "Not logged in" },
          { status: 401 },
        )
      const channel = narrow.find((item) => item.operator === "channel")
      const visible = messages
        .filter((item) => !channel || item.stream_id === channel.operand)
        .sort((a, b) => a.id - b.id)
      const text = url.searchParams.get("anchor") ?? ""
      const anchor = text === "newest" ? Number.POSITIVE_INFINITY : Number(text)
      const include = url.searchParams.get("include_anchor") === "true"
      const before = Number(url.searchParams.get("num_before"))
      const after = Number(url.searchParams.get("num_after"))
      const older = visible.filter((item) => item.id < anchor)
      const newer = visible.filter((item) =>
        include ? item.id >= anchor : item.id > anchor,
      )
      return HttpResponse.json({
        result: "success",
        msg: "",
        messages: [
          ...older.slice(Math.max(0, older.length - before)),
          ...newer.slice(0, after),
        ],
        found_oldest: older.length <= before,
        found_newest: newer.length <= after,
      })
    }),
  )
  return requests
}

/**
 * Run `work` with a fake clock, and move the clock until `work` ends. The
 * chat export waits 2 seconds before each request, as the server asks.
 */
export async function withFakeClock<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout"] })
  try {
    let done = false
    const result = work().finally(() => {
      done = true
    })
    // The test reads the result below; this keeps an early failure handled.
    result.catch(() => {})
    while (!done) await vi.advanceTimersByTimeAsync(2_000)
    return await result
  } finally {
    vi.useRealTimers()
  }
}
