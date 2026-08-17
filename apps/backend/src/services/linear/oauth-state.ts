import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

const LinearOAuthStateSchema = z.object({
  exp: z.number().int().positive(),
  nonce: z.string().min(1),
  orgId: z.string().min(1),
  orgSlug: z.string().min(1),
  userId: z.string().min(1),
})

export type LinearOAuthState = z.infer<typeof LinearOAuthStateSchema>

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url")
}

export function createLinearOAuthState(input: {
  authSecret: string
  orgId: string
  orgSlug: string
  userId: string
  now?: number
}): string {
  const payload: LinearOAuthState = {
    exp: (input.now ?? Date.now()) + 10 * 60 * 1000,
    nonce: randomBytes(16).toString("base64url"),
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    userId: input.userId,
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  )
  return `${encodedPayload}.${sign(encodedPayload, input.authSecret)}`
}

export function verifyLinearOAuthState(input: {
  authSecret: string
  state: string
  now?: number
}): LinearOAuthState | undefined {
  const [encodedPayload, signature, extra] = input.state.split(".")
  if (!encodedPayload || !signature || extra) return undefined
  const expected = Buffer.from(sign(encodedPayload, input.authSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return undefined
  }
  try {
    const parsed = LinearOAuthStateSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    )
    return parsed.exp > (input.now ?? Date.now()) ? parsed : undefined
  } catch {
    return undefined
  }
}
