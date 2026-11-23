import { context, propagation, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import type { TracerProvider } from "@opentelemetry/sdk-trace"

/**
 * Make `provider` the global tracer provider, with an AsyncLocalStorage context
 * manager and the W3C trace-context and baggage propagators: what
 * `NodeTracerProvider#register()` did before OpenTelemetry JS SDK 3, which
 * removed that class. `propagator: false` keeps the global propagator.
 */
export function registerTracerProvider(
  provider: TracerProvider,
  options: { propagator?: boolean } = {},
): void {
  trace.setGlobalTracerProvider(provider)
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  )
  if (options.propagator === false) return
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  )
}
