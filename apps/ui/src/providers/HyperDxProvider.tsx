import HyperDX from "@hyperdx/browser"
import { useRouter, useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewFromMatches,
  orgSlugFromMatches,
  readActiveOrganizationId,
  resolveHyperDxTeam,
  routerLocationMatchesResolved,
} from "@/lib/hyperdxAttributes"
import {
  clearHyperDxGlobalAttributes,
  readCachedHyperDxIdentity,
  recordHyperDxAction,
  setHyperDxGlobalAttributes,
} from "@/lib/hyperdxBrowser"
import {
  flushHyperDxDeferredExceptions,
  markHyperDxSdkReady,
  setHyperDxExceptionRecordingEnabled,
} from "@/lib/hyperdxQueryErrors"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import { retainServerHyperDxConfig } from "@/lib/hyperdxRuntimeConfig"

let hyperdxInitialized = false
let hideFlushRegistered = false

type HyperDxRouter = {
  state: {
    location: { pathname: string; href: string }
    matches: readonly {
      routeId: string
      pathname: string
      params: { orgSlug?: unknown }
    }[]
  }
  subscribe: (
    eventType: "onRendered" | "onLoad",
    fn: (event: { toLocation?: { pathname?: string } }) => void,
  ) => () => void
}

function sameOriginTraceTargets(origin: string): RegExp[] {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return [new RegExp(`^${escaped}(?:/|$)`), /^\//]
}

function ensureHyperDxBrowser(runtimeConfig: HyperDxRuntimeConfig): void {
  if (hyperdxInitialized || typeof window === "undefined") return
  if (!runtimeConfig.enabled) return
  const origin = window.location.origin
  const otelResourceAttributes: Record<string, string> = {
    "service.namespace": "ctxpipe",
  }
  if (runtimeConfig.environment) {
    otelResourceAttributes["deployment.environment"] = runtimeConfig.environment
  }
  HyperDX.init({
    url: `${origin}/.otel`,
    apiKey: "proxy",
    service: "ui",
    tracePropagationTargets: sameOriginTraceTargets(origin),
    ignoreUrls: hyperdxExporterIgnoreUrls,
    consoleCapture: true,
    advancedNetworkCapture: false,
    disableReplay: true,
    disableIntercom: true,
    instrumentations: {
      document: true,
      postload: true,
      webvitals: true,
      errors: true,
    },
    otelResourceAttributes,
  })
  const cached = readCachedHyperDxIdentity()
  if (cached) HyperDX.setGlobalAttributes(cached)
  hyperdxInitialized = true
  markHyperDxSdkReady()
  if (!hideFlushRegistered) {
    hideFlushRegistered = true
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushHyperDxDeferredExceptions()
      }
    })
    window.addEventListener("pagehide", () => {
      flushHyperDxDeferredExceptions()
    })
  }
}

type IdentitySnapshot = {
  enabled: boolean
  sessionPending: boolean
  userId: string | undefined
  organizations: { id: string; slug: string }[] | undefined
  activeOrganizationId: string
}

/**
 * Runtime config comes from the root route loader (SSR), not client fetch.
 * Init syncs the HyperDX SDK (external system). Page views are recorded by
 * `HyperDxPageView`, which is mounted on the root route component so it
 * re-renders on client navigations. The root shell does not.
 */
export const HyperDxProvider: FC<{
  children: ReactNode
  runtimeConfig: HyperDxRuntimeConfig
}> = ({ children, runtimeConfig }) => {
  const config = retainServerHyperDxConfig(runtimeConfig)
  useEffect(() => {
    setHyperDxExceptionRecordingEnabled(config.enabled)
    ensureHyperDxBrowser(config)
  }, [config])

  return children
}

/**
 * Mount this under the root route `component` (inside `Outlet`'s parent),
 * not the document shell. `useRouterState` re-renders on every location
 * change, and `onRendered` is the public event TanStack emits after the
 * new match has rendered.
 */
export const HyperDxPageView: FC<{
  runtimeConfig: HyperDxRuntimeConfig
}> = ({ runtimeConfig }) => {
  const config = retainServerHyperDxConfig(runtimeConfig)
  const router = useRouter({ warn: false }) as HyperDxRouter | undefined
  const navKey = useRouterState({
    select: (state) => {
      const leaf = state.matches[state.matches.length - 1]
      return `${state.location.pathname}\n${leaf?.pathname ?? ""}\n${leaf?.routeId ?? ""}`
    },
  })
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations } = useListOrganizations()
  const userId = session?.user?.id
  const activeOrganizationId = readActiveOrganizationId(session?.session)
  const lastPath = useRef<string | undefined>(undefined)
  const snapshotRef = useRef<IdentitySnapshot>({
    enabled: config.enabled,
    sessionPending: true,
    userId: undefined,
    organizations: undefined,
    activeOrganizationId: "",
  })
  const publishRef = useRef<() => void>(() => {})

  useEffect(() => {
    snapshotRef.current = {
      enabled: config.enabled,
      sessionPending,
      userId,
      organizations,
      activeOrganizationId,
    }
    const current = router
    publishRef.current = () => {
      if (!current?.state || !hyperdxInitialized) return
      const snapshot = snapshotRef.current
      if (!snapshot.enabled || snapshot.sessionPending) return
      const pathname = current.state.location.pathname
      const matches = current.state.matches.map((match) => ({
        routeId: match.routeId,
        pathname: match.pathname,
        params: match.params,
      }))
      if (!routerLocationMatchesResolved(pathname, matches)) return
      const view = hyperdxPageViewFromMatches({ pathname, matches })
      if (lastPath.current === view.path) return
      lastPath.current = view.path
      const team = snapshot.userId
        ? resolveHyperDxTeam({
            orgSlugFromRoute: view["ctxpipe.org.slug"],
            organizations: snapshot.organizations,
            activeOrganizationId: snapshot.activeOrganizationId,
          })
        : { teamId: "", teamName: "" }
      recordHyperDxAction("page_view", {
        ...view,
        ...hyperdxGlobalAttributes({
          userId: snapshot.userId,
          teamId: team.teamId,
          teamName: team.teamName,
        }),
      })
    }
  }, [
    config.enabled,
    router,
    sessionPending,
    userId,
    organizations,
    activeOrganizationId,
  ])

  useEffect(() => {
    const current = router
    if (!config.enabled || !current?.state || navKey.length === 0) return
    ensureHyperDxBrowser(config)
    if (!hyperdxInitialized) return
    if (sessionPending) return
    if (!userId) {
      clearHyperDxGlobalAttributes()
    } else {
      const pathname = current.state.location.pathname
      const matches = current.state.matches.map((match) => ({
        routeId: match.routeId,
        pathname: match.pathname,
        params: match.params,
      }))
      const slug = routerLocationMatchesResolved(pathname, matches)
        ? orgSlugFromMatches(matches)
        : ""
      const team = resolveHyperDxTeam({
        orgSlugFromRoute: slug,
        organizations,
        activeOrganizationId,
      })
      setHyperDxGlobalAttributes(
        hyperdxGlobalAttributes({
          userId,
          teamId: team.teamId,
          teamName: team.teamName,
        }),
        { activeOrganizationId },
      )
    }
    publishRef.current()
  }, [
    config,
    router,
    navKey,
    sessionPending,
    userId,
    organizations,
    activeOrganizationId,
  ])

  useEffect(() => {
    const current = router
    if (!config.enabled || !current) return
    const publish = () => {
      publishRef.current()
    }
    const unsubscribeRendered = current.subscribe("onRendered", publish)
    const unsubscribeLoad = current.subscribe("onLoad", publish)
    return () => {
      unsubscribeRendered()
      unsubscribeLoad()
    }
  }, [config.enabled, router])

  return null
}
