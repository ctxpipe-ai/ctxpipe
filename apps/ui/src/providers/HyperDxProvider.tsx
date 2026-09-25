import HyperDX from "@hyperdx/browser"
import { useRouter, useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useMemo, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  type HyperDxRouteMatch,
  type HyperDxSessionIdentity,
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewFromMatches,
  isHyperDxAuthPath,
  orgSlugFromMatches,
  readActiveOrganizationId,
  resolveHyperDxTeam,
  routerLocationMatchesResolved,
} from "@/lib/hyperdxAttributes"
import {
  applyHyperDxGlobalAttributes,
  clearHyperDxGlobalAttributes,
  orgSlugFromPathname,
  readEarlyHyperDxIdentity,
  recordHyperDxAction,
  resetHyperDxPublishedAttributesForTests,
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
    location: { pathname: string }
    matches: readonly {
      routeId: string
      pathname: string
      params: { orgSlug?: unknown }
    }[]
  }
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
  const identity =
    "identity" in options
      ? (options.identity ?? null)
      : readEarlyHyperDxIdentity(options.pathname)
  if (!identity?.userId || !options.pathname) return identity
  if (!isHyperDxAuthPath(options.pathname)) return identity
  return { userId: identity.userId, teamId: "", teamName: "" }
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
  if (identity) applyHyperDxGlobalAttributes(identity)
}

function useRetainedHyperDxConfig(
  runtimeConfig: HyperDxRuntimeConfig,
): HyperDxRuntimeConfig {
  const enabled = runtimeConfig.enabled
  const environment = runtimeConfig.enabled
    ? runtimeConfig.environment
    : undefined
  return useMemo(() => {
    const next: HyperDxRuntimeConfig = enabled
      ? environment
        ? { enabled: true, environment }
        : { enabled: true }
      : { enabled: false }
    return retainServerHyperDxConfig(next)
  }, [enabled, environment])
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
  const config = useRetainedHyperDxConfig(runtimeConfig)
  useEffect(() => {
    setHyperDxExceptionRecordingEnabled(config.enabled)
    ensureHyperDxBrowser(config)
  }, [config])

  return children
}

/** Test isolation. Production init stays process-wide. */
export function resetHyperDxProviderForTests(): void {
  hyperdxInitialized = false
  resetHyperDxPublishedAttributesForTests()
}

function currentTeam(input: {
  pathname: string
  slug: string
  userId: string
  organizations: { id: string; slug: string }[] | undefined
  activeOrganizationId: string
}): { teamId: string; teamName: string } {
  if (!input.userId || isHyperDxAuthPath(input.pathname)) {
    return { teamId: "", teamName: "" }
  }
  const resolved = resolveHyperDxTeam({
    orgSlugFromRoute: input.slug,
    organizations: input.organizations,
    activeOrganizationId: input.activeOrganizationId,
  })
  if (resolved.teamId || !input.slug) return resolved
  const early = readEarlyHyperDxIdentity(input.pathname)
  if (
    early &&
    early.userId === input.userId &&
    early.teamId &&
    early.teamName
  ) {
    return { teamId: early.teamId, teamName: early.teamName }
  }
  return resolved
}

function readLocation(router: HyperDxRouter | undefined): {
  pathname: string
  matches: HyperDxRouteMatch[]
} {
  return {
    pathname: router?.state.location.pathname ?? "",
    matches: (router?.state.matches ?? []).map((match) => ({
      routeId: match.routeId,
      pathname: match.pathname,
      params: match.params,
    })),
  }
}

function slugForLocation(
  pathname: string,
  matches: readonly HyperDxRouteMatch[],
): string {
  return routerLocationMatchesResolved(pathname, matches)
    ? orgSlugFromMatches(matches)
    : orgSlugFromPathname(pathname)
}

/**
 * Mount this under the root route `component` (inside `Outlet`'s parent),
 * not the document shell. `useRouterState` re-renders when the location or
 * the deepest match changes, which is when a page view is ready.
 */
export const HyperDxPageView: FC<{
  runtimeConfig: HyperDxRuntimeConfig
}> = ({ runtimeConfig }) => {
  const config = useRetainedHyperDxConfig(runtimeConfig)
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
  const lastView = useRef<{ path: string; teamId: string } | undefined>(
    undefined,
  )

  useEffect(() => {
    if (!config.enabled) return
    const pathname = navKey.split("\n")[0] ?? ""
    const { matches } = readLocation(router)
    if (sessionPending) {
      ensureHyperDxBrowser(config, { pathname })
      return
    }
    if (!userId) {
      ensureHyperDxBrowser(config, { pathname, identity: null })
      clearHyperDxGlobalAttributes()
      return
    }
    const team = currentTeam({
      pathname,
      slug: slugForLocation(pathname, matches),
      userId,
      organizations: organizationList,
      activeOrganizationId,
    })
    const identity: HyperDxSessionIdentity = {
      userId,
      teamId: team.teamId,
      teamName: team.teamName,
    }
    ensureHyperDxBrowser(config, { pathname, identity })
    setHyperDxGlobalAttributes(identity, {
      activeOrganizationId: isHyperDxAuthPath(pathname)
        ? ""
        : activeOrganizationId,
      organizations: organizationList,
    })
  }, [
    config,
    router,
    navKey,
    sessionPending,
    userId,
    organizationList,
    activeOrganizationId,
  ])

  useEffect(() => {
    if (!config.enabled || sessionPending || !hyperdxInitialized) return
    const pathname = navKey.split("\n")[0] ?? ""
    const { matches } = readLocation(router)
    if (!routerLocationMatchesResolved(pathname, matches)) return
    const view = hyperdxPageViewFromMatches({ pathname, matches })
    const team = currentTeam({
      pathname,
      slug: view["ctxpipe.org.slug"] ?? "",
      userId: userId ?? "",
      organizations: organizationList,
      activeOrganizationId,
    })
    const previous = lastView.current
    if (
      previous?.path === view.path &&
      (previous.teamId === team.teamId ||
        (previous.teamId !== "" && team.teamId === ""))
    ) {
      return
    }
    lastView.current = { path: view.path, teamId: team.teamId }
    recordHyperDxAction("page_view", {
      ...hyperdxGlobalAttributes({
        userId,
        teamId: team.teamId,
        teamName: team.teamName,
      }),
      ...view,
    })
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
