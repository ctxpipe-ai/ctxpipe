import { startServerTelemetry } from "./serverTelemetry"

/**
 * Nitro runs its plugins before Bun.serve takes the first request, and the
 * SSR bundle loads only on that request. `vite dev` runs no Nitro plugin, so
 * the dev server sends no server telemetry.
 */
export default function serverTelemetryNitroPlugin(): void {
  startServerTelemetry()
}
