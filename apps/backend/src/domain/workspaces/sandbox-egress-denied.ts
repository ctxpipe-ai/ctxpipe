import { Hono } from "hono"

/**
 * The backend route that refuses each request a hosted ingest sandbox sends
 * to a path with no rule. The Vercel firewall has no deny rule for a path,
 * so `ingestNetworkPolicy` forwards such a request here (`forwardURL`).
 */
export const SANDBOX_EGRESS_DENIED_PATH = "/api/v1/sandbox-egress/denied"

export const sandboxEgressDeniedRoutes = new Hono()
  .all(SANDBOX_EGRESS_DENIED_PATH, (c) =>
    c.json({ error: "Sandbox egress denied" }, 403),
  )
  .all(`${SANDBOX_EGRESS_DENIED_PATH}/*`, (c) =>
    c.json({ error: "Sandbox egress denied" }, 403),
  )
