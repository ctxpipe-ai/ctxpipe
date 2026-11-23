import { spawnSync } from "node:child_process"
import { hostname } from "node:os"
import { pathToFileURL } from "node:url"

// The containers that tests and CI scripts start (CTX-1442), and the images
// that they build (CTX-1551). Each one has the label
// `ai.ctxpipe.test=<host>/<pid>`: the process that owns the run. The owner
// removes them, containers with their anonymous volumes, when it ends, also
// after an error, SIGINT, SIGTERM or SIGHUP. A run that was killed with SIGKILL
// cannot do this: the next run on the same host removes the containers and
// images of an owner process that is gone (`removeOrphanTestContainers`,
// `removeOrphanTestImages`; `node test-containers.mjs remove-orphans` runs
// both). `factory check` also reads the label: when the Docker disk is almost
// full, it removes the stopped test containers that are older than one day.
//
// The functions are synchronous, so that they also work in an exit handler.

export const TEST_LABEL = "ai.ctxpipe.test"
const OWNER_ENV = "CTXPIPE_TEST_OWNER"

/** The owner of the containers that this process starts: `<host>/<pid>`. */
function testOwner() {
  return process.env[OWNER_ENV] || `${hostname()}/${process.pid}`
}

/** The `docker run` or `docker create` arguments that label a test container. */
export function testLabelArgs() {
  return ["--label", `${TEST_LABEL}=${testOwner()}`]
}

/** The `Labels` of a test container that the Docker API (dockerode) creates. */
export function testLabels() {
  return { [TEST_LABEL]: testOwner() }
}

/** The output lines of a docker command. No lines when the command fails. */
function dockerLines(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
  })
  if (result.status !== 0) return []
  return result.stdout.split("\n").filter(Boolean)
}

/** Removes the containers `ids` with their anonymous volumes. */
function remove(ids) {
  if (ids.length > 0) dockerLines(["rm", "--force", "--volumes", ...ids])
}

/** Removes the test containers of `owner`, with their anonymous volumes. */
function removeTestContainers(owner) {
  remove(
    dockerLines(["ps", "-aq", "--filter", `label=${TEST_LABEL}=${owner}`]),
  )
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process is there, but another user owns it.
    return error.code === "EPERM"
  }
}

/** Whether `owner` was a process on this host that is gone. */
function gone(owner) {
  const slash = owner.lastIndexOf("/")
  const pid = Number(owner.slice(slash + 1))
  return owner.slice(0, slash) === hostname() && Number.isInteger(pid) && pid > 0
    ? !alive(pid)
    : false
}

/**
 * Removes the test containers whose owner was a process on this host that is
 * gone. A container of another host, or of a process that runs, stays.
 */
export function removeOrphanTestContainers() {
  const orphans = dockerLines([
    "ps",
    "-a",
    "--filter",
    `label=${TEST_LABEL}`,
    "--format",
    `{{.ID}}\t{{.Label "${TEST_LABEL}"}}`,
  ]).flatMap((line) => {
    const [id, owner = ""] = line.split("\t")
    return id && gone(owner) ? [id] : []
  })
  remove(orphans)
}

/**
 * Removes the test images (built with `--label ai.ctxpipe.test=<owner>`) whose
 * owner was a process on this host that is gone: each of its tags, or its id
 * when it has none. Docker refuses to remove an image that a container uses
 * (no `--force`), so an image that a container runs stays, as does an image
 * of another host or of a process that runs. It reads Docker's JSON, so a
 * label value cannot add a record.
 */
export function removeOrphanTestImages() {
  const ids = dockerLines([
    "image",
    "ls",
    "-q",
    "--no-trunc",
    "--filter",
    `label=${TEST_LABEL}`,
  ])
  if (ids.length === 0) return
  let records = []
  try {
    records = JSON.parse(
      dockerLines(["image", "inspect", ...new Set(ids)]).join("\n"),
    )
  } catch {
    return
  }
  for (const image of records) {
    const owner = image?.Config?.Labels?.[TEST_LABEL]
    if (typeof owner !== "string" || !gone(owner)) continue
    const tags = image.RepoTags ?? []
    for (const name of tags.length > 0 ? tags : [image.Id])
      dockerLines(["image", "rm", "--", name])
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]

/**
 * Makes this process the owner of the test containers that it and its child
 * processes start (they inherit the owner through the environment), and
 * removes them when this process ends. When an owner is already set (a parent
 * run owns them), it does nothing: that parent removes them.
 */
export function ownTestContainers() {
  if (process.env[OWNER_ENV]) return
  const owner = `${hostname()}/${process.pid}`
  process.env[OWNER_ENV] = owner
  const cleanUp = () => removeTestContainers(owner)
  process.on("exit", cleanUp)
  for (const signal of SIGNALS)
    process.once(signal, () => {
      cleanUp()
      // With no other handler, the signal ends the process, as it does
      // without this handler.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    })
}

// `node test-containers.mjs remove-orphans`: for a shell script, such as
// apps/codesearch/scripts/run-vitest-docker.sh.
if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  process.argv[2] === "remove-orphans"
) {
  removeOrphanTestContainers()
  removeOrphanTestImages()
}
