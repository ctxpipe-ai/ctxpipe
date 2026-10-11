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
/** Screen errors from before init. The SDK drops a record before init. */
let pendingScreenErrors: Array<() => void> = []

export function initHyperDxBrowser(
  runtimeConfig: HyperDxRuntimeConfig,
  identity: HyperDxSessionIdentity | null,
): void {
  if (typeof window === "undefined" || !runtimeConfig.enabled) return
  if (hyperdxInitialized) return
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
  if (identity?.userId) setHyperDxGlobalAttributes(identity)
  const pending = pendingScreenErrors
  pendingScreenErrors = []
  for (const record of pending) record()
}

/**
 * An access-denied or not-found screen makes no failing request, so this
 * error span is its only signal. A child effect runs before the provider can
 * init the SDK, so a record before init waits for init.
 */
export function recordHyperDxScreenError(
  screen: string,
  where: { route: string; path: string },
): void {
  const record = () =>
    HyperDX.recordException(new Error(`UI screen: ${screen}`), {
      "ctxpipe.ui.source": "screen",
      "ctxpipe.ui.screen": screen,
      route: where.route,
      "url.path": where.path,
    })
  if (hyperdxInitialized) record()
  else if (pendingScreenErrors.length < 10) pendingScreenErrors.push(record)
}

export function setHyperDxGlobalAttributes(
  attributes: HyperDxSessionIdentity,
): void {
  HyperDX.setGlobalAttributes(hyperdxGlobalAttributes(attributes))
}

export function clearHyperDxGlobalAttributes(): void {
  setHyperDxGlobalAttributes({ userId: "", teamId: "", teamName: "" })
}
