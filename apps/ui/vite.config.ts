import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

const config = defineConfig({
  server: {
    allowedHosts: ["ui-bun", "localhost", "127.0.0.1"],
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
    viteReact(),
  ],
})

export default config
