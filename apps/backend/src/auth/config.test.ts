import { afterEach, describe, expect, it, vi } from "vitest"

const {
  apiKeySpy,
  withOrgDbContextMock,
  withGraphClientMock,
  purgeOrgDataBeforeAuthDeleteMock,
} = vi.hoisted(() => ({
  apiKeySpy: vi.fn(),
  withOrgDbContextMock: vi.fn(
    async (_orgId: string, handler: () => Promise<unknown>) => handler(),
  ),
  withGraphClientMock: vi.fn(
    async (_ctx: unknown, handler: () => Promise<unknown>) => handler(),
  ),
  purgeOrgDataBeforeAuthDeleteMock: vi.fn(async () => undefined),
}))

vi.mock("@better-auth/api-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@better-auth/api-key")>()
  apiKeySpy.mockImplementation((...args: Parameters<typeof actual.apiKey>) =>
    actual.apiKey(...args),
  )
  return { ...actual, apiKey: apiKeySpy }
})

vi.mock("../db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/client.js")>()
  return { ...actual, withOrgDbContext: withOrgDbContextMock }
})

vi.mock("../platform/graph/client.js", () => ({
  withGraphClient: withGraphClientMock,
}))

vi.mock("../domain/repositoryDeletion.js", () => ({
  purgeOrgDataBeforeAuthDelete: purgeOrgDataBeforeAuthDeleteMock,
}))

import { createBetterAuth } from "./config.js"

type OAuthProviderOptions = {
  postLogin?: {
    page?: string
    shouldRedirect?: (...args: never[]) => unknown
    consentReferenceId?: (...args: never[]) => unknown
  }
  customAccessTokenClaims?: (input: {
    referenceId?: string
  }) => Promise<Record<string, unknown>> | Record<string, unknown>
}

type OrganizationRole = {
  statements: Record<string, readonly string[] | undefined>
  authorize: (request: Record<string, string[]>) => { success: boolean }
}

type OrganizationPluginOptions = {
  requireEmailVerificationOnInvitation?: boolean
  ac?: { statements: Record<string, readonly string[]> }
  roles?: {
    owner?: OrganizationRole
    admin?: OrganizationRole
    member?: OrganizationRole
  }
  organizationHooks?: {
    beforeDeleteOrganization?: (input: {
      organization: { id: string; slug: string; name?: string }
    }) => Promise<void>
  }
}

const THIRTY_DAYS_MS = 1000 * 60 * 60 * 24 * 30
const ONE_HOUR_MS = 60 * 60 * 1000
const API_KEY_ACTIONS = ["create", "read", "update", "delete"]

function stubAuthEnv() {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/ctxpipe")
  vi.stubEnv("AUTH_SECRET", "test-only-auth-secret-with-at-least-32-characters")
  vi.stubEnv("AUTH_BASE_URL", "http://localhost:3000")
}

function createAuth() {
  stubAuthEnv()
  return createBetterAuth()
}

function getPlugin(auth: ReturnType<typeof createBetterAuth>, id: string) {
  return auth.options.plugins?.find((plugin) => plugin.id === id)
}

function getPluginOptions<T>(plugin: unknown): T | undefined {
  if (plugin && typeof plugin === "object" && "options" in plugin) {
    return plugin.options as T
  }
  return undefined
}

describe("createBetterAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    withOrgDbContextMock.mockClear()
    withGraphClientMock.mockClear()
    purgeOrgDataBeforeAuthDeleteMock.mockClear()
  })

  it("registers user and organization API-key configs with the same 30-day / 1k-per-hour policy", () => {
    const auth = createAuth()
    const apiKeyPlugin = getPlugin(auth, "api-key")

    expect(apiKeyPlugin).toBeDefined()
    expect(apiKeySpy.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({
        configId: "default",
        references: "user",
        enableSessionForAPIKeys: true,
        keyExpiration: {
          defaultExpiresIn: THIRTY_DAYS_MS,
          disableCustomExpiresTime: false,
        },
        rateLimit: {
          enabled: true,
          timeWindow: ONE_HOUR_MS,
          maxRequests: 1000,
        },
      }),
      expect.objectContaining({
        configId: "organization",
        references: "organization",
        enableSessionForAPIKeys: false,
        keyExpiration: {
          defaultExpiresIn: THIRTY_DAYS_MS,
          disableCustomExpiresTime: false,
        },
        rateLimit: {
          enabled: true,
          timeWindow: ONE_HOUR_MS,
          maxRequests: 1000,
        },
      }),
    ])
  })

  it("grants admin and owner API-key CRUD and leaves members without API-key actions", () => {
    const auth = createAuth()
    const organizationPlugin = getPlugin(auth, "organization")
    const options =
      getPluginOptions<OrganizationPluginOptions>(organizationPlugin)
    const roles = options?.roles

    expect(organizationPlugin).toBeDefined()
    expect(options).toMatchObject({
      requireEmailVerificationOnInvitation: false,
    })
    expect(options?.ac?.statements.apiKey).toEqual(API_KEY_ACTIONS)

    expect(roles?.owner?.statements.apiKey).toEqual(API_KEY_ACTIONS)
    expect(roles?.admin?.statements.apiKey).toEqual(API_KEY_ACTIONS)
    expect(roles?.member?.statements.apiKey).toBeUndefined()

    expect(roles?.owner?.authorize({ apiKey: ["create"] }).success).toBe(true)
    expect(roles?.admin?.authorize({ apiKey: ["delete"] }).success).toBe(true)
    expect(roles?.member?.authorize({ apiKey: ["create"] }).success).toBe(false)
    expect(roles?.member?.authorize({ apiKey: ["read"] }).success).toBe(false)
    expect(roles?.member?.authorize({ apiKey: ["update"] }).success).toBe(false)
    expect(roles?.member?.authorize({ apiKey: ["delete"] }).success).toBe(false)

    expect(roles?.admin?.authorize({ organization: ["update"] }).success).toBe(
      true,
    )
    expect(roles?.admin?.authorize({ organization: ["delete"] }).success).toBe(
      false,
    )
    expect(roles?.owner?.authorize({ organization: ["delete"] }).success).toBe(
      true,
    )
    expect(roles?.member?.authorize({ member: ["create"] }).success).toBe(false)
  })

  it("allows emailed invitations with opaque custom IDs to be accepted", () => {
    const auth = createAuth()
    const organizationPlugin = getPlugin(auth, "organization")

    expect(organizationPlugin).toBeDefined()
    expect(
      getPluginOptions<OrganizationPluginOptions>(organizationPlugin),
    ).toMatchObject({
      requireEmailVerificationOnInvitation: false,
    })
  })

  it("still purges org product data in beforeDeleteOrganization", async () => {
    const auth = createAuth()
    const organizationPlugin = getPlugin(auth, "organization")
    const options =
      getPluginOptions<OrganizationPluginOptions>(organizationPlugin)
    const beforeDelete = options?.organizationHooks?.beforeDeleteOrganization

    expect(beforeDelete).toEqual(expect.any(Function))
    await beforeDelete?.({
      organization: { id: "org_acme", slug: "acme", name: "Acme" },
    })

    expect(withOrgDbContextMock).toHaveBeenCalledWith(
      "org_acme",
      expect.any(Function),
    )
    expect(withGraphClientMock).toHaveBeenCalledWith(
      { orgId: "org_acme", orgSlug: "acme" },
      expect.any(Function),
    )
    expect(purgeOrgDataBeforeAuthDeleteMock).toHaveBeenCalledWith("org_acme")
  })

  it("binds OAuth access tokens to an organization selected before consent", async () => {
    const auth = createAuth()
    const oauthPlugin = getPlugin(auth, "oauth-provider")
    const options = getPluginOptions<OAuthProviderOptions>(oauthPlugin)

    expect(options?.postLogin).toMatchObject({
      page: "/.auth/select-organization",
      shouldRedirect: expect.any(Function),
      consentReferenceId: expect.any(Function),
    })
    expect(
      await options?.customAccessTokenClaims?.({
        referenceId: "org_acme",
      }),
    ).toEqual({
      "https://ctxpipe.ai/organization_id": "org_acme",
    })
  })

  it("registers the dash plugin only when BETTER_AUTH_API_KEY is set", () => {
    vi.stubEnv("BETTER_AUTH_API_KEY", "")
    expect(getPlugin(createAuth(), "dash")).toBeUndefined()

    vi.stubEnv("BETTER_AUTH_API_KEY", "test-dash-key")
    expect(getPlugin(createAuth(), "dash")).toBeDefined()
  })
})
