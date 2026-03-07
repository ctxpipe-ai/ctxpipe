# ADR-001: Frontend UI app stack

**Status:** Accepted | **Date:** 2026-02-22 | **Tags:** stack, ui, tanstack

## Context

`ctxpipe` did not have a frontend application in the monorepo. We needed a new UI app with a modern React stack, utility-first styling, accessible UI primitives, and baseline UI quality tooling.

The requested direction was:

- A new app named `ui`
- Official TanStack Start template
- React Aria components installed via shadcn registry
- Tailwind-based styling
- Geist + Geist Mono typography
- Teal primary palette and zinc grayscale
- Storybook and Vitest included from the start

## Decision

Create `apps/ui` with TanStack Start (React + Vite) as the frontend runtime and routing framework.

Use Tailwind CSS v4 for styling with global theme tokens in `apps/ui/src/styles.css`, including:

- `Geist` and `Geist Mono` as font families
- `primary` color scale mapped to Tailwind teal
- grayscale driven by Tailwind zinc usage

Adopt React Aria as the component primitive layer via:

- `pnpm dlx shadcn@latest add @react-aria/tailwind`
- Generated React Aria component files under `apps/ui/src/components/ui`

Adopt baseline UI quality tooling in `apps/ui`:

- Storybook for component exploration/documentation
- Vitest + Testing Library for component tests

## Consequences

- Frontend development now has a dedicated app with consistent routing and styling foundations.
- Accessibility-oriented component primitives are available early through React Aria.
- Storybook and Vitest provide an immediate workflow for iterative UI work and testing.
- Monorepo complexity increases (new app wiring in TypeScript references, compose service, and docs).
- Generated React Aria component surface is broad; teams should curate usage patterns over time.

## Alternatives Considered

- Next.js app: rejected to keep alignment with requested TanStack Start stack.
- Vite React SPA without TanStack Start: rejected to preserve full-stack routing/runtime capabilities from the selected template.
- Radix-based standard shadcn components: rejected because requirement was React Aria setup via the `@react-aria` registry.

## Notes

- UI dev service is available in docker-compose on port `3002`.
- Keep `apps/ui` route scope minimal until product pages are explicitly requested.
