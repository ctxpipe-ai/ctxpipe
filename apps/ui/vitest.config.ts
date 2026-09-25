import { defineConfig, mergeConfig } from "vitest/config"
import viteConfig from "./vite.config"

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      server: {
        deps: {
          inline: [
            "@tanstack/react-router",
            "@tanstack/react-store",
            "@tanstack/router-core",
            "@tanstack/history",
          ],
        },
      },
    },
  }),
)
