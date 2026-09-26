import HyperDX from "@hyperdx/browser"
import {
  type HyperDxSessionIdentity,
  hyperdxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"

/**
 * `@hyperdx/browser` init does not forward `globalAttributes` to otel-web.
 * Identity is applied with `setGlobalAttributes` in the same init call.
 */
let hyperdxInitialized = false

export function initHyperDxBrowser(
  runtimeConfig: HyperDxRuntimeConfig,
  identity: HyperDxSessionIdentity | null,
): void {
  if (typeof window === "undefined" || !runtimeConfig.enabled) return
  if (!hyperdxInitialized) {
    HyperDX.init({
      url: `${window.location.origin}/.otel`,
      apiKey: "proxy",
      service: "ui",
      // Strings in `ignoreUrls` are exact matches. This regex covers `/.otel` and `/.otel/...`.
      ignoreUrls: [/\/\.otel(?:\/|$)/],
      consoleCapture: true,
      advancedNetworkCapture: false,
      disableReplay: true,
      disableIntercom: true,
      // `interactions: false` is how this SDK turns click spans off.
      // Do not set `fetch` or `xhr` here; the SDK spreads this object over
      // the instrumentation that already sends traceparent on same-origin calls.
      instrumentations: {
        document: true,
        postload: true,
        webvitals: true,
        errors: true,
        interactions: false,
        longtask: false,
      },
    })
    hyperdxInitialized = true
  }
  if (identity?.userId) setHyperDxGlobalAttributes(identity)
}

export function setHyperDxGlobalAttributes(
  attributes: HyperDxSessionIdentity,
): void {
  HyperDX.setGlobalAttributes(hyperdxGlobalAttributes(attributes))
}

export function clearHyperDxGlobalAttributes(): void {
  setHyperDxGlobalAttributes({ userId: "", teamId: "", teamName: "" })
}
