import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import slugify from "@sindresorhus/slugify"
import { betterAuth, type InferSession, type InferUser } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { createAuthMiddleware } from "better-auth/api"
import {
  bearer,
  deviceAuthorization,
  jwt,
  organization,
  twoFactor,
} from "better-auth/plugins"
import { eq } from "drizzle-orm"
import { parseEnv } from "../config/env.js"
import { getSystemDb, initDb } from "../db/client.js"
import { members, sessions } from "../db/schema/auth.js"
import { schema } from "../db/schema.js"
import { generateObjectId } from "../lib/id.js"

function slugifyForOrg(name: string): string {
  const base = slugify(name.trim()).slice(0, 32)
  const alphanum = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  const randomSuffix = Array.from(
    bytes,
    (b) => alphanum[b % alphanum.length],
  ).join("")
  return base ? `${base}-${randomSuffix}` : randomSuffix
}

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
    socialProviders: {
      github:
        env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
          ? {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
              redirectURI: `${env.AUTH_BASE_URL}/.auth/callback/github`,
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
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const newSession = ctx.context.newSession
        if (!newSession) return

        const user = newSession.user
        const userId = user.id

        const db = getSystemDb()
        const userMembers = await db
          .select()
          .from(members)
          .where(eq(members.userId, userId))
        if (userMembers.length > 0) return

        const displayName = (
          user.name ??
          user.email?.split("@")[0] ??
          "User"
        ).trim()
        const name = `${displayName}'s workspace`
        const slug = slugifyForOrg(displayName)

        const auth = getAuth()
        const created = await auth.api.createOrganization({
          body: { name, slug, userId },
        })
        if (!created?.id) return

        await db
          .update(sessions)
          .set({ activeOrganizationId: created.id })
          .where(eq(sessions.id, newSession.session.id))
      }),
    },
    plugins: [
      bearer(),
      jwt(),
      twoFactor(),
      organization({
        async sendInvitationEmail(data) {
          const inviteLink = `${env.AUTH_BASE_URL}/.auth/accept-invitation?invitationId=${data.id}`
          const [{ sendEmail }, { InvitationEmail }] = await Promise.all([
            import("../email/index.js"),
            import("../email/templates/invitation.js"),
          ])
          await sendEmail(
            data.email,
            `You've been invited to join ${data.organization.name}`,
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
        silenceWarnings: { oauthAuthServerConfig: true },
      }),
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
