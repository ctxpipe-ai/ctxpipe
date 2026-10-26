// The Storybook modules that the checks runner (scripts/checks/storybook.mjs)
// loads. A literal import here resolves from apps/ui, the package that
// depends on Storybook. The runner imports this file by a literal path, so
// that the check cache key can follow the import.
export const coreServer = () => import("storybook/internal/core-server")
export const csfTools = () => import("storybook/internal/csf-tools")
