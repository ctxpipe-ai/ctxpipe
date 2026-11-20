import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * Builds the file converter of this checkout (`converter/`), so that
 * `convertFile` runs the real CLI. Cargo builds it once; a later call reuses
 * the build. It needs a Rust toolchain (rustup.rs). The tests and the vision
 * eval call it; the worker image builds the CLI in `Dockerfile.worker`.
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
    { stdio: ["ignore", "ignore", "inherit"] },
  )
}
