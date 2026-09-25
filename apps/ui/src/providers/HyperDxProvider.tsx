import HyperDX from "@hyperdx/browser"
import { useRouter } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  deepestRouteId,
  hyperdxExporterIgnoreUrls,
  hyperdxGlobalAttributes,
  hyperdxPageViewAttributes,
  orgSlugFromPathname,
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
 */
export const HyperDxProvider: FC<{
  children: ReactNode
  runtimeConfig: HyperDxRuntimeConfig
}> = ({ children, runtimeConfig }) => {
  const router = useRouter({ warn: false })
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations, isPending: organizationsPending } =
    useListOrganizations()
  const userId = session?.user?.id
  const lastPath = useRef<string | undefined>(undefined)

  const pathname = router?.state?.location.pathname
  const orgSlugFromPath = pathname ? orgSlugFromPathname(pathname) : ""
  const activeOrg =
    orgSlugFromPath && organizations
      ? organizations.find((o) => o.slug === orgSlugFromPath)
      : undefined

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!runtimeConfig.enabled) return
    if (!router?.state) return

    const origin = window.location.origin
    const url = runtimeConfig.url.startsWith("http")
      ? runtimeConfig.url
      : `${origin}${runtimeConfig.url}`

    if (!hyperdxInitialized) {
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

    const trackPageView = (path: string) => {
      if (lastPath.current === path) return
      lastPath.current = path
      HyperDX.addAction(
        "page_view",
        hyperdxPageViewAttributes({
          path,
          routeId: deepestRouteId(router.state.matches),
          orgSlug: orgSlugFromPathname(path),
        }),
      )
    }

    trackPageView(router.state.location.pathname)
    const unsub = router.subscribe("onResolved", ({ toLocation }) => {
      trackPageView(toLocation.pathname)
    })
    return () => {
      unsub()
    }
  }, [runtimeConfig, router])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!runtimeConfig.enabled || !hyperdxInitialized) return
    if (sessionPending) return
    if (!userId) {
      clearHyperDxGlobalAttributes()
      return
    }
    if (organizationsPending) return
    setHyperDxGlobalAttributes(
      hyperdxGlobalAttributes({
        userId,
        teamId: activeOrg?.id,
        teamName: activeOrg?.slug,
      }),
    )
  }, [
    runtimeConfig.enabled,
    sessionPending,
    organizationsPending,
    userId,
    activeOrg?.id,
    activeOrg?.slug,
  ])

  return children
}
