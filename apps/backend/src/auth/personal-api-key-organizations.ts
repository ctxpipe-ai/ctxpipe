import { APIError, createAuthMiddleware } from "better-auth/api"
import { and, asc, eq, inArray } from "drizzle-orm"
import { getSystemDb } from "../db/client.js"
import { apikeys, members, organizations } from "../db/schema/auth.js"
import { oauthGrantOrganizations } from "../db/schema/oauth_grant_organizations.js"
import { setOrganizations } from "./oauth-grants.js"

/**
 * The org set of a new personal API key, on `POST /api-key/create`: one org
 * id, or a comma-separated list (ADR-051 §API keys).
 */
export const PERSONAL_API_KEY_ORGANIZATIONS_HEADER =
  "x-ctxpipe-api-key-organizations"

type OrganizationSummary = { id: string; slug: string; name: string }

/** The org set of one personal API key, as the key list shows it. */
export type PersonalApiKeyOrganizations = {
  id: string
  /**
   * The key's set ∩ the user's live memberships, in slug order. Null for a
   * key with no set: it acts on every membership of the user.
   */
  organizations: OrganizationSummary[] | null
}

/** The org sets of the personal API keys of one user. */
export async function listPersonalApiKeyOrganizations(
  userId: string,
): Promise<PersonalApiKeyOrganizations[]> {
  const db = getSystemDb()
  const keys = await db
    .select({ id: apikeys.id })
    .from(apikeys)
    .where(
      and(eq(apikeys.referenceId, userId), eq(apikeys.configId, "default")),
    )
  if (keys.length === 0) return []
  const rows = await db
    .select({
      keyId: oauthGrantOrganizations.apiKeyId,
      organizationId: oauthGrantOrganizations.organizationId,
    })
    .from(oauthGrantOrganizations)
    .where(
      inArray(
        oauthGrantOrganizations.apiKeyId,
        keys.map((key) => key.id),
      ),
    )
  const memberOrgs = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, userId),
      ),
    )
    .orderBy(asc(organizations.slug))
  return keys.map(({ id }) => {
    const orgIds = new Set(
      rows.filter((row) => row.keyId === id).map((row) => row.organizationId),
    )
    return {
      id,
      organizations:
        orgIds.size === 0
          ? null
          : memberOrgs.filter((org) => orgIds.has(org.id)),
    }
  })
}

/**
 * Replace the org set of one personal API key of the user. The list must not
 * be empty, and each org must be a live membership of the user.
 */
export async function setPersonalApiKeyOrganizations(input: {
  userId: string
  keyId: string
  organizationIds: string[]
}): Promise<"ok" | "not_found" | "empty" | "not_member"> {
  const [key] = await getSystemDb()
    .select({ id: apikeys.id })
    .from(apikeys)
    .where(
      and(
        eq(apikeys.id, input.keyId),
        eq(apikeys.referenceId, input.userId),
        eq(apikeys.configId, "default"),
      ),
    )
    .limit(1)
  if (!key) return "not_found"
  const organizationIds = [...new Set(input.organizationIds)]
  if (organizationIds.length === 0) return "empty"
  const memberships = await getSystemDb()
    .select({ id: members.organizationId })
    .from(members)
    .where(
      and(
        eq(members.userId, input.userId),
        inArray(members.organizationId, organizationIds),
      ),
    )
  if (memberships.length !== organizationIds.length) return "not_member"
  await setOrganizations({ apiKeyId: key.id }, organizationIds)
  return "ok"
}

/**
 * Better Auth after-hook on `POST /api-key/create`. It writes the org set of
 * a new personal key before the response gives the secret to the client.
 *
 * An HTTP request must send the set in
 * {@link PERSONAL_API_KEY_ORGANIZATIONS_HEADER}. A server-side call without
 * the header makes a key with no set (all memberships), as before ADR-051.
 * When the set is missing or not valid, or when the write fails, the hook
 * deletes the new key and refuses the request. Thus no client gets a key
 * that has more access than the user selected.
 */
export const personalApiKeyOrganizationsHook = createAuthMiddleware(
  async (ctx) => {
    if (ctx.path !== "/api-key/create") return
    const created = ctx.context.returned
    if (!created || typeof created !== "object" || created instanceof Error)
      return
    const { id, configId, referenceId } = created as Record<string, unknown>
    if (
      configId !== "default" ||
      typeof id !== "string" ||
      typeof referenceId !== "string"
    )
      return
    const header = ctx.headers?.get(PERSONAL_API_KEY_ORGANIZATIONS_HEADER)
    if (header == null && !ctx.request) return
    const organizationIds = (header ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    let result: Awaited<ReturnType<typeof setPersonalApiKeyOrganizations>>
    try {
      result = await setPersonalApiKeyOrganizations({
        userId: referenceId,
        keyId: id,
        organizationIds,
      })
    } catch (error) {
      await getSystemDb().delete(apikeys).where(eq(apikeys.id, id))
      throw error
    }
    if (result === "ok") return
    await getSystemDb().delete(apikeys).where(eq(apikeys.id, id))
    throw new APIError("BAD_REQUEST", {
      message:
        result === "not_member"
          ? "You can select only organizations that you are a member of"
          : "Select at least one organization for this key",
    })
  },
)

/**
 * The Better Auth endpoints that a request with `x-api-key` can call. The
 * api-key plugin (`enableSessionForAPIKeys`) makes a user session from a
 * personal key on every Better Auth endpoint. Thus without this list, a key
 * could make a new key with a larger org set, change the user, or change an
 * organization. A personal key reads ctx| data through our REST and MCP
 * routes, which apply its org set. Those routes need only `/get-session`.
 * The other entries are public reads that need no session.
 */
const API_KEY_ENDPOINTS = new Set([
  "/get-session",
  "/ok",
  "/error",
  "/jwks",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
])

/**
 * Server-side reads (`auth.api.*` with no HTTP request) that our routes make
 * with the headers of a key request, after they apply the org set of the key.
 */
const API_KEY_SERVER_ENDPOINTS = new Set([
  "/organization/get-active-member-role",
])

/**
 * Better Auth before-hook. It refuses with 403 each request with `x-api-key`
 * to an endpoint that is not in {@link API_KEY_ENDPOINTS}. It runs before the
 * api-key plugin makes a session from the key, so the key never acts on a
 * Better Auth endpoint such as `/api-key/create` or `/update-user`. A browser
 * session (cookie) without `x-api-key` is not changed.
 */
export const apiKeySessionGuardHook = createAuthMiddleware(async (ctx) => {
  if (!ctx.headers?.get("x-api-key")) return
  if (API_KEY_ENDPOINTS.has(ctx.path)) return
  if (!ctx.request && API_KEY_SERVER_ENDPOINTS.has(ctx.path)) return
  throw new APIError("FORBIDDEN", {
    message: "An API key cannot call this endpoint",
  })
})
