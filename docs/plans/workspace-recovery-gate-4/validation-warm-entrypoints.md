# Warm entry-point validation

| Check | Result | Duration |
| --- | --- | --- |
| Focused native regression: HTTP/WS/MCP, warm prepare, PG persistence, deletion, protected conversations, Files, publication | 34/34 passed, 6 files | 165.58 s |
| Whole backend types | Zero new diagnostics | 77.21 s |
| Native runtime workspace isolation, secrets, named snapshot and teardown | Passed | 2.44 s |
| Static native definitions regression | 18/18 passed, 3 files | 82.21 s |
| Warm GitHub requests | Zero external requests after warmup | 6.30 s |
| Active WebSocket abort, offset replay, transcript and retry | Passed | 11.79 s |
| Cross-org run-id collision | Rejected; persistence suite passed | 2.00 s |
| Native MCP full compatibility journey | Passed | 13.27 s |
| Biome, proof policy, whitespace | Passed | — |
| CI test partition | 190 backend + 42 contracts; zero duplicates/missing | — |

Detailed traces remain in the local task evidence archive; they are not part of this checkpoint's external payload. The repository test files and CI lanes reproduce the checks. Historical CI runs apply only to their recorded commit.
