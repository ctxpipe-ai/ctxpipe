import { HttpResponse, http } from "msw"

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

/** Backend returns JSON `null` with 200 when the org has no GitHub installation yet. */
export const githubInstallationNoneHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.includes("/api/v1/github/installation"),
  () => HttpResponse.json(null),
)
