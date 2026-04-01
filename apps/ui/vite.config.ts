import { createRequire } from "node:module"
import { join } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig, type PluginOption } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

/* Vite 7 pre-bundles this config into node_modules/.vite-temp; bare ESM import of
 * `motionwind-react/vite` then fails with ERR_MODULE_NOT_FOUND. Resolve from cwd. */
const require = createRequire(join(process.cwd(), "package.json"))
const { motionwind } = require("motionwind-react/vite") as {
  motionwind: () => PluginOption
}

const config = defineConfig({
  server: {
    allowedHosts: true,
    watch: {
      usePolling: true,
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
