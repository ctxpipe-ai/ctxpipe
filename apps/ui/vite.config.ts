import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig, type PluginOption } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

const __dirname = dirname(fileURLToPath(import.meta.url))

/* Vite 7 pre-bundles this config into node_modules/.vite-temp; bare ESM import of
 * `motionwind-react/vite` then fails with ERR_MODULE_NOT_FOUND. Resolve from cwd. */
const require = createRequire(join(process.cwd(), "package.json"))
const { motionwind } = require("motionwind-react/vite") as {
  motionwind: () => PluginOption
}

/** `@cosmograph/cosmograph` source imports `@/cosmograph/style.module.css` with its own
 * `@/` alias; point that at our local stub so both vite bundling and esbuild
 * optimizeDeps (pre-bundle) resolve it. */
const cosmographStyleAlias = resolve(
  __dirname,
  "src/cosmograph/style.module.css",
)

const config = defineConfig({
  resolve: {
    alias: {
      "@/cosmograph/style.module.css": cosmographStyleAlias,
    },
  },
  server: {
    allowedHosts: true,
    watch: {
      usePolling: true,
    },
  },
  optimizeDeps: {
    include: ["shiki", "@streamdown/code", "streamdown"],
    esbuildOptions: {
      alias: {
        "@/cosmograph/style.module.css": cosmographStyleAlias,
      },
    },
  },
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    nitroV2Plugin({ preset: "bun" }),
    motionwind(),
    viteReact(),
  ],
})

export default config
