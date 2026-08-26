import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { CHAT_SANDBOX_IDLE_MS } from "./chat-lifecycle.js"

const WorkspaceChatTokenSchema = z.object({
  exp: z.number().int().positive(),
  orgId: z.string().min(1),
  conversationId: z.string().min(1),
  purpose: z.literal("workspace-chat-completions"),
})

export type WorkspaceChatToken = z.infer<typeof WorkspaceChatTokenSchema>

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url")
}

export function mintWorkspaceChatToken(input: {
  authSecret: string
  orgId: string
  conversationId: string
  now?: number
  ttlMs?: number
}): string {
  const now = input.now ?? Date.now()
  const payload: WorkspaceChatToken = {
    exp: now + (input.ttlMs ?? CHAT_SANDBOX_IDLE_MS),
    orgId: input.orgId,
    conversationId: input.conversationId,
    purpose: "workspace-chat-completions",
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  )
  return `${encodedPayload}.${sign(encodedPayload, input.authSecret)}`
}

export function verifyWorkspaceChatToken(input: {
  authSecret: string
  token: string
  now?: number
}): WorkspaceChatToken | undefined {
  const [encodedPayload, signature, extra] = input.token.split(".")
  if (!encodedPayload || !signature || extra) return undefined
  const expected = Buffer.from(sign(encodedPayload, input.authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined
  }
  try {
    const parsed = WorkspaceChatTokenSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    )
    return parsed.exp > (input.now ?? Date.now()) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function workspaceChatBearerToken(
  header: string | undefined,
): string | undefined {
  const prefix = "Bearer "
  if (!header?.startsWith(prefix)) return undefined
  const token = header.slice(prefix.length).trim()
  return token.length > 0 ? token : undefined
}
