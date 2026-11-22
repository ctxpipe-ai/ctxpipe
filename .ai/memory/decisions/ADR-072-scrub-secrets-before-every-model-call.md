# ADR-072: Kingfisher scrubs the secrets of each text before every model call

**Status:** Accepted (the CTO, 2026-11-20) | **Date:** 2026-11-21 | **Tags:** privacy, security, models, knowledge, self-host

## Context

A report (2026-11-20) says that some model providers take secrets from prompts. The CTO: "we need to add secrets scrubbing step before any embedding/llm call", deterministic and fast. "Just use kingfisher library, don't over think it."

[Kingfisher](https://github.com/mongodb/kingfisher) (MongoDB, Apache-2.0) is a Rust secret scanner with a large rule catalog. It ships the library crate `kingfisher-scanner`, a Python SDK and an npm SDK. The npm SDK has glibc builds only. Our backend images are Alpine (musl), so we cannot use the npm SDK.

## Decision

1. **Kingfisher finds the secrets.** We use the library crate `kingfisher-scanner` with its built-in rules (medium confidence and higher). We do not build its `validation` feature, so no found secret goes to its provider. Kingfisher's catalog decides what is a secret, with one rule of our own for its one known gap, the password of a plain URL. For `scheme://userinfo@` of any scheme, the whole userinfo up to the last `@` of the token becomes `[REDACTED:url-credentials]` when it holds a `:` (a password part). The rule fails safe and has no special cases: a part that only looks like a password (a port and a query, a template such as `${DB_PASSWORD}`) is redacted too, because a redaction that was not needed costs a placeholder and a miss leaks a secret. A URL with no password part (`https://user@host`) is kept. The token ends at whitespace, `"`, `<`, `>` or a backtick, so a password with one of these characters is an accepted gap.
2. **A placeholder replaces each secret.** Each found secret becomes `[REDACTED:<rule id>]`, for example `[REDACTED:betterleaks.github-pat]`. Only the secret is replaced; the text around it stays. Overlapping findings become one placeholder. The scan keeps no state between requests (no dedup), so the same input always gives the same output.
3. **One process for each backend process.** The scrubber is the `--scrub` mode of the converter binary (`apps/backend/converter`, [ADR-066](ADR-066-knowledge-content-in-clickhouse.md) decision 6). It stays alive and answers JSON lines in order. A line ends at `\n` only: the answer holds U+2028 and U+2029 as they are, so the client must not split a line at them (`node:readline` does, CTX-1504). Each request line has an id, and its answer repeats it. An answer with another id stops the process, and each request in flight fails, so an answer never goes to another request. At start, the process compiles the rules (about 3 s) or loads them from its cache (Kingfisher's own cache, about 0.3 s). Then it applies the seccomp sandbox and the memory limit of the converter. The API server starts it before it serves. While the backend process runs, the scrubber does not stop, so each stop is an error event (`secret-scrubber.stopped`), and an alert counts them.
4. **One place in the code.** Every model client passes its request through `scrubForModel` (`apps/backend/src/retrieval/services/scrubForModel.ts`): the LLM tiers (`HostTextAdapter`), the embeddings (`generateEmbeddings`, the knowledge plane on ingest and query), Jev, the vision prompt, the OpenAI-compatible routes and the Workspace chat model proxy, and the eval judges. `scrubForModel` scrubs each string and each key of a JSON value. A proxy that turns a request into one text (the Bedrock proxy) scrubs that text again. The model reads the texts of a conversation (the system prompts and the messages) as one text, so `scrubForModel` also scans their joined text after the scrub of each text: a secret that it finds there is split over two texts, and the call fails. Each text that is cut for a model (an input limit, an excerpt, a prompt head) is scrubbed before the cut. The OpenAI-compatible embeddings route accepts only text, not token ids, because the scrubber cannot read token ids. A test fails each file that builds a model request and does not call `scrubForModel`. When the scrubber cannot run, the call fails: no text goes to a model unscrubbed.
5. **The version.** Kingfisher and its rules are in the `Cargo.lock` of the converter, so the converter version (`ctxpipe-convert --version`) is also the scrubber version. It is part of the projection version ([ADR-067](ADR-067-knowledge-projection-applies-git-diff.md) decision 4). The knowledge plane scrubs the text of each file (a Markdown file, the text of a converted file) before the parser and the chunker read it, so a secret across a chunk boundary is found. The stored chunks hold the scrubbed text, and the embedding key hashes it, so a new scrubber gives a new key only for each text that it changes. The legacy Postgres pipeline scrubs the title and the body of each unit before `commitHydrateProjection` and its chunker too (`scrubHydrateUnits`, one request for each unit, outside the org transaction), so its stored units and chunks hold the scrubbed text. A stored unit with a secret gets a new unit hash, so the next hydrate of its Workspace writes it again; until then it keeps its text.
6. **Images are not scrubbed.** An image goes to the model as it is: a whole base64 data URL of an image type (`data:image/…;base64,…`), or image bytes. Each other string is scrubbed, also the URL of an image and the other fields of an image part. The trusted-provider rule covers images: each hosted model call goes only to a trusted provider, with ZDR ([ADR-070](ADR-070-model-calls-go-only-to-trusted-providers.md)). The text that the vision model reads from an image is scrubbed when it goes to the embedding model.
7. **Hosted and self-host.** The scrubber is in both backend images (`Dockerfile`, `Dockerfile.worker`), so it protects every deployment. It has no setting.

## Time added per call

`scrubForModel` from Node, on an Apple M3 Ultra, with the rules loaded. The chunks are the 4,615 chunks that the plane chunker makes of the Markdown files of this repository (723 characters on average). The chat prompt is a system prompt and 12 messages of source files (46 KB).

| Call | Size | Calls | p50 | p95 |
| -- | -- | -- | -- | -- |
| One chunk | 0.8 KB | 2,000 | 0.03 ms | 0.05 ms |
| One embedding batch (64 chunks) | 47 KB | 72 | 0.51 ms | 0.79 ms |
| One chat prompt (13 messages) | 46 KB | 200 | 0.57 ms | 0.73 ms |
| One search question | 77 B | 500 | 0.02 ms | 0.02 ms |

## Consequences

- The API image now builds the Rust converter stage too. The stage has a dependency layer and a source layer, and CI keeps a registry layer cache of both images. A change of our Rust source rebuilds only the converter crate (7 s in Docker, against 163 s for a cold build).
- Host development needs Rust (rustup): `pnpm dev` builds the converter first. The backend tests already needed it.
- The `@ctxpipe/visual-review` package (the visual critic of CI) is not a product model client. It sends screenshots and the rubric of the repository, no customer text, so it does not scrub.
