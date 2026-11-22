---
name: feature-gates
description: Write a knowledge file of kind FeatureGate for each feature gate that the source declares (Kubernetes featuregate constants, Rust declare_features! entries), with its stage, default, owners, KEP or tracking issue, and a PART_OF claim to the unit that declares it. Script only; no model.
---

# feature-gates

The host runs this skill as a plain command, once for each repository, on the assembled ref after the root steps. No model runs it.

1. The host writes `/ctxpipe/step.json` and the context index, as for each step.
2. The host writes the root-to-file map (ADR-052 section 6) and runs `node /ctxpipe/skills/feature-gates/scripts/feature-gates.mjs --source /ctxpipe/source/<handle> --source-url <url> --source-path <path> --roots <root-to-file map>`. `--roots` is necessary.
3. The script reads only the `.go` and `.rs` files whose path names a feature (for example `pkg/features/kube_features.go` or `compiler/rustc_feature/src/unstable.rs`). It does not read test files, test and example folders, or vendored, test-data, and fixture folders.
4. A Go gate is a constant `Name featuregate.Feature = "Name"`. The `// owner:` and `// kep:` lines of its comment give the owners and the KEP numbers. The other comment lines are the description. Its spec map (`Name: {{Version: …, Default: …, PreRelease: …}}`) in the same folder gives its stages; the last spec is the current stage and default.
5. A Rust gate is an entry `(unstable, name, "1.63.0", Some(12345))` of a `declare_features!` file. Its `///` lines are the description, and the number is the tracking issue.
6. Each gate gets `knowledge/features/<name>.md`. When another file has that path, the file is `knowledge/features/<repository>-<name>.md`. When more than one file of the source declares the name, each gate gets `knowledge/features/<name>-<declaring folder>.md`. A file of kind `FeatureGate` of this source with the name, whose `Declared in` line names the declaring file, is the file of the gate.
7. The file gets a `PART_OF` claim to each package unit file (`Service`, `App`, `Library`) of the deepest root that holds the declaring file. When that root has no such file, the claim goes to the repository unit.
8. A KEP gets a link to a `Decision` file of the context whose name holds `KEP-<number>`, and to the mirrored issue `github/issues/kubernetes/enhancements/<number>.md` when the context has it. A Rust tracking issue gets a link to `github/issues/<owner>/<repository>/<number>.md` when the context has it. External KEP links are text in code, because the host allows external links only to the repositories of the Workspace.
9. The description is source text, so it is in a block quote with a `Source:` line. It keeps its first 2 KiB.
10. A page ends only at the step limits of the host validator (2 MiB of files, and a patch.json of 1 MiB and 10,000 ops). When more files wait, the result has `"more": true`, and the host runs the skill again on the new base.
11. It writes the staged tree and `/ctxpipe/out/patch.json`, and a summary that matches `schema.json` to stdout.

The script never sets a host field. A file that this source owns alone, with no human section, is written again with the current facts (a gate changes its stage and default between releases). Any other existing file changes only additively (new claims, and new lines in a `## Related` section at the end).
