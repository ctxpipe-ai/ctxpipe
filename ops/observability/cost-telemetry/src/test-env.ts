import { afterEach, beforeEach } from "bun:test"

/** Sets each variable for each test, and restores it after. `undefined` keeps a variable unset. */
export function useEnv(vars: Record<string, string | undefined>): void {
  const previous: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const [key, value] of Object.entries(vars)) {
      previous[key] = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  afterEach(() => {
    for (const key of Object.keys(vars)) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}
