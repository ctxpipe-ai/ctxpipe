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
  recordHyperDxScreenError,
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

  // Init in render, not in an effect: child effects and the first auth
  // fetches run before a provider effect. The call is idempotent, does nothing on the
  // server, and only patches browser globals, so it does not change the rendered markup.
  initHyperDxBrowser({ enabled }, initialIdentity)

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

/** Records one `ui` error span when a screen shows an error state (`screen` set). */
export function useHyperDxScreenError(screen: string | null): void {
  const router = useRouter()
  useEffect(() => {
    if (!screen) return
    recordHyperDxScreenError(screen, {
      route: router.state.matches.at(-1)?.routeId ?? "",
      path: router.state.location.pathname,
    })
  }, [screen, router])
}
