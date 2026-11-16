import type { HttpHandler, RequestHandler, WebSocketHandler } from "msw"

/**
 * MSW `http.*` returns `HttpHandler` and `ws.link(...).addEventListener`
 * returns `WebSocketHandler`; tests/stories use them alongside `RequestHandler`.
 */
type MswHandlers = RequestHandler | HttpHandler | WebSocketHandler

declare module "@storybook/react-vite" {
  interface Parameters {
    msw?:
      | MswHandlers[]
      | {
          handlers: MswHandlers[] | Record<string, MswHandlers | MswHandlers[]>
        }
  }
}

declare module "@storybook/react" {
  interface Parameters {
    msw?:
      | MswHandlers[]
      | {
          handlers: MswHandlers[] | Record<string, MswHandlers | MswHandlers[]>
        }
  }
}
