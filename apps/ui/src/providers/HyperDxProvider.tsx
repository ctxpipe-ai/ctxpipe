import HyperDX from "@hyperdx/browser"
import { useRouter, useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  type HyperDxSessionIdentity,
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
  orgSlugFromPathname,
  readEarlyHyperDxIdentity,
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

function identityForInit(options?: {
  pathname?: string
  identity?: HyperDxSessionIdentity | null
}): HyperDxSessionIdentity | null {
  if (!options) return null
  if ("identity" in options) return options.identity ?? null
  return readEarlyHyperDxIdentity(options.pathname)
}

function ensureHyperDxBrowser(
  runtimeConfig: HyperDxRuntimeConfig,
  options?: {
    pathname?: string
    identity?: HyperDxSessionIdentity | null
  },
): void {
  if (typeof window === "undefined" || !runtimeConfig.enabled) return
  const identity = identityForInit(options)
  if (!hyperdxInitialized) {
    const origin = window.location.origin
    const otelResourceAttributes: Record<string, string> = {
      "service.namespace": "ctxpipe",
    }
    if (runtimeConfig.environment) {
      otelResourceAttributes["deployment.environment"] =
        runtimeConfig.environment
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
      // `@hyperdx/otel-web` 0.20.0 `dist/esm/index.js` leaves `interactions` and
      // `longtask` enabled (`disable: false`); `getPluginConfig` in `utils.js`
      // turns one off only when the value is `false`. `@hyperdx/browser` 0.26.0
      // `build/index.js` sets fetch/xhr `propagateTraceHeaderCorsUrls` from
      // `tracePropagationTargets`, then spreads this object, so those keys stay
      // unset or the traceparent config is replaced.
      instrumentations: {
        document: true,
        postload: true,
        webvitals: true,
        errors: true,
        interactions: false,
        longtask: false,
      },
      otelResourceAttributes,
    })
    if (identity) HyperDX.setGlobalAttributes(hyperdxGlobalAttributes(identity))
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
    return
  }
  if (identity) HyperDX.setGlobalAttributes(hyperdxGlobalAttributes(identity))
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

/** Test isolation. Production init stays process-wide. */
export function resetHyperDxProviderForTests(): void {
  hyperdxInitialized = false
}

function teamForRoute(input: {
  pathname: string
  slug: string
  userId: string
  organizations: { id: string; slug: string }[] | undefined
  activeOrganizationId: string
}): { teamId: string; teamName: string } {
  const resolved = resolveHyperDxTeam({
    orgSlugFromRoute: input.slug,
    organizations: input.organizations,
    activeOrganizationId: input.activeOrganizationId,
  })
  if (resolved.teamId || !input.slug) return resolved
  const early = readEarlyHyperDxIdentity(input.pathname)
  if (early && early.userId === input.userId && early.teamId) {
    return {
      teamId: early.teamId,
      teamName: early.teamName || resolved.teamName,
    }
  }
  return resolved
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
  // Better Auth's org query starts as `null` (and stays `null` on 401).
  // `null` is "not loaded", not an empty list — an empty membership is `[]`.
  // Passing `null` into the identity cache calls `.flatMap` and crashes the route.
  const organizationList = Array.isArray(organizations)
    ? organizations
    : undefined
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
      organizations: organizationList,
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
        ? teamForRoute({
            pathname,
            slug: view["ctxpipe.org.slug"],
            userId: snapshot.userId,
            organizations: snapshot.organizations,
            activeOrganizationId: snapshot.activeOrganizationId,
          })
        : { teamId: "", teamName: "" }
      recordHyperDxAction("page_view", {
        ...hyperdxGlobalAttributes({
          userId: snapshot.userId,
          teamId: team.teamId,
          teamName: team.teamName,
        }),
        ...view,
      })
    }

    if (!config.enabled || !current) return

    const pathname = current.state?.location.pathname ?? ""
    const matches = (current.state?.matches ?? []).map((match) => ({
      routeId: match.routeId,
      pathname: match.pathname,
      params: match.params,
    }))
    const slug = routerLocationMatchesResolved(pathname, matches)
      ? orgSlugFromMatches(matches)
      : orgSlugFromPathname(pathname)

    if (sessionPending) {
      ensureHyperDxBrowser(config, { pathname })
    } else if (!userId) {
      ensureHyperDxBrowser(config, { pathname, identity: null })
      clearHyperDxGlobalAttributes()
    } else {
      const team = teamForRoute({
        pathname,
        slug,
        userId,
        organizations: organizationList,
        activeOrganizationId,
      })
      const attributes = hyperdxGlobalAttributes({
        userId,
        teamId: team.teamId,
        teamName: team.teamName,
      })
      ensureHyperDxBrowser(config, { pathname, identity: attributes })
      setHyperDxGlobalAttributes(attributes, {
        activeOrganizationId,
        organizations: organizationList,
      })
    }

    if (
      current.state &&
      navKey.length > 0 &&
      hyperdxInitialized &&
      !sessionPending
    ) {
      publishRef.current()
    }

    const publish = () => {
      publishRef.current()
    }
    const unsubscribeRendered = current.subscribe("onRendered", publish)
    const unsubscribeLoad = current.subscribe("onLoad", publish)
    return () => {
      unsubscribeRendered()
      unsubscribeLoad()
    }
  }, [
    config,
    router,
    navKey,
    sessionPending,
    userId,
    organizationList,
    activeOrganizationId,
  ])

  return null
}
