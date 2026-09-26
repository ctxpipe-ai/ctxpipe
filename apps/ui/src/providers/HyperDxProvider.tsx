import HyperDX from "@hyperdx/browser"
import { useParams, useRouter, useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  type HyperDxOrgRef,
  type HyperDxSessionIdentity,
  hyperdxPageViewAction,
  isHyperDxAuthPath,
  isHyperDxSignOutPath,
  resolveHyperDxTeam,
} from "@/lib/hyperdxAttributes"
import {
  clearHyperDxGlobalAttributes,
  initHyperDxBrowser,
  setHyperDxGlobalAttributes,
} from "@/lib/hyperdxBrowser"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"

let recordedInitialPageView = false

function activeOrganizationId(
  session: { activeOrganizationId?: string | null } | undefined,
): string {
  const id = session?.activeOrganizationId
  return typeof id === "string" ? id : ""
}

function orgRefs(
  organizations: readonly { id: string; slug: string }[] | null | undefined,
): HyperDxOrgRef[] | undefined {
  if (!Array.isArray(organizations)) return undefined
  return organizations.flatMap((org) =>
    org.id && org.slug ? [{ id: org.id, slug: org.slug }] : [],
  )
}

/**
 * Runtime config and the first identity come from the root loader (server).
 * Later session and org changes update the SDK. Page views follow resolved navigations.
 */
export const HyperDxProvider: FC<{
  children: ReactNode
  runtimeConfig: HyperDxRuntimeConfig
  initialIdentity?: HyperDxSessionIdentity | null
}> = ({ children, runtimeConfig, initialIdentity = null }) => {
  const enabled = runtimeConfig.enabled
  const environment = runtimeConfig.enabled
    ? runtimeConfig.environment
    : undefined
  const bootstrapRef = useRef(initialIdentity)
  if (initialIdentity?.userId) bootstrapRef.current = initialIdentity

  const router = useRouter()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const params = useParams({ strict: false })
  const orgSlug = typeof params.orgSlug === "string" ? params.orgSlug : ""
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations } = useListOrganizations()
  const userId = session?.user.id ?? ""
  const organizationId = activeOrganizationId(session?.session)

  useEffect(() => {
    initHyperDxBrowser(
      enabled
        ? environment
          ? { enabled: true, environment }
          : { enabled: true }
        : { enabled: false },
      bootstrapRef.current,
    )
  }, [enabled, environment])

  useEffect(() => {
    if (!enabled) return
    if (isHyperDxSignOutPath(pathname)) {
      clearHyperDxGlobalAttributes()
      return
    }
    if (sessionPending) return
    if (!userId) {
      clearHyperDxGlobalAttributes()
      return
    }
    if (isHyperDxAuthPath(pathname)) {
      setHyperDxGlobalAttributes({ userId, teamId: "", teamName: "" })
      return
    }
    const list = orgRefs(organizations)
    if (!list) {
      const bootstrap = bootstrapRef.current
      if (orgSlug && orgSlug !== (bootstrap?.teamName ?? "")) {
        setHyperDxGlobalAttributes({ userId, teamId: "", teamName: orgSlug })
      }
      return
    }
    const team = resolveHyperDxTeam({
      orgSlugFromRoute: orgSlug,
      organizations: list,
      activeOrganizationId: organizationId,
    })
    setHyperDxGlobalAttributes({
      userId,
      teamId: team.teamId,
      teamName: team.teamName,
    })
  }, [
    enabled,
    pathname,
    sessionPending,
    userId,
    organizations,
    organizationId,
    orgSlug,
  ])

  useEffect(() => {
    if (!enabled) return
    const record = (path: string) => {
      HyperDX.addAction(
        "page_view",
        hyperdxPageViewAction({
          pathname: path,
          routeId: router.state.matches.at(-1)?.routeId ?? "",
        }),
      )
    }
    if (!recordedInitialPageView && router.state.status === "idle") {
      recordedInitialPageView = true
      record(router.state.location.pathname)
    }
    return router.subscribe("onResolved", ({ toLocation }) => {
      recordedInitialPageView = true
      record(toLocation.pathname)
    })
  }, [enabled, router])

  return children
}
