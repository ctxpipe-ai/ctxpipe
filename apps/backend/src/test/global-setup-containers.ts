import {
  ownTestContainers,
  removeOrphanTestContainers,
} from "../../../../scripts/ci/test-containers.mjs"

/**
 * The test run owns the containers that its tests start (label
 * `ai.ctxpipe.test`, scripts/ci/test-containers.mjs). Before the first test,
 * it removes the containers of an earlier run on this host that was killed.
 * When the run ends, also after a failure or SIGINT, the exit handler of
 * `ownTestContainers` removes its own: a test that stops half-way leaves no
 * container behind. A run inside another run leaves that to the outer run.
 */
export default function setup(): void {
  removeOrphanTestContainers()
  ownTestContainers()
}
