import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { betterAuth, type InferSession, type InferUser } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import {
  bearer,
  deviceAuthorization,
  jwt,
  organization,
  twoFactor,
} from "better-auth/plugins"
import type { Env } from "../config/env.js"
import { createDb } from "../db/client.js"
import { schema } from "../db/schema.js"

let cachedAuth: ReturnType<typeof createBetterAuth> | null = null
export type AuthSession = InferSession<
  ReturnType<typeof createBetterAuth>["options"]
>
export type AuthUser = InferUser<ReturnType<typeof createBetterAuth>["options"]>

function createBetterAuth(env: Env) {
  const db = createDb()
  const issuer = env.AUTH_ISSUER ?? env.AUTH_BASE_URL
  const trustedOrigins = (env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  return betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.AUTH_BASE_URL,
    trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      github:
        env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
          ? {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            }
          : undefined,
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            }
          : undefined,
      microsoft:
        env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
          ? {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
            }
          : undefined,
    },
    plugins: [
      bearer(),
      jwt(),
      twoFactor(),
      organization(),
      passkey(),
      deviceAuthorization({
        verificationUri: "/device",
      }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        issuer,
      }),
    ],
  })
}

export function getAuth(env: Env) {
  if (!env.DATABASE_URL || !env.AUTH_SECRET || !env.AUTH_BASE_URL) {
    throw new Error("DATABASE_URL, AUTH_SECRET, and AUTH_BASE_URL are required")
  }
  if (!cachedAuth) cachedAuth = createBetterAuth(env)
  return cachedAuth
}
