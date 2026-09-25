import HyperDX from "@hyperdx/browser"
import { useRouter } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  type HyperDxPageViewAttributes,
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
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"

let hyperdxInitialized = false

type RouterWithStore = {
  state: {
    location: { pathname: string }
    matches: readonly {
      routeId: string
      pathname: string
      params: { orgSlug?: unknown }
    }[]
  }
  __store: {
    subscribe: (listener: () => void) => { unsubscribe: () => void }
  }
}

/**
 * Runtime config comes from the root route loader (SSR), not client fetch.
 * `useEffect` syncs the HyperDX OTEL SDK (external system) — not data loading.
 *
 * The provider lives in the root shell. Client navigations update the router
 * store without re-rendering that shell, so `useRouterState` in render never
 * sees them. Subscribe to the store directly.
 */
export const HyperDxProvider: FC<{
  children: ReactNode
  runtimeConfig: HyperDxRuntimeConfig
}> = ({ children, runtimeConfig }) => {
  const router = useRouter({ warn: false }) as RouterWithStore | undefined
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations } = useListOrganizations()
  const userId = session?.user?.id
  const lastPath = useRef<string | undefined>(undefined)
  const identityRef = useRef({
    sessionPending: true,
    userId: undefined as string | undefined,
    organizations: undefined as { id: string; slug: string }[] | undefined,
    activeOrganizationId: "",
  })
  identityRef.current = {
    sessionPending,
    userId,
    organizations,
    activeOrganizationId: readActiveOrganizationId(session?.session),
  }
  const routerRef = useRef(router)
  routerRef.current = router

  const publish = () => {
    const current = routerRef.current
    if (!runtimeConfig.enabled || !current?.state || !hyperdxInitialized) return
    const pathname = current.state.location.pathname
    const matches = current.state.matches.map((match) => ({
      routeId: match.routeId,
      pathname: match.pathname,
      params: match.params,
    }))
    if (!routerLocationMatchesResolved(pathname, matches)) return
    const attrs: HyperDxPageViewAttributes = hyperdxPageViewFromMatches({
      pathname,
      matches,
    })
    const identity = identityRef.current
    if (!identity.sessionPending) {
      if (!identity.userId) {
        clearHyperDxGlobalAttributes()
      } else {
        const team = resolveHyperDxTeam({
          orgSlugFromRoute: attrs["ctxpipe.org.slug"],
          organizations: identity.organizations,
          activeOrganizationId: identity.activeOrganizationId,
        })
        setHyperDxGlobalAttributes(
          hyperdxGlobalAttributes({
            userId: identity.userId,
            teamId: team.teamId,
            teamName: team.teamName,
          }),
        )
      }
    }
    if (lastPath.current === attrs.path) return
    lastPath.current = attrs.path
    HyperDX.addAction("page_view", attrs)
  }
  const publishRef = useRef(publish)
  publishRef.current = publish

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!runtimeConfig.enabled || !router?.__store) return

    if (!hyperdxInitialized) {
      const origin = window.location.origin
      const url = runtimeConfig.url.startsWith("http")
        ? runtimeConfig.url
        : `${origin}${runtimeConfig.url}`
      HyperDX.init({
        url,
        apiKey: runtimeConfig.apiKey ?? "",
        service: "ui",
        tracePropagationTargets: [window.location.origin],
        // SDK does not exclude its own OTLP url; keep exporter requests untraced.
        ignoreUrls: hyperdxExporterIgnoreUrls,
        consoleCapture: true,
        advancedNetworkCapture: false,
        disableReplay: true,
        // document-load, post-load resource timing, and web vitals are SDK
        // defaults (disable: false / webvitals !== false). Set explicitly.
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

    const run = () => {
      publishRef.current()
    }
    run()
    const subscription = router.__store.subscribe(run)
    return () => {
      subscription.unsubscribe()
    }
  }, [runtimeConfig, router])

  useEffect(() => {
    identityRef.current = {
      sessionPending,
      userId,
      organizations,
      activeOrganizationId: readActiveOrganizationId(session?.session),
    }
    publishRef.current()
  }, [sessionPending, userId, organizations, session])

  return children
}
