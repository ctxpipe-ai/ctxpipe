import * as amplitude from "@amplitude/analytics-browser"
import { Identify } from "@amplitude/analytics-browser"
import { useRouter } from "@tanstack/react-router"
import type { FC, ReactNode } from "react"
import { useEffect, useRef } from "react"
import { AMPLITUDE_INGEST_PATH } from "@/lib/amplitudeConfig"
import type { AmplitudeRuntimeConfig } from "@/lib/amplitudeRuntimeConfig"
import { useListOrganizations, useSession } from "@/lib/auth-client"

/**
 * Runtime config comes from the root route loader (SSR), not client fetch.
 * **`runtimeConfig.enabled === false`** (no `AMPLITUDE_API_KEY` on the UI server): we **never**
 * call `amplitude.init` — **no product analytics / telemetry to Amplitude** (default).
 * `useEffect` only runs Browser SDK init + identity/group sync — not data loading.
 *
 * **Org slicing:** `setGroup('org', orgId)` + `groupIdentify` with `slug` — same `org` group type
 * as backend MCP events (`observability/amplitude.ts`).
 */
export const AmplitudeProvider: FC<{
  children: ReactNode
  runtimeConfig: AmplitudeRuntimeConfig
}> = ({ children, runtimeConfig }) => {
  const router = useRouter({ warn: false })
  const { data: session } = useSession()
  const { data: organizations } = useListOrganizations()
  const userId = session?.user?.id

  const pathname = router.state?.location.pathname
  const firstSegment = pathname?.split("/").filter(Boolean)[0]
  const orgSlugFromPath =
    firstSegment && !firstSegment.startsWith(".") ? firstSegment : undefined
  const activeOrg =
    orgSlugFromPath && organizations
      ? organizations.find(
          (o: { slug: string; id: string }) => o.slug === orgSlugFromPath,
        )
      : undefined

  const initialized = useRef(false)

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!router?.state) return

    if (!userId) {
      initialized.current = false
      return
    }

    // No API key → no SDK → nothing sent to Amplitude (see `amplitudeRuntimeConfig.ts`).
    if (!runtimeConfig.enabled || !runtimeConfig.apiKey) return

    if (!initialized.current) {
      const origin = window.location.origin
      amplitude.init(runtimeConfig.apiKey, {
        serverUrl: `${origin}${AMPLITUDE_INGEST_PATH}`,
        serverZone: runtimeConfig.region === "eu" ? "EU" : "US",
        remoteConfig: {
          fetchRemoteConfig: false,
        },
      })
      initialized.current = true
    }

    amplitude.setUserId(userId)

    if (activeOrg?.id) {
      amplitude.setGroup("org", activeOrg.id)
      const groupProps = new Identify()
      groupProps.set("slug", activeOrg.slug)
      void amplitude.groupIdentify("org", activeOrg.id, groupProps)
    }
  }, [
    userId,
    runtimeConfig,
    activeOrg?.id,
    activeOrg?.slug,
    router?.state,
  ])

  return children
}
