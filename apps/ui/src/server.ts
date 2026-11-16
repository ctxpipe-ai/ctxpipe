import handler, { createServerEntry } from "@tanstack/react-start/server-entry"

import { traceServerRequest } from "@/lib/serverTelemetry"

export default createServerEntry({
  fetch: (request, opts) =>
    traceServerRequest(request, async () => handler.fetch(request, opts)),
})
