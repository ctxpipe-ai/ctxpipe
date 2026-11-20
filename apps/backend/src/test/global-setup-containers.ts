import {
  ownTestContainers,
  removeOrphanTestContainers,
  removeTestContainers,
} from "../../../../scripts/ci/test-containers.mjs"

/**
 * The test run owns the containers that its tests start (label
 * `ai.ctxpipe.test`, scripts/ci/test-containers.mjs). Before the first test,
 * it removes the containers of an earlier run on this host that was killed.
 * When the run ends, also after a failure or SIGINT, it removes its own: a
 * test that stops half-way leaves no container behind.
 */
export default function setup(): () => void {
  removeOrphanTestContainers()
  ownTestContainers()
  return () => {
    removeTestContainers()
  }
}
