import HyperDX from "@hyperdx/browser"
import { useRouter, useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewFromMatches,
  readActiveOrganizationId,
  resolveHyperDxTeam,
  routerLocationMatchesResolved,
} from "@/lib/hyperdxAttributes"
import {
  clearHyperDxGlobalAttributes,
  setHyperDxGlobalAttributes,
} from "@/lib/hyperdxBrowser"
import { setHyperDxExceptionRecordingEnabled } from "@/lib/hyperdxQueryErrors"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import { retainServerHyperDxConfig } from "@/lib/hyperdxRuntimeConfig"

let hyperdxInitialized = false

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

function ensureHyperDxBrowser(runtimeConfig: HyperDxRuntimeConfig): void {
  if (hyperdxInitialized || typeof window === "undefined") return
  if (!runtimeConfig.enabled) return
  const origin = window.location.origin
  const url = runtimeConfig.url.startsWith("http")
    ? runtimeConfig.url
    : `${origin}${runtimeConfig.url}`
  HyperDX.init({
    url,
    apiKey: runtimeConfig.apiKey ?? "",
    service: "ui",
    tracePropagationTargets: [window.location.origin],
    ignoreUrls: hyperdxExporterIgnoreUrls,
    consoleCapture: true,
    advancedNetworkCapture: false,
    disableReplay: true,
    instrumentations: {
      document: true,
      postload: true,
      webvitals: true,
      errors: true,
    },
    otelResourceAttributes: {
      "deployment.environment": runtimeConfig.environment,
      "service.namespace": "ctxpipe",
    },
  })
  hyperdxInitialized = true
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
  setHyperDxExceptionRecordingEnabled(config.enabled)
  useEffect(() => {
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
  const { data: organizations, isPending: orgsPending } = useListOrganizations()
  const userId = session?.user?.id
  const lastKey = useRef<string | undefined>(undefined)
  const routerRef = useRef(router)
  routerRef.current = router
  const identityRef = useRef({
    sessionPending: true,
    orgsPending: true,
    userId: undefined as string | undefined,
    organizations: undefined as { id: string; slug: string }[] | undefined,
    activeOrganizationId: "",
  })
  identityRef.current = {
    sessionPending,
    orgsPending,
    userId,
    organizations,
    activeOrganizationId: readActiveOrganizationId(session?.session),
  }

  const publish = () => {
    const current = routerRef.current
    if (!config.enabled || !current?.state) return
    ensureHyperDxBrowser(config)
    if (!hyperdxInitialized) return
    const pathname = current.state.location.pathname
    const matches = current.state.matches.map((match) => ({
      routeId: match.routeId,
      pathname: match.pathname,
      params: match.params,
    }))
    if (!routerLocationMatchesResolved(pathname, matches)) return
    const view = hyperdxPageViewFromMatches({ pathname, matches })
    const identity = identityRef.current
    if (identity.sessionPending) return
    if (!identity.userId) {
      clearHyperDxGlobalAttributes()
    }
    const team = identity.userId
      ? resolveHyperDxTeam({
          orgSlugFromRoute: view["ctxpipe.org.slug"],
          organizations: identity.organizations,
          activeOrganizationId: identity.activeOrganizationId,
        })
      : { teamId: "", teamName: "" }
    const globals = hyperdxGlobalAttributes({
      userId: identity.userId,
      teamId: team.teamId,
      teamName: team.teamName,
    })
    if (identity.userId) {
      setHyperDxGlobalAttributes(globals)
    }
    const dedupe = `${view.path}\n${globals.userId}\n${globals.teamId}\n${globals.teamName}`
    if (lastKey.current === dedupe) return
    lastKey.current = dedupe
    HyperDX.addAction("page_view", { ...view, ...globals })
  }
  const publishRef = useRef(publish)
  publishRef.current = publish

  useEffect(() => {
    if (!config.enabled || !router || navKey.length === 0) return
    identityRef.current = {
      sessionPending,
      orgsPending,
      userId,
      organizations,
      activeOrganizationId: readActiveOrganizationId(session?.session),
    }
    publishRef.current()
    const unsubscribeRendered = router.subscribe("onRendered", () => {
      publishRef.current()
    })
    const unsubscribeLoad = router.subscribe("onLoad", () => {
      publishRef.current()
    })
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
    organizations,
    orgsPending,
    session,
  ])

  return null
}
