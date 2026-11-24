/// <reference types="vitest/config" />
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** `@cosmograph/cosmograph` source imports `@/cosmograph/style.module.css` with its own
 * `@/` alias; point that at our local stub so both vite bundling and the
 * Rolldown dependency optimizer (pre-bundle) resolve it. */
const cosmographStyleAlias = resolve(
  __dirname,
  "src/cosmograph/style.module.css",
)

const config = defineConfig({
  resolve: {
    alias: [
      {
        find: "@/cosmograph/style.module.css",
        replacement: cosmographStyleAlias,
      },
      // `gl-bench` (a dependency of `@cosmos.gl/graph`) names a script that sets
      // a global as its `browser` entry, which has no default export. Rolldown
      // (Vite 8) refuses the default import of it, so the bare import resolves
      // to the package's ES module, from the importer as before.
      {
        find: /^gl-bench$/,
        replacement: "gl-bench/dist/gl-bench.module.js",
      },
    ],
  },
  server: {
    allowedHosts: true,
    watch: {
      usePolling: true,
    },
  },
  optimizeDeps: {
    include: ["shiki", "@streamdown/code", "streamdown"],
    rolldownOptions: {
      resolve: {
        alias: {
          "@/cosmograph/style.module.css": cosmographStyleAlias,
        },
      },
    },
  },
  test: {
    server: {
      deps: {
        // Load React Aria and React Query through Vite, as the app code is, so
        // a jsdom test renders them with the same React copy as react-dom.
        inline: [
          /react-aria/,
          /react-stately/,
          /@internationalized\//,
          /@tanstack\/react-query/,
        ],
      },
    },
  },
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    nitroV2Plugin({
      preset: "bun",
      plugins: [resolve(__dirname, "src/lib/serverTelemetryNitroPlugin.ts")],
      alias: {
        "@/cosmograph/style.module.css": cosmographStyleAlias,
      },
    }),
    viteReact(),
  ],
})

export default config
