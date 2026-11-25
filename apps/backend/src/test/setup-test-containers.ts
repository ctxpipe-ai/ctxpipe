import { createRequire } from "node:module"

import Docker from "dockerode"

import {
  TEST_LABEL,
  testLabels,
} from "../../../../scripts/ci/test-containers.mjs"

/*
 * Tests also start containers through product code: the sandbox providers,
 * the workspace-base builders and `dockerSandbox` of
 * @tanstack/ai-sandbox-docker. All of them create containers with dockerode,
 * which has no option for labels. In each test worker, every container that
 * dockerode creates gets the label of the test run
 * (scripts/ci/test-containers.mjs), so that the run removes it when it ends.
 * A container label replaces the label of its image, so a container of an
 * image from an earlier run gets this run's owner.
 *
 * An image that dockerode commits keeps no owner: a later run can start a
 * container of it, and that container is not this run's container.
 *
 * @tanstack/ai-sandbox-docker can resolve a dockerode copy that is not the
 * copy of the backend (another major version). The setup changes each copy.
 */

const sandboxDocker = createRequire(
  import.meta.resolve("@tanstack/ai-sandbox-docker"),
)("dockerode") as typeof Docker

type Create = (
  this: Docker,
  options: Docker.ContainerCreateOptions,
  ...rest: unknown[]
) => Promise<Docker.Container>
type Commit = (
  this: Docker.Container,
  options?: unknown,
  ...rest: unknown[]
) => Promise<unknown>

for (const Dockerode of new Set([Docker, sandboxDocker])) {
  const create = Dockerode.prototype.createContainer as unknown as Create
  const labeledCreate: Create = function (options, ...rest) {
    return create.call(
      this,
      { ...options, Labels: { ...options.Labels, ...testLabels() } },
      ...rest,
    )
  }
  Dockerode.prototype.createContainer =
    labeledCreate as unknown as typeof Docker.prototype.createContainer

  const commit = Dockerode.Container.prototype.commit as unknown as Commit
  const unownedCommit: Commit = function (options, ...rest) {
    if (typeof options === "function")
      return commit.call(this, options, ...rest)
    const given = (options ?? {}) as { changes?: string | string[] }
    const changes = [given.changes ?? []].flat()
    return commit.call(
      this,
      { ...given, changes: [...changes, `LABEL ${TEST_LABEL}=""`] },
      ...rest,
    )
  }
  Dockerode.Container.prototype.commit =
    unownedCommit as unknown as typeof Docker.Container.prototype.commit
}
