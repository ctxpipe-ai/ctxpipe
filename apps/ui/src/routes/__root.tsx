import { TanStackDevtools } from "@tanstack/react-devtools"
import {
  createRootRoute,
  type ErrorComponentProps,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { type ReactNode, useEffect } from "react"
import { Toaster } from "sonner"
import { getConfluenceForgeRuntimeConfig } from "@/lib/confluenceForgeRuntimeConfig"
import { recordHyperDxException } from "@/lib/hyperdxBrowser"
import { getHyperDxRuntimeConfig } from "@/lib/hyperdxRuntimeConfig"
import { Providers } from "@/providers"
import { HyperDxPageView } from "@/providers/HyperDxProvider"

import appCss from "../styles.css?url"

export const Route = createRootRoute({
  loader: () => ({
    hyperdxRuntimeConfig: getHyperDxRuntimeConfig(),
    confluenceForgeRuntimeConfig: getConfluenceForgeRuntimeConfig(),
  }),
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
  component: RootComponent,
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

function RootComponent() {
  const { hyperdxRuntimeConfig } = Route.useLoaderData()
  return (
    <>
      <HyperDxPageView runtimeConfig={hyperdxRuntimeConfig} />
      <Outlet />
    </>
  )
}

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  useEffect(() => {
    recordHyperDxException(error)
  }, [error])

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
  const { hyperdxRuntimeConfig, confluenceForgeRuntimeConfig } =
    Route.useLoaderData()
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers
          hyperdxRuntimeConfig={hyperdxRuntimeConfig}
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
