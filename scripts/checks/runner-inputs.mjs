// The runner files of the merge gate (`runner` in gate.mjs mode): they run
// a check, but cannot change which checks exist or what a check expects. A
// test keeps this list equal to the files that gate.mjs names.
export const runnerFiles = [
  "scripts/checks/run.mjs",
  "scripts/checks/selected.mjs",
  "scripts/checks/rerun-failed.mjs",
  "scripts/ci/prerequisites.mjs",
]

// The manifest with `runnerInputs` on each check of a `selectAll` lane: the
// inputs of the check that are runner files. A selector keeps such a check
// only when an input other than a runner input reached it
// (scripts/checks/README.md, Unsampled lanes). Another lane has no use for
// the field, and the factory wants one list for each lane name, which
// checks of two families can share. Only list.mjs imports this module, so
// no key holds it.
export const withRunnerInputs = (manifest) => ({
  ...manifest,
  checks: manifest.checks.map((check) => {
    const runnerInputs = check.selectAll
      ? check.inputs.filter((input) => runnerFiles.includes(input))
      : []
    return runnerInputs.length ? { ...check, runnerInputs } : check
  }),
})
