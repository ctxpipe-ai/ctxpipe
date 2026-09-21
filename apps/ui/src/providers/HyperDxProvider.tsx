import HyperDX from "@hyperdx/browser"
import { useRouter } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
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
  const { data: session } = useSession()
  const { data: organizations } = useListOrganizations()
  const userId = session?.user?.id
  const lastPath = useRef<string | undefined>(undefined)

  const pathname = router?.state?.location.pathname
  const firstSegment = pathname?.split("/").filter(Boolean)[0]
  const orgSlugFromPath =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined
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
        consoleCapture: false,
        advancedNetworkCapture: false,
        disableReplay: true,
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
      HyperDX.addAction("page_view", { path })
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
    if (!runtimeConfig.enabled || !hyperdxInitialized) return
    HyperDX.setGlobalAttributes({
      userId: userId ?? "",
      teamName: activeOrg?.slug ?? "",
    })
  }, [runtimeConfig.enabled, userId, activeOrg?.slug])

  return children
}
