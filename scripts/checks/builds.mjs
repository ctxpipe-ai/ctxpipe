// The programs that this repo builds from its own source and that tests start
// as a process (manifest.v1.schema.json, `builds`). No test imports their
// source, so the import graph does not see them. A selector finds the checks
// that start a program from the trace (`execs`, scripts/checks/README.md,
// Traces), selects them when an input changes, and keys them by the inputs.
// `native`: the program is native code of the host, so a pass on one OS or
// CPU proves nothing about another (the converter's seccomp sandbox exists
// only on Linux).
//
// Add an entry for each new program that a test starts: its output path, as
// the code that starts it names it, and the files that change it.
export const builds = [
  {
    // The file converter (CTX-1433): apps/backend/test/converter.ts builds
    // it, `converterBinary()` in convert-file.ts starts it.
    output: "apps/backend/converter/target/release/ctxpipe-convert",
    inputs: ["apps/backend/converter/**"],
    native: true,
  },
]
