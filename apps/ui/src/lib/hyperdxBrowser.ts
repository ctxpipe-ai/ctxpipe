import HyperDX from "@hyperdx/browser"
import { trace } from "@opentelemetry/api"
import {
  type HyperDxSessionIdentity,
  hyperdxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import {
  findBatchSpanProcessor,
  flushSpansOnPageHide,
} from "@/lib/hyperdxPageHideFlush"
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
  // `HyperDX.init` registers its tracer provider as the global provider.
  const processor = findBatchSpanProcessor(trace.getTracerProvider())
  if (processor) flushSpansOnPageHide(processor, window, document)
  if (identity?.userId) setHyperDxGlobalAttributes(identity)
}

/**
 * An access-denied or not-found screen makes no failing request, so this
 * error span is its only signal. `HyperDxProvider` inits the SDK in render,
 * before any child effect calls this.
 */
export function recordHyperDxScreenError(
  screen: string,
  where: { route: string; path: string },
): void {
  HyperDX.recordException(new Error(`UI screen: ${screen}`), {
    "ctxpipe.ui.source": "screen",
    "ctxpipe.ui.screen": screen,
    route: where.route,
    "url.path": where.path,
  })
}

/**
 * A user action that failed without a failing request (a copy that the
 * browser refused). Pass ids and names only: never the value the user copied.
 */
export function recordHyperDxActionError(
  action: string,
  attributes: Record<string, string> = {},
): void {
  HyperDX.recordException(new Error(`UI action failed: ${action}`), {
    ...attributes,
    "ctxpipe.ui.source": "action",
    "ctxpipe.ui.action": action,
  })
}

export function setHyperDxGlobalAttributes(
  attributes: HyperDxSessionIdentity,
): void {
  HyperDX.setGlobalAttributes(hyperdxGlobalAttributes(attributes))
}

export function clearHyperDxGlobalAttributes(): void {
  setHyperDxGlobalAttributes({ userId: "", teamId: "", teamName: "" })
}
