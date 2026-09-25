import HyperDX from "@hyperdx/browser"
import { useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewFromMatches,
  readActiveOrganizationId,
  resolveHyperDxTeam,
} from "@/lib/hyperdxAttributes"
import {
  clearHyperDxGlobalAttributes,
  setHyperDxGlobalAttributes,
} from "@/lib/hyperdxBrowser"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"

let hyperdxInitialized = false

/**
 * Runtime config comes from the root route loader (SSR), not client fetch.
 * `useEffect` syncs the HyperDX OTEL SDK (external system) — not data loading.
 *
 * `router.subscribe('onResolved')` does not run for client navigations that
 * never enter a pending load (`Transitioner` emits it only when pending
 * clears). `useRouterState` follows the same location updates as the SDK's
 * `routeChange` spans.
 */
export const HyperDxProvider: FC<{
  children: ReactNode
  runtimeConfig: HyperDxRuntimeConfig
}> = ({ children, runtimeConfig }) => {
  const navigation = useRouterState({
    select: (state) =>
      hyperdxPageViewFromMatches({
        pathname: state.location.pathname,
        matches: state.matches.map((match) => ({
          routeId: match.routeId,
          params: match.params as { orgSlug?: unknown },
        })),
      }),
  })
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations } = useListOrganizations()
  const userId = session?.user?.id
  const lastPath = useRef<string | undefined>(undefined)
  const team = resolveHyperDxTeam({
    orgSlugFromRoute: navigation["ctxpipe.org.slug"],
    organizations,
    activeOrganizationId: readActiveOrganizationId(session?.session),
  })

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!runtimeConfig.enabled) return
    if (hyperdxInitialized) return

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
  }, [runtimeConfig])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!runtimeConfig.enabled || !hyperdxInitialized) return
    if (sessionPending) return
    if (!userId) {
      clearHyperDxGlobalAttributes()
      return
    }
    setHyperDxGlobalAttributes(
      hyperdxGlobalAttributes({
        userId,
        teamId: team.teamId,
        teamName: team.teamName,
      }),
    )
  }, [
    runtimeConfig.enabled,
    sessionPending,
    userId,
    team.teamId,
    team.teamName,
  ])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!runtimeConfig.enabled || !hyperdxInitialized) return
    if (lastPath.current === navigation.path) return
    lastPath.current = navigation.path
    HyperDX.addAction("page_view", navigation)
  }, [runtimeConfig.enabled, navigation])

  return children
}
