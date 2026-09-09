# Gate 3 BOM correction Spec coverage — `f7c35433`

## Boundary

- Reused cumulative review: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...d3ba7e591ecb557ca1e5c3da96ec9e99d0dd1f67`
- Reused retirement/root-authority correction review: `d3ba7e59...842e41bdeb68fc796d8a810a1dc17ccbf0d448e8`
- Focused target diff: `842e41bdeb68fc796d8a810a1dc17ccbf0d448e8...f7c354334bb91310f3a49f74563bce6497c688ca`
- Commit: `f7c35433 Gate 3: preserve plain instruction BOM bytes during claims publication`
- Pinned reads only; no implementation edits or test execution.

## Source trace

| Boundary | Pinned behavior | Assessment |
|---|---|---|
| Plain Markdown parse | `layout.ts:58-60` uses BOM-stripped text only for delimiter detection, then returns `body: raw` when no front matter exists. | A leading BOM remains an instruction-body byte. |
| Existing front matter | `layout.ts:62-80` parses after recognizing the optional BOM-prefixed delimiter. | Existing behavior retained; BOM belongs to the front-matter envelope, while body extraction is unchanged. |
| Claims-only guard | `extraction-source.ts:98-129` compares parsed bodies exactly and all non-`claims` metadata before credentials/final push. | Removing a plain-file BOM is now rejected; semantic output uses the same guard. |
| Metadata insertion | `knowledge-metadata.ts:60-73` places a new front-matter envelope before the untouched `raw` plain body. | Legitimate claims insertion preserves BOM, body whitespace, and final newlines. |
| Existing front-matter rewrite | The regex captures an optional leading BOM in delimiter group 1 and emits that group unchanged. | Leading BOM remains preserved. |

## Focused proof inspection

- Native authority case changes `\uFEFFOwner notes.\n` to `Owner notes.\n`, calls the real broker, and checks rejected publication, unchanged remote, and no contents-write token.
- Native producer case exercises legitimate claims insertion into the BOM-prefixed plain root and compares preserved body bytes.
- Reported evidence, not rerun: guard/parser/export 31/31 and producer BOM case 1/1.

## Scope continuity

- The increment changes one production line in the pure front-matter parser.
- No new default writer, credential issuer, job-row creator, workflow owner, provider path, or lifecycle was introduced.
- The previous Spec blocker remains closed: the four superseded generic model APIs are absent.
- Cumulative A–F ownership and acceptance coverage remains applicable.
- Full CI is pending; later Gate 4–6 scope remains excluded.

## Counts

- New Spec findings: 0.
- Prior Spec findings: closed.
- Code/spec closure review status: pass; overall gate status awaits full CI and the other required review.
