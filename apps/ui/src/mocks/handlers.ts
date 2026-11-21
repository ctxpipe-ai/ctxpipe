import { delay, HttpResponse, http } from "msw"

import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"

import { type MockState, mockResponse } from "./mock-state"

const authBase = "*/.auth/api/v1/auth"

/** UI server exposes Better Auth config for social providers list. */
export const authConfigHandler = http.get("*/.auth/api/config", () =>
  HttpResponse.json({ providers: [] }),
)

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

export const sessionSignedOutHandler = http.get(`${authBase}/get-session`, () =>
  HttpResponse.json(null),
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
  organizations: {
    id: string
    name: string
    slug: string
    createdAt?: string
  }[],
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
  message = "Failed to create organization",
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

/** Backend returns JSON `null` with 200 when the org has no GitHub installation yet. */
export const githubInstallationNoneHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.includes("/api/v1/github/installation"),
  () => HttpResponse.json(null),
)

/** The org has a GitHub App installation (`installationId` set). */
export const githubInstallationLinkedHandler = http.get(
  ({ request }) =>
    /\/api\/v1\/github\/installation$/.test(new URL(request.url).pathname),
  () =>
    HttpResponse.json({
      id: "con_story_github",
      appSlug: "ctxpipe",
      accountSlug: "acme",
      installationId: 4242,
    }),
)

/** The GitHub connector bootstrap of the org, with the hosted GitHub App. */
export const hostedGithubAppBootstrapHandler = githubConnectorBootstrapHandler({
  orgSlug: "acme",
  hostedDefaultAppInstallUrl:
    "https://github.com/apps/ctxpipe/installations/new",
})

/**
 * The org has the GitHub App installed: the connector bootstrap (with the
 * hosted App) and the installation. A repository picker reads both.
 */
export const githubAppInstalledHandlers = [
  hostedGithubAppBootstrapHandler,
  githubInstallationLinkedHandler,
]

/** `POST .../github/installation`: registers an installation; `reply` answers it. */
export function githubInstallationRegisterHandler(reply: () => Response) {
  return http.post("*/api/v1/github/installation", reply)
}

/** The org has no GitHub App installation yet; the hosted App can install. */
export const githubAppMissingHandlers = [
  hostedGithubAppBootstrapHandler,
  githubInstallationNoneHandler,
]

export function organizationFullHandler(
  organization: MockState<{ id: string; name: string; slug: string }>,
) {
  return http.get(`${authBase}/organization/get-full-organization`, () =>
    mockResponse(organization, (organization) =>
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
    ),
  )
}

export const organizationFullWithOrgHandler = organizationFullHandler({
  id: "org_storybook",
  name: "Storybook Org",
  slug: "acme",
})

/**
 * The signed-in story user, an admin of the org `acme`, who completed
 * onboarding: the auth config, the session, the org list and the full org.
 * The app providers (`parameters.app`) read them on each page.
 */
export const signedInHandlers = [
  authConfigHandler,
  sessionSignedInHandler({
    id: "user_storybook",
    onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
  }),
  organizationListWithOrgHandler,
  organizationFullWithOrgHandler,
]

/**
 * `GET .../organization/list-members` in the Better Auth response shape:
 * the story user is the owner, and `count - 1` members follow.
 */
export function organizationMembersHandler(count: MockState<number>) {
  return http.get(`${authBase}/organization/list-members`, () =>
    mockResponse(count, (count) =>
      HttpResponse.json({
        members: Array.from({ length: count }, (_, index) => ({
          id: `mem_story_${index}`,
          organizationId: "org_storybook",
          userId: index === 0 ? "user_storybook" : `user_story_${index}`,
          role: index === 0 ? "owner" : "member",
          createdAt: "2026-10-01T00:00:00.000Z",
          user: {
            id: index === 0 ? "user_storybook" : `user_story_${index}`,
            name: "Storybook User",
            email: `member${index}@story.example`,
            image: null,
          },
        })),
        total: count,
      }),
    ),
  )
}

/** `GET .../organization/list-invitations`: one invitation for each status. */
export function organizationInvitationsHandler(statuses: MockState<string[]>) {
  return http.get(`${authBase}/organization/list-invitations`, () =>
    mockResponse(statuses, (statuses) =>
      HttpResponse.json(
        statuses.map((status, index) => ({
          id: `inv_story_${index}`,
          organizationId: "org_storybook",
          email: `teammate${index}@story.example`,
          role: "member",
          status,
          inviterId: "user_storybook",
          expiresAt: "2026-12-01T00:00:00.000Z",
          createdAt: "2026-10-01T00:00:00.000Z",
        })),
      ),
    ),
  )
}

/**
 * `POST .../organization/has-permission`: whether the story user may do the
 * asked action in the org (an admin may).
 */
export function organizationPermissionHandler(allowed: MockState<boolean>) {
  return http.post(`${authBase}/organization/has-permission`, () =>
    mockResponse(allowed, (success) =>
      HttpResponse.json({ success, error: null }),
    ),
  )
}

/**
 * `POST .../organization/set-active`: the server makes the org active. Each
 * call runs `onSetActive`, so a play can count the calls.
 */
export function organizationSetActiveHandler(onSetActive?: () => void) {
  return http.post(`${authBase}/organization/set-active`, () => {
    onSetActive?.()
    return HttpResponse.json({})
  })
}

/** `GET .../organization/list-user-invitations`: the invitations of the user. */
export const userInvitationsEmptyHandler = http.get(
  `${authBase}/organization/list-user-invitations`,
  () => HttpResponse.json([]),
)

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

function orgApiKeysListHandler(apiKeys: StoryOrgApiKey[]) {
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
