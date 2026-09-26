import HyperDX from "@hyperdx/browser"
import {
  type HyperDxSessionIdentity,
  hyperdxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import type { HyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"

/**
 * `@hyperdx/browser` init does not forward `globalAttributes` to otel-web.
 * Identity is applied with `setGlobalAttributes` in the same init call.
 * `setGlobalAttributes` Object.assigns, so a changed set is cleared with
 * `null` first (that deletes every key on the processor).
 */
let hyperdxInitialized = false
let publishedGlobalAttributes = ""

export function initHyperDxBrowser(
  runtimeConfig: HyperDxRuntimeConfig,
  identity: HyperDxSessionIdentity | null,
): void {
  if (typeof window === "undefined" || !runtimeConfig.enabled) return
  if (!hyperdxInitialized) {
    const otelResourceAttributes: Record<string, string> = {
      "service.namespace": "ctxpipe",
    }
    if (runtimeConfig.environment) {
      otelResourceAttributes["deployment.environment"] =
        runtimeConfig.environment
    }
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
      otelResourceAttributes,
    })
    hyperdxInitialized = true
  }
  if (identity?.userId) setHyperDxGlobalAttributes(identity)
}

export function setHyperDxGlobalAttributes(
  attributes: HyperDxSessionIdentity,
): void {
  const next = hyperdxGlobalAttributes(attributes)
  const serialized = JSON.stringify(next)
  if (publishedGlobalAttributes === serialized) return
  if (publishedGlobalAttributes.length > 0) {
    HyperDX.setGlobalAttributes(null as unknown as Record<string, string>)
  }
  HyperDX.setGlobalAttributes(next)
  publishedGlobalAttributes = serialized
}

export function clearHyperDxGlobalAttributes(): void {
  HyperDX.setGlobalAttributes(null as unknown as Record<string, string>)
  publishedGlobalAttributes = ""
}

/** No-ops until `HyperDX.init` has run (`@hyperdx/otel-web` checks `inited`). */
export function recordHyperDxAction(
  name: string,
  attributes?: Record<string, string>,
): void {
  HyperDX.addAction(name, attributes)
}
