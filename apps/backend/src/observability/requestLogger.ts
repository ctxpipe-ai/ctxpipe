import { getLogger } from "./logger.js"

export function tryGetLogger(): ReturnType<typeof getLogger> | undefined {
  try {
    return getLogger()
  } catch {
    return undefined
  }
}
