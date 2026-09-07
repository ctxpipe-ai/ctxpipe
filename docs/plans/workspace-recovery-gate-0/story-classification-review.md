# Story inventory review

Reviewed all78 tracked story files at the fixed PR head: component imports, render/decorator boundaries and all play bodies, using TypeScript AST extraction followed by inspection of the WorkspacePane playground and ChatSession fixture setup. Per-file rationales are in test-classification.tsv.

Classification is file-level and limited to the strongest defensible asserted invariant; mixed files explicitly retain visual/action-only qualifications. No-play stories are characterization, not redundant merely for lacking tests. Proof means UI oracle strength with real components and network MSW, never backend correctness or successful execution. Callback-only, CSS-class-only, seeded ownership and action-without-result stories are characterization. No deletion is authorized by classification alone.

Full browser execution is recorded separately. Known stale WorkspaceSurface expectations remain failures in the baseline. Gate5 owns missing production UI behavior proof; Gate6 owns fixture/deletion review once equivalent proof exists.
