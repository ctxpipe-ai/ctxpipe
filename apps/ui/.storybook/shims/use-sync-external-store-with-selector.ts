/**
 * Vite ESM: dependencies import named exports from `use-sync-external-store/shim/with-selector`,
 * which resolves to a CJS `module.exports` file and breaks native ESM named imports.
 * Re-export via default interop from the package export map entry `./with-selector`.
 */
import withSelectorPkg from "use-sync-external-store/with-selector.js"

const mod = withSelectorPkg as {
  useSyncExternalStoreWithSelector: (...args: unknown[]) => unknown
}

export const useSyncExternalStoreWithSelector = mod.useSyncExternalStoreWithSelector
