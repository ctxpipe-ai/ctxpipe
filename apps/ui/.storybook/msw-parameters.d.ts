import type { HttpHandler, RequestHandler } from "msw"

/** MSW `http.*` returns `HttpHandler`; tests/stories use it alongside `RequestHandler`. */
type MswHandlers = RequestHandler | HttpHandler

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
