import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * Builds the file converter of this checkout (`converter/`), so that
 * `convertFile` runs the real CLI. Cargo builds it once; a later call reuses
 * the build. It needs a Rust toolchain (rustup.rs). The vision eval calls
 * it, because the export of `factory eval` has no build. The tests get the
 * build from the `converter` prerequisite (scripts/checks/prerequisites.mjs)
 * and the CI job, and the worker image builds the CLI in `Dockerfile.worker`.
 */
export function buildConverter(): void {
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      fileURLToPath(new URL("../converter/Cargo.toml", import.meta.url)),
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      // Only what cargo needs. This is hygiene, not a boundary: on Linux a
      // build script of the same user can read the environment of this
      // process (`/proc`). The checksums of Cargo.lock pin each crate.
      env: Object.fromEntries(
        [
          "PATH",
          "HOME",
          "CARGO_HOME",
          "RUSTUP_HOME",
          "RUSTUP_TOOLCHAIN",
        ].flatMap((name) =>
          process.env[name] ? [[name, process.env[name]]] : [],
        ),
      ),
    },
  )
}
