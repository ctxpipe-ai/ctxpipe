import type { QueryClient } from "@tanstack/react-query"
import type { Router } from "@tanstack/react-router"
import { setStoredSelectedOrganizationSlug } from "@/lib/user-preferences"

export const organizationCreatePath = "/.auth/api/v1/auth/organization/create"
const organizationCreateRelativePath = "/organization/create"

type OrganizationCreateRedirectDeps = {
  queryClient: QueryClient
  router: Pick<Router<unknown>, "navigate">
  getPathname: () => string
}

type AuthFetchSuccessContext = {
  data: { slug?: string } | null | undefined
  request: { url: string | URL; method: string }
}

let organizationCreateRedirectDeps: OrganizationCreateRedirectDeps | null =
  null

export function setOrganizationCreateRedirectDeps(
  deps: OrganizationCreateRedirectDeps | null,
): void {
  organizationCreateRedirectDeps = deps
}

export function resolveOrganizationCreatePathname(
  url: string | URL,
): string {
  if (typeof url === "string") {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return new URL(url).pathname
    }
    return url.startsWith("/") ? url : `/${url}`
  }
  return url.pathname
}

export function isOrganizationCreateRequest(
  pathname: string,
  method: string,
): boolean {
  if (method.toUpperCase() !== "POST") return false
  return (
    pathname === organizationCreatePath ||
    pathname === organizationCreateRelativePath ||
    pathname.endsWith("/organization/create")
  )
}

export async function handleOrganizationCreateSuccess(
  org: { slug?: string },
  {
    queryClient,
    router,
    pathname,
  }: {
    queryClient: QueryClient
    router: Pick<Router<unknown>, "navigate">
    pathname: string
  },
): Promise<void> {
  if (!org.slug) return

  await queryClient.invalidateQueries({
    queryKey: ["organizations"],
    refetchType: "active",
  })

  if (pathname.startsWith("/onboarding")) return

  setStoredSelectedOrganizationSlug(org.slug)
  await router.navigate({
    to: "/$orgSlug/setup",
    params: { orgSlug: org.slug },
    replace: true,
  })
}

export async function onAuthClientOrganizationCreateSuccess(
  context: AuthFetchSuccessContext,
): Promise<void> {
  const deps = organizationCreateRedirectDeps
  if (!deps) return

  const pathname = resolveOrganizationCreatePathname(context.request.url)
  if (!isOrganizationCreateRequest(pathname, context.request.method)) return
  if (!context.data?.slug) return

  await handleOrganizationCreateSuccess(context.data, {
    queryClient: deps.queryClient,
    router: deps.router,
    pathname: deps.getPathname(),
  })
}

export async function handleOrganizationCreateResponse(
  response: Response,
  {
    queryClient,
    router,
    pathname,
  }: {
    queryClient: QueryClient
    router: Pick<Router<unknown>, "navigate">
    pathname: string
  },
): Promise<void> {
  if (!response.ok) return

  let org: { slug?: string } | null = null
  try {
    org = (await response.clone().json()) as { slug?: string }
  } catch {
    return
  }

  if (!org) return
  await handleOrganizationCreateSuccess(org, {
    queryClient,
    router,
    pathname,
  })
}
