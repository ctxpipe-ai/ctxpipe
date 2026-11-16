import type { HttpHandler, RequestHandler, WebSocketHandler } from "msw"

/**
 * MSW `http.*` returns `HttpHandler` and `ws.link(...).addEventListener`
 * returns `WebSocketHandler`; tests/stories use them alongside `RequestHandler`.
 */
type MswHandlers = RequestHandler | HttpHandler | WebSocketHandler

type MswParameter =
  | MswHandlers[]
  | {
      handlers: MswHandlers[] | Record<string, MswHandlers | MswHandlers[]>
    }

// The opt-in parameters of the decorators of `preview.tsx`. Without its
// parameter, a decorator does nothing. `storyRoute` has its type in
// `decorators/with-story-route.tsx`.
type OptInParameters = {
  /** The providers of the app (`"root"`), and also the org `AppShell` (`"org"`). */
  app?: "root" | "org"
  /** A new Query client for the story. */
  queryClient?: boolean
}

declare module "@storybook/react-vite" {
  interface Parameters extends OptInParameters {
    msw?: MswParameter
  }
}

declare module "@storybook/react" {
  interface Parameters extends OptInParameters {
    msw?: MswParameter
  }
}
