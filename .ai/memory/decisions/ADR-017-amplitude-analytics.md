# ADR-017: Amplitude analytics (UI + backend)

**Status:** Accepted | **Date:** 2026-04-08 | **Tags:** analytics, amplitude, ui, backend, mcp, observability

## Context

We need product analytics with **user identity** on UI and backend, **resilience to ad blockers**, and **self-hosted** deployments where operators run **prebuilt** images without rebuilding for analytics keys. `VITE_PUBLIC_*` is inlined at UI build time and is a poor fit for optional operator-supplied Amplitude configuration.

## Decision

1. **Browser SDK** (`@amplitude/analytics-browser`): **Runtime config** from **`process.env`** is read in the **root route loader** via **`getAmplitudeRuntimeConfig()`** (server-side in SSR; no **`useEffect` + `fetch`** for bootstrap). **`GET /api/v1/c/s`** returns the same JSON for operators and parity. No `VITE_PUBLIC_AMPLITUDE_*` for Amplitude.

2. **Same-origin ingest proxy:** Browser SDK **`serverUrl`** points at **`/.amp/events`** (dot-route style, same family as `/.auth/*`; **not** `/amplitude/`). A TanStack Start **server route** forwards **POST** bodies to Amplitude’s **`/2/httpapi`** on `api2.amplitude.com` vs EU, selected by **`AMPLITUDE_REGION`** (`us` default, `eu` supported). The **`/2/httpapi`** segment is **only** on the server-side forward, not in the browser URL.

3. **Single project key:** **`AMPLITUDE_API_KEY`** is the Amplitude **project** API key, set on **both** backend and UI (same value) for Browser SDK + **server** (`@amplitude/analytics-node`) MCP events.

4. **Backend MCP:** Track tool invocations at handler entry with **`user_id`**, org properties, and tool name; **non-blocking** (failures must not break MCP).

5. **Page views:** Use Browser SDK **autocapture** defaults (`autocapture.pageViews`), **not** a custom TanStack Router `track` loop.

6. **Identity:** **`setUserId`** from Better Auth session when present; align session-gated **`init`** with product rules in code comments.

## Consequences

- Operators configure Amplitude via **runtime env** (Compose / Railway / Terraform); self-hosters need not rebuild the UI image for keys or region.
- The project API key is **exposed to the browser** (via runtime config); same threat model as a bundled public key.
- **Terraform** wires **`AMPLITUDE_API_KEY`** and **`AMPLITUDE_REGION`** to backend, worker, and UI services.

## Alternatives Considered

- **`VITE_PUBLIC_AMPLITUDE_*` only** — Rejected for self-host story (requires image rebuild to change keys).
- **Separate browser vs server Amplitude keys** — Rejected; one project key suffices for event ingestion.
- **Client `useEffect` + `fetch` for runtime config** — Rejected; use the root **loader** calling **`getAmplitudeRuntimeConfig()`** so config is serialized with SSR. Aligns with UI patterns: prefer **`useQuery`** for typical API/server data; **route loaders** for rare **UI-server runtime** config like this.
- **Loader-only injection without any `GET` endpoint** — Rejected; keep **`GET /api/v1/c/s`** as an explicit operator-facing contract and debugging surface.

## Notes

- Env documentation: `apps/backend/.env.example`, `docker-compose.env.example`, AGENTS pointers.
- Patterns: see `.ai/memory/patterns.md` (UI section) for session learnings.
