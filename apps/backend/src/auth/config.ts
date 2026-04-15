import { dash } from "@better-auth/infra"
import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { betterAuth } from "better-auth"
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

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>
export type AuthUser = BetterAuthInstance["$Infer"]["Session"]["user"]
export type AuthSession = BetterAuthInstance["$Infer"]["Session"]["session"]

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
    appName: "ctx|",
    secret: env.AUTH_SECRET,
    baseURL: env.AUTH_BASE_URL,
    basePath: "/.auth/api/v1/auth",
    trustedOrigins: trustedOrigins.length > 0 ? trustedOrigins : undefined,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
      usePlural: true,
    }),
    user: {
      additionalFields: {
        onboardingCompletedAt: {
          type: "date",
          required: false,
          defaultValue: null,
          input: false,
        },
      },
    },
    /** Web cookie + DB session: keep users signed in across days (MCP OAuth access JWT TTL is separate; see oauthProvider). */
    session: {
      /** Required when `secondaryStorage` is enabled (e.g. infra `dash()`); keeps sessions in Postgres too. */
      storeSessionInDatabase: true,
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
      database: {
        generateId: ({ model }) => generateObjectId(toTypeSlug(model)),
      },
    },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        const [{ sendEmail }, { ResetPasswordEmail }] = await Promise.all([
          import("../email/index.js"),
          import("../email/templates/reset-password.js"),
        ])
        await sendEmail(
          user.email,
          "Reset your password",
          ResetPasswordEmail({ url, userEmail: user.email }),
        )
      },
    },
    account: {
      accountLinking: {
        trustedProviders: ["atlassian", "github", "google", "microsoft"],
        allowDifferentEmails: true,
      },
    },
    socialProviders: {
      github:
        env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
          ? {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
              redirectURI: `${env.AUTH_BASE_URL}/.auth/api/v1/auth/callback/github`,
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
      atlassian:
        env.ATLASSIAN_CLIENT_ID && env.ATLASSIAN_CLIENT_SECRET
          ? {
              clientId: env.ATLASSIAN_CLIENT_ID,
              clientSecret: env.ATLASSIAN_CLIENT_SECRET,
              scope: [
                "read:jira-user",
                "read:confluence-user",
                "offline_access",
                "read:me",
                "read:account",
              ],
            }
          : undefined,
    },
    plugins: [
      bearer(),
      jwt(),
      twoFactor(),
      organization({
        async sendInvitationEmail(data) {
          const acceptPath = `/.auth/accept-invitation?invitationId=${encodeURIComponent(data.id)}`
          const inviteLink = `${env.AUTH_BASE_URL}/.auth/sign-up?redirectTo=${encodeURIComponent(`${acceptPath}&email=${encodeURIComponent(data.email)}`)}`
          const [{ sendEmail }, { InvitationEmail }] = await Promise.all([
            import("../email/index.js"),
            import("../email/templates/invitation.js"),
          ])
          await sendEmail(
            data.email,
            `ctx| invitation on behalf of ${data.organization.name}`,
            InvitationEmail({
              inviteLink,
              inviterName: data.inviter.user.name,
              inviterEmail: data.inviter.user.email,
              organizationName: data.organization.name,
            }),
          )
        },
      }),
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
        /** 4h — MCP hosts should still refresh via refresh_token before expiry. */
        accessTokenExpiresIn: 14_400,
        silenceWarnings: { oauthAuthServerConfig: true },
      }),
      dash(),
    ],
  })
}

let betterAuthInstance: BetterAuthInstance | null = null

export function getAuth(): BetterAuthInstance {
  if (betterAuthInstance) return betterAuthInstance
  betterAuthInstance = createBetterAuth()
  return betterAuthInstance
}

export function resetBetterAuthForTests(): void {
  betterAuthInstance = null
}
