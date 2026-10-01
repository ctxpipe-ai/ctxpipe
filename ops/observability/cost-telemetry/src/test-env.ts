import { afterEach, beforeEach } from "bun:test"

export function useEnv(vars: Record<string, string>): void {
  const previous: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const [key, value] of Object.entries(vars)) {
      previous[key] = process.env[key]
      process.env[key] = value
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
