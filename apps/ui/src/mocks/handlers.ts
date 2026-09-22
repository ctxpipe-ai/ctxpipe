import { delay, HttpResponse, http } from "msw"

const authBase = "*/.auth/api/v1/auth"

/** UI server exposes Better Auth config for social providers list. */
export const authConfigHandler = http.get("*/.auth/api/config", () =>
  HttpResponse.json({ providers: [] }),
)

const sessionSignedOut = HttpResponse.json(null)

const sessionSignedIn = (user: {
  id: string
  email?: string
  onboardingCompletedAt?: string | null
}) =>
  HttpResponse.json({
    session: {
      id: "storybook-session",
      userId: user.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    user: {
      id: user.id,
      email: user.email ?? "story@ctxpipe.local",
      name: "Storybook User",
      emailVerified: true,
      onboardingCompletedAt: user.onboardingCompletedAt ?? null,
    },
  })

export const sessionSignedOutHandler = http.get(
  `${authBase}/get-session`,
  () => sessionSignedOut,
)

export function sessionSignedInHandler(user: {
  id: string
  email?: string
  onboardingCompletedAt?: string | null
}) {
  return http.get(`${authBase}/get-session`, () => sessionSignedIn(user))
}

/** Organization plugin client path (see better-auth proxy path builder). */
export function organizationListHandler(
  organizations: { id: string; name: string; slug: string }[],
) {
  return http.get(`${authBase}/organization/list`, () =>
    HttpResponse.json(organizations),
  )
}

export const organizationListEmptyHandler = organizationListHandler([])

export const organizationListWithOrgHandler = organizationListHandler([
  {
    id: "org_storybook",
    name: "Storybook Org",
    slug: "acme",
  },
])

export const sessionSignedInOnboardingHandler = sessionSignedInHandler({
  id: "user_onboarding_story",
  email: "owner@story.example",
  onboardingCompletedAt: null,
})

/** `POST /.auth/api/v1/auth/organization/create` — success (Better Auth shape). */
export function organizationCreateSuccessHandler() {
  return http.post(`${authBase}/organization/create`, async ({ request }) => {
    const body = (await request.json()) as { name: string; slug: string }
    return HttpResponse.json({
      id: `org_${body.slug.replace(/[^a-z0-9]+/gi, "_")}`,
      name: body.name,
      slug: body.slug,
      createdAt: new Date().toISOString(),
      metadata: null,
      logo: null,
      members: [],
    })
  })
}

export function organizationCreateErrorHandler(
  message = "Failed to create organisation",
) {
  return http.post(`${authBase}/organization/create`, async () => {
    await delay("real")
    return HttpResponse.json({ message }, { status: 400 })
  })
}

/** Create after MSW `delay("real")` (mirrors {@link organizationCreateSuccessHandler}). */
export function organizationCreateSlowSuccessHandler() {
  return http.post(`${authBase}/organization/create`, async ({ request }) => {
    await delay("real")
    const body = (await request.json()) as { name: string; slug: string }
    return HttpResponse.json({
      id: `org_${body.slug.replace(/[^a-z0-9]+/gi, "_")}`,
      name: body.name,
      slug: body.slug,
      createdAt: new Date().toISOString(),
      metadata: null,
      logo: null,
      members: [],
    })
  })
}

/** `POST /.auth/api/v1/auth/organization/invite-member` — per-email success. */
export function organizationInviteSuccessHandler() {
  return http.post(
    `${authBase}/organization/invite-member`,
    async ({ request }) => {
      const body = (await request.json()) as {
        email: string
        role: string
        organizationId?: string
      }
      return HttpResponse.json({
        id: `inv_${body.email.replace(/[@.]+/g, "_")}`,
        email: body.email,
        role: body.role,
        organizationId: body.organizationId ?? "org_storybook",
        inviterId: "user_onboarding_story",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
    },
  )
}

export function organizationInviteErrorHandler() {
  return http.post(`${authBase}/organization/invite-member`, async () => {
    await delay("real")
    return HttpResponse.json({ message: "Invite failed" }, { status: 400 })
  })
}

/** Invite after MSW `delay("real")` (same JSON shape as {@link organizationInviteSuccessHandler}). */
export function organizationInviteSlowSuccessHandler() {
  return http.post(
    `${authBase}/organization/invite-member`,
    async ({ request }) => {
      await delay("real")
      const body = (await request.json()) as {
        email: string
        role: string
        organizationId?: string
      }
      return HttpResponse.json({
        id: `inv_${body.email.replace(/[@.]+/g, "_")}`,
        email: body.email,
        role: body.role,
        organizationId: body.organizationId ?? "org_storybook",
        inviterId: "user_onboarding_story",
        status: "pending",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdAt: new Date().toISOString(),
      })
    },
  )
}

/** Backend returns JSON `null` with 200 when the org has no GitHub installation yet. */
export const githubInstallationNoneHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.includes("/api/v1/github/installation"),
  () => HttpResponse.json(null),
)

export function organizationFullHandler(organization: {
  id: string
  name: string
  slug: string
}) {
  return http.get(`${authBase}/organization/get-full-organization`, () =>
    HttpResponse.json({
      ...organization,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: null,
      logo: null,
      members: [
        {
          id: "mem_storybook",
          userId: "user_storybook",
          organizationId: organization.id,
          role: "admin",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  )
}

export const organizationFullWithOrgHandler = organizationFullHandler({
  id: "org_storybook",
  name: "Storybook Org",
  slug: "acme",
})

type StoryOrgApiKey = {
  id: string
  name: string
  start: string
  expiresAt: string | null
}

async function requireOrganizationApiKeyBody(
  request: Request,
): Promise<Response | null> {
  const body = (await request.clone().json()) as { configId?: string }
  if (body.configId === "organization") return null
  return HttpResponse.json(
    { message: "Expected configId=organization for org API keys" },
    { status: 400 },
  )
}

export function orgApiKeysListHandler(apiKeys: StoryOrgApiKey[]) {
  return http.get(`${authBase}/api-key/list`, ({ request }) => {
    const url = new URL(request.url)
    if (url.searchParams.get("configId") !== "organization") {
      return HttpResponse.json(
        { message: "Expected configId=organization for org API keys" },
        { status: 400 },
      )
    }
    return HttpResponse.json({ apiKeys, total: apiKeys.length })
  })
}

export const orgApiKeysListEmptyHandler = orgApiKeysListHandler([])

export const orgApiKeysListPopulatedHandler = orgApiKeysListHandler([
  {
    id: "key_ci",
    name: "ci-mcp",
    start: "org_ci1",
    expiresAt: "2026-10-14T00:00:00.000Z",
  },
])

export const orgApiKeysListForbiddenHandler = http.get(
  `${authBase}/api-key/list`,
  () =>
    HttpResponse.json(
      { message: "INSUFFICIENT_API_KEY_PERMISSIONS" },
      { status: 403 },
    ),
)

export function orgApiKeysCreateHandler() {
  return http.post(`${authBase}/api-key/create`, async ({ request }) => {
    const rejected = await requireOrganizationApiKeyBody(request)
    if (rejected) return rejected
    const body = (await request.json()) as {
      name?: string
      configId?: string
      organizationId?: string
    }
    return HttpResponse.json({
      id: "key_created",
      name: body.name ?? "unnamed",
      start: "org_new",
      key: "org_plaintext_shown_once",
      configId: body.configId,
      referenceId: body.organizationId ?? "org_storybook",
      expiresAt: "2026-10-14T00:00:00.000Z",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  })
}

export function orgApiKeysUpdateHandler() {
  return http.post(`${authBase}/api-key/update`, async ({ request }) => {
    const rejected = await requireOrganizationApiKeyBody(request)
    if (rejected) return rejected
    return HttpResponse.json({ success: true })
  })
}

export function orgApiKeysDeleteHandler() {
  return http.post(`${authBase}/api-key/delete`, async ({ request }) => {
    const rejected = await requireOrganizationApiKeyBody(request)
    if (rejected) return rejected
    return HttpResponse.json({ success: true })
  })
}
