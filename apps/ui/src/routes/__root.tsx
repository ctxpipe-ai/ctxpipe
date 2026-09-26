import HyperDX from "@hyperdx/browser"
import { TanStackDevtools } from "@tanstack/react-devtools"
import {
  createRootRoute,
  type ErrorComponentProps,
  HeadContent,
  Scripts,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import { getConfluenceForgeRuntimeConfig } from "@/lib/confluenceForgeRuntimeConfig"
import { getHyperDxDocumentContext } from "@/lib/hyperdxRuntimeConfig"
import { Providers } from "@/providers"

import appCss from "../styles.css?url"

export const Route = createRootRoute({
  // Client navigations keep the document identity. `router.invalidate()` still
  // enters the loader; the client half returns undefined and the previous data stays.
  shouldReload: false,
  loader: async ({ location }) => {
    const hyperdx = await getHyperDxDocumentContext(location.pathname)
    if (!hyperdx) return undefined
    return {
      hyperdxRuntimeConfig: hyperdx.config,
      hyperdxIdentity: hyperdx.identity,
      confluenceForgeRuntimeConfig: getConfluenceForgeRuntimeConfig(),
    }
  },
  onCatch: (error) => {
    HyperDX.recordException(error)
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "ctx | The Context Layer for AI Agents" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/fonts/Geist-Variable.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/fonts/GeistPixel-Square.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
    ],
  }),
  shellComponent: RootDocument,
  errorComponent: RootErrorComponent,
  notFoundComponent: () => (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-muted-foreground">Not Found</p>
      </div>
    </main>
  ),
})

function RootErrorComponent({ reset }: ErrorComponentProps) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-muted-foreground">Something went wrong</p>
        <button
          type="button"
          className="mt-4 rounded-none border border-border px-3 py-1.5 text-sm"
          onClick={() => reset()}
        >
          Try again
        </button>
      </div>
    </main>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  const loaderData = Route.useLoaderData()
  const hyperdxRuntimeConfig = loaderData?.hyperdxRuntimeConfig ?? {
    enabled: false,
  }
  const hyperdxIdentity = loaderData?.hyperdxIdentity ?? null
  const confluenceForgeRuntimeConfig =
    loaderData?.confluenceForgeRuntimeConfig ?? {
      installUrlFallback: null,
    }
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers
          hyperdxRuntimeConfig={hyperdxRuntimeConfig}
          hyperdxIdentity={hyperdxIdentity}
          confluenceForgeRuntimeConfig={confluenceForgeRuntimeConfig}
        >
          {children}
        </Providers>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Toaster richColors position="top-center" />
        <Scripts />
      </body>
    </html>
  )
}
