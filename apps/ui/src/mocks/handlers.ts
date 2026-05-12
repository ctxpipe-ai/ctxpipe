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
