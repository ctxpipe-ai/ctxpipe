import HyperDX from "@hyperdx/browser"
import { useRouter, useRouterState } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect } from "react"
import { useListOrganizations, useSession } from "@/lib/auth-client"
import {
  type HyperDxSessionIdentity,
  hyperdxIdentityAfterSession,
  hyperdxPageViewAction,
} from "@/lib/hyperdxAttributes"
import {
  clearHyperDxGlobalAttributes,
  initHyperDxBrowser,
  setHyperDxGlobalAttributes,
} from "@/lib/hyperdxBrowser"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"

let recordedInitialPageView = false

/**
 * Runtime config and the first identity come from the root loader (SSR).
 * Later session and org changes update the SDK. Page views follow resolved navigations.
 */
export const HyperDxProvider: FC<{
  children: ReactNode
  runtimeConfig: HyperDxRuntimeConfig
  initialIdentity?: HyperDxSessionIdentity | null
}> = ({ children, runtimeConfig, initialIdentity = null }) => {
  const enabled = runtimeConfig.enabled
  const router = useRouter()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const { data: session, isPending: sessionPending } = useSession()
  const { data: organizations } = useListOrganizations()

  useEffect(() => {
    initHyperDxBrowser({ enabled }, initialIdentity)
  }, [enabled, initialIdentity])

  useEffect(() => {
    if (!enabled || sessionPending) return
    const identity = hyperdxIdentityAfterSession({
      session: session ?? null,
      organizations,
      pathname,
      documentIdentity: initialIdentity,
    })
    if (identity === undefined) return
    if (identity) setHyperDxGlobalAttributes(identity)
    else clearHyperDxGlobalAttributes()
  }, [
    enabled,
    pathname,
    sessionPending,
    session,
    organizations,
    initialIdentity,
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
