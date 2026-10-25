import { fileURLToPath } from "node:url"

// A Vitest reporter that only turns tracing on. Vitest has no CLI option for
// setup files, so the runner adds this reporter and the reporter puts
// trace-worker.mjs first in the setup files of each project.
export default class TraceReporter {
  onInit(vitest) {
    const setup = fileURLToPath(new URL("trace-worker.mjs", import.meta.url))
    for (const project of vitest.projects)
      project.config.setupFiles.unshift(setup)
  }
}
