// Type tests of the story parameters (.storybook/parameters-addon.ts). The
// typecheck of apps/ui reads this file, and nothing runs it. Each
// `@ts-expect-error` line must give a type error: if the addon stops typing
// the parameters of a CSF 4 story file, the directive is unused and the
// typecheck fails.

import preview from "../../.storybook/preview"
import { Switch } from "../components/ui/Switch"

const meta = preview.meta({ component: Switch })

export const storyParameterTypes = [
  meta.story({
    parameters: {
      review: { kind: "page" },
      app: "org",
      route: "/$orgSlug/connectors",
      storyRoute: { pattern: "orgConnectors", orgSlug: "acme" },
      queryClient: true,
      msw: { handlers: { page: [] } },
      visual: { viewports: ["desktop"], allow: { contrast: "A reason." } },
    },
  }),
  // @ts-expect-error The kind is "page" or "component".
  meta.story({ parameters: { review: { kind: "dialog" } } }),
  // @ts-expect-error The app is "root" or "org".
  meta.story({ parameters: { app: "orgg" } }),
  // @ts-expect-error The route is a TanStack route id.
  meta.story({ parameters: { route: "/$orgSlug/connector" } }),
  // @ts-expect-error A viewport is "desktop" or "mobile".
  meta.story({ parameters: { visual: { viewports: ["tablet"] } } }),
  // @ts-expect-error The orgIndex pattern needs an orgSlug.
  meta.story({ parameters: { storyRoute: { pattern: "orgIndex" } } }),
  // @ts-expect-error queryClient is a boolean.
  meta.story({ parameters: { queryClient: "yes" } }),
  // @ts-expect-error The msw handlers are a list or { handlers }.
  meta.story({ parameters: { msw: { page: [] } } }),
]
