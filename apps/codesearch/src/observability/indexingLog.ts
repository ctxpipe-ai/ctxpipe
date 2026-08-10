import { flushWorkflowLog, getLogger, log } from "./logger.js"

export function tryEmitIndexEvent(
  step: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    const logger = getLogger()
    logger.set({ step, ...fields })
    logger.info(step)
    flushWorkflowLog()
  } catch {
    log.info({ step, ...fields, message: step })
  }
}
