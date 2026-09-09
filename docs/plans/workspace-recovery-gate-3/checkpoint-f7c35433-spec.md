# Gate 3 final correction — Spec review

Pinned target: `f7c354334bb91310f3a49f74563bce6497c688ca`; focused increment: `842e41bdeb68fc796d8a810a1dc17ccbf0d448e8..f7c35433`.

## Findings

No blocking Spec findings.

The BOM correction satisfies ADR-033’s requirement that claims-only extraction preserve instruction body bytes. In [`layout.ts:53-81`](apps/backend/src/domain/workspaces/layout.ts), `parseSimpleFrontMatter` still strips a leading BOM only to recognize an actual front-matter delimiter; when the file is plain Markdown, it now returns the original `raw` body. Consequently, the shared claims-only broker guard compares a plain root’s BOM as part of its body and rejects its removal before any write credential is issued.

The legitimate publication path also converges: [`knowledge-metadata.ts:55-74`](apps/backend/src/domain/workspaces/knowledge-metadata.ts) inserts front matter followed by the exact original plain body, including its BOM, with only the single structural delimiter newline. On replay, the parser sees that BOM inside the body and compares it byte-for-byte. Existing front-matter files keep their leading BOM through the captured delimiter.

No production ownership, credential, Git, admission, or workflow code changed. The prior cumulative review and `842e41bd` zero-finding correction review therefore remain applicable.

**Count:** 0 Spec findings. Full CI has not yet run on this candidate, so this report does **not** declare Gate 3 complete.
