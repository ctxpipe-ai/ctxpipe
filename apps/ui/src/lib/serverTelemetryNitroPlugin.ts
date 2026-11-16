import { startServerTelemetry } from "./serverTelemetry"

/**
 * Nitro runs its plugins before Bun.serve takes the first request. The SSR
 * bundle (`src/server.ts`) is a lazy Nitro handler that loads on the first
 * request, so a start at its module scope would come after the server is
 * open. `vite dev` runs no Nitro plugin, so the dev server sends no server
 * telemetry.
 */
export default function serverTelemetryNitroPlugin(): void {
  startServerTelemetry()
}
