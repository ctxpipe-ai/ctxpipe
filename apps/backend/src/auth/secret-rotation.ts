import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { deleteSessionCookie } from "better-auth/cookies"
import { symmetricDecrypt } from "better-auth/crypto"
import type { Jwk } from "better-auth/plugins"
import { log } from "../observability/logger.js"

/** Keys that this process already logged as not usable, to log each once. */
const loggedUnusableKeys = new Set<string>()

/**
 * The JWKS keys whose private key the current AUTH_SECRET can decrypt.
 *
 * The jwt plugin signs with the newest key. After an AUTH_SECRET rotation,
 * that key is encrypted with the old secret, so each signature fails and
 * `get-session` answers 500 for each signed-in user. Without these old keys,
 * the plugin makes a new key with the current secret. Tokens that an old key
 * signed then do not verify, the same as the cookies that the old secret
 * signed.
 */
export async function jwksForCurrentSecret(
  ctx: GenericEndpointContext,
): Promise<Jwk[]> {
  const keys = await ctx.context.adapter.findMany<Jwk>({ model: "jwks" })
  const usable = await Promise.all(
    keys.map((key) =>
      symmetricDecrypt({
        key: ctx.context.secretConfig,
        data: JSON.parse(key.privateKey),
      }).then(
        () => true,
        () => false,
      ),
    ),
  )
  for (const [index, key] of keys.entries()) {
    if (usable[index] || loggedUnusableKeys.has(key.id)) continue
    loggedUnusableKeys.add(key.id)
    log.warn({
      step: "auth.jwks",
      message:
        "Ignored a JWKS key that the current AUTH_SECRET cannot decrypt (the secret changed). JWTs sign with a new key.",
      jwksKeyId: key.id,
    })
  }
  return keys.filter((_, index) => usable[index])
}

/**
 * Clears a session cookie whose signature does not verify, for example after
 * an AUTH_SECRET rotation. Better Auth answers `get-session` with no session
 * for that cookie but keeps it, so the browser sends it again each time.
 */
export function clearUnverifiedSessionCookie(): BetterAuthPlugin {
  return {
    id: "clear-unverified-session-cookie",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            const name = ctx.context.authCookies.sessionToken.name
            if (!ctx.getCookie(name)) return
            if (await ctx.getSignedCookie(name, ctx.context.secret)) return
            deleteSessionCookie(ctx)
          }),
        },
      ],
    },
  }
}
