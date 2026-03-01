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
import { parseEnv } from "../config/env.js"
import { initDb } from "../db/client.js"
import { schema } from "../db/schema.js"
import { generateObjectId } from "../lib/id.js"

export type AuthSession = InferSession<
  ReturnType<typeof createBetterAuth>["options"]
>
export type AuthUser = InferUser<ReturnType<typeof createBetterAuth>["options"]>
export type BetterAuthInstance = ReturnType<typeof createBetterAuth>

const AUTH_MODEL_ID_PREFIX: Record<string, string> = {
  account: "acct",
  apikey: "key",
  member: "mbr",
  organization: "org",
  passkey: "pass",
  session: "sess",
  twoFactor: "tfa",
  user: "user",
  verification: "ver",
}

function toTypeSlug(model: string): string {
  const knownPrefix = AUTH_MODEL_ID_PREFIX[model]
  if (knownPrefix) return knownPrefix
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return slug.length > 0 ? slug : "id"
}

export function createBetterAuth() {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const db = initDb(env.DATABASE_URL)
  const issuer = env.AUTH_ISSUER ?? env.AUTH_BASE_URL
  const trustedOrigins = (env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  return betterAuth({
    secret: env.AUTH_SECRET,
    baseURL: env.AUTH_BASE_URL,
    basePath: "/.auth/api/v1/auth",
    trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
    }),
    advanced: {
      database: {
        generateId: ({ model }) => generateObjectId(toTypeSlug(model)),
      },
    },
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
        verificationUri: "/.auth/device",
      }),
      oauthProvider({
        loginPage: "/.auth/sign-in",
        consentPage: "/.auth/consent",
        issuer,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        validAudiences: [env.AUTH_BASE_URL, `${env.AUTH_BASE_URL}/mcp`],
        silenceWarnings: { oauthAuthServerConfig: true },
      }),
    ],
  })
}

let betterAuthInstance: BetterAuthInstance | null = null

export function getBetterAuth(): BetterAuthInstance {
  if (betterAuthInstance) return betterAuthInstance
  betterAuthInstance = createBetterAuth()
  return betterAuthInstance
}

export function resetBetterAuthForTests(): void {
  betterAuthInstance = null
}
