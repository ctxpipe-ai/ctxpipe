import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineMain } from "@storybook/react-vite/node"

const useSyncExternalStoreWithSelectorShim = fileURLToPath(
  new URL("./shims/use-sync-external-store-with-selector.ts", import.meta.url),
)

/** Single ESM entry so Vite/prebundles cannot load two copies (breaks RouterProvider context). */
const tanstackReactRouterEsm = fileURLToPath(
  new URL(
    "../node_modules/@tanstack/react-router/dist/esm/index.js",
    import.meta.url,
  ),
)
import tailwindcss from "@tailwindcss/vite"
import { tanstackStartPlugin } from "storybook-addon-tanstack-start/plugin"
import type { Plugin, PluginOption } from "vite"
import { mergeConfig } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

const __dirname = dirname(fileURLToPath(import.meta.url))

const cosmographStyleAlias = resolve(
  __dirname,
  "../src/cosmograph/style.module.css",
)

function getAbsolutePath(value: string) {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)))
}

/** Storybook merges `vite.config.ts`, which registers TanStack Start/Nitro/router-generator — incompatible with the Start Storybook stub. */
function stripTanStackAppPlugins(
  plugins: PluginOption[] | undefined,
): PluginOption[] {
  const flat = (plugins ?? []).flat(Infinity).filter(Boolean) as PluginOption[]
  return flat.filter((p) => {
    const name =
      typeof p === "object" &&
      p !== null &&
      "name" in p &&
      typeof (p as Plugin).name === "string"
        ? (p as Plugin).name
        : ""
    if (name.includes("tanstack-react-start")) return false
    if (name.includes("tanstack-start-core")) return false
    if (name.startsWith("tanstack-start:")) return false
    if (name.includes("tanstack-nitro")) return false
    if (name.includes("@tanstack/devtools")) return false
    if (name === "tanstack:router-generator") return false
    if (name.includes("tanstack-router:code-splitter")) return false
    if (name.includes("tanstack-router:autoimport")) return false
    if (name.includes("tanstack-start:route-tree")) return false
    return true
  })
}

export default defineMain({
  stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  addons: [
    getAbsolutePath("@storybook/addon-a11y"),
    getAbsolutePath("@storybook/addon-docs"),
  ],
  framework: getAbsolutePath("@storybook/react-vite"),
  // No usage events: `storybook tools` and the build then make no outbound
  // request, so an agent runs them in its sandbox.
  core: { disableTelemetry: true },
  async viteFinal(viteConfig) {
    const withoutTanStackApp = {
      ...viteConfig,
      plugins: stripTanStackAppPlugins(viteConfig.plugins as PluginOption[]),
    }
    // Vite keeps its default public dir (`public/`). Vite serves it in dev,
    // and the builder copies it into a build. Vite also writes CSS
    // `url("/fonts/...")` relative to the base "./", so a build under any
    // path prefix loads the fonts.
    return mergeConfig(withoutTanStackApp, {
      server: {
        allowedHosts: true,
        host: true,
      },
      build: {
        // The check runner maps the browser coverage of each story to source
        // lines with these maps (scripts/checks/README.md). "hidden" writes
        // the files but no sourceMappingURL comment.
        sourcemap: "hidden",
      },
      resolve: {
        dedupe: [
          "react",
          "react-dom",
          "use-sync-external-store",
          "@tanstack/react-router",
        ],
        alias: {
          "@/cosmograph/style.module.css": cosmographStyleAlias,
          "@tanstack/react-router": tanstackReactRouterEsm,
          "use-sync-external-store/shim/with-selector":
            useSyncExternalStoreWithSelectorShim,
        },
      },
      optimizeDeps: {
        /** Pre-bundled `@tanstack/react-router` ignores `resolve.alias` and loads a second copy → broken RouterProvider context. */
        exclude: ["@tanstack/react-router"],
        include: ["better-auth/react", "better-auth/client"],
        rolldownOptions: {
          resolve: {
            alias: {
              "@/cosmograph/style.module.css": cosmographStyleAlias,
              "@tanstack/react-router": tanstackReactRouterEsm,
              "use-sync-external-store/shim/with-selector":
                useSyncExternalStoreWithSelectorShim,
            },
          },
        },
      },
      plugins: [
        tanstackStartPlugin(),
        tsconfigPaths({ projects: ["./tsconfig.json"] }),
        tailwindcss(),
      ],
    })
  },
})
