# Production activation and run credentials

Gate 4 remains open. These checks establish the bounded activation slice; they
are not the full Docker/Bun/model/tools journey or Railway acceptance.

## Application and deployment

- Docker preparation resolves the prebuilt chat and proxy images to immutable
  IDs and creates an isolated policy for that workspace. Fixed resources are
  1 CPU, 1 GiB memory, 128 PIDs, 4 GiB writable disk and UID/GID 1000.
- Both exact and transition identities include the normalized image/resource/
  egress policy. Credential rotation and ordinary SHA transitions preserve that
  policy identity; no tenant host lists are accumulated in a global definition.
- Deployment initializes both images before backend readiness. Chat setup checks
  the existing OpenCode binary rather than installing it during a conversation.
  Container HOME and PATH belong to the image, not the backend host.
- The model relay binds only the nested default bridge gateway. It reads the
  shared network interface without Docker credentials or an API socket, and
  resolves backend DNS on each connection. A real nonroot, read-only relay
  started before the backend and continued after its IP changed. The prior
  direct-agent bypass denial proof remains applicable to the same gateway bind.

Focused configuration checks passed 24 tests. Locked unavailable Docker/Railway
providers reject preparation without allocating a weaker fallback. Native warm
preparation still preserves dirty files and refreshes bootstrap credentials.
The quota-backed production Docker preparation contract also passes: trusted
HTTPS clone, UID/resource inspection, dirty-file reuse, revision advancement,
provider loss and clean recovery. The test took 177.3 seconds and left no
owned containers or networks; the derived fixture tag was removed afterward.
Fixture image cleanup now uses non-force deletion so dependent leaks fail
explicitly.

## Credential authority and renewal

The production model and Git brokers use distinct HMAC capabilities tied to the
calling run's actual native PostgreSQL transcript-lock owner. A receipt from
acquisition supplies that owner; mint cannot adopt a replacement run. One joined
query validates live ownership and the current conversation/workspace binding.
Release, loss or expiry revokes the capability through the existing lock system.

Docker create-time secrets omit the legacy timed model token. Native environment
injection supplies only the run capabilities before OpenCode starts. The fixed
Git helper asks the broker for short-lived read credentials; the GitHub CLI
wrapper passes its credential only to the child process. The broker allows the
workspace and linked GitHub repositories recorded for the same connection,
rejects scopes over 500, and requests only contents/issues/pull-requests/metadata
read permissions. It checks the issuer's expiry independently of the client
cache and refreshes within the last minute. After external credential issuance,
it revalidates both native ownership and the exact repository set.

Real PostgreSQL/HTTP/Git-helper contracts passed:

- Valid current owner, wrong purpose, tampering, wrong tenant, ordinary SHA
  advancement, rebinding, release, replacement owner, and expired ownership.
- Read-token renewal using the issuer's real expiry and a short elapsed wait;
  no fake clock, process restart or cache reset is used for the renewal proof.
- Rejection of another connection's repository, an unlink during credential
  issuance, and 501 repositories without making an extra token request.
- Two stock native OpenCode turns preserve the worktree and transcript with the
  new model capability. The credential helper's separate expiry check does not
  yet prove a single Docker OpenCode process executing across that expiry.

The scoped broker/owner regression passed in 24.32 seconds; the lock/capability
regression passed three native cases. The GitHub CLI version path also passed in
the nonroot image with networking disabled and no credential.

## Remaining acceptance

Finish the rebuilt-image Docker chat journey, including model and tool callbacks plus mid-run Git access.
Complete Railway live conformance, the final entry-point audit, both cumulative
reviews and full CI. Current test partition has 190 backend files and 49 required
contract files with no overlap or omissions; the proof policy passes 436 test/
story/config files and 29 command files. Backend/UI type allowances remain
124/223 and must be eliminated in Gate 6.

## Runtime faults and current validation

The integrated Docker/Bun probe identified an unhandled error on an accepted
proxy socket. The native Docker proxy now destroys the affected socket while
preserving the proxy process; the real connection-reset regression passes.
The Docker runtime API deadline is two minutes because real snapshot commits
can exceed 30 seconds; prebuilt image discovery retains the shorter deadline.

Native sandbox creation now records its initialized instance before snapshot
IO, so an interrupted snapshot retains a durable cleanup/retry anchor. Resume
completes a missing initial snapshot on the same live instance. Docker snapshot
acknowledgement recovery accepts only a newly published image, never a preexisting
tag. Both native fault-injection cases pass under Node 22: rejected commit retry
retains the same base container; lost acknowledgement recovers after one commit.
The check took 52.1 seconds, including cleanup.

The complete backend typecheck passes with the existing 124 diagnostics and no
additions (96.23 seconds). Files and publication preserve native failure status
and error through declared OpenAPI responses and typed JSON; their final two
unavailable-provider route scenarios pass in 12.5 seconds. The UI allowance remains 223 from the prior unchanged UI check. The
entry-point audit found no additional ownership blocker across provider
selection, HTTP/WS, Files, publish, deletion and idle cleanup.

The integrated probe now prepares the image and reaches native authenticated
OpenCode ingress through the local nested-Docker test network. Session creation
succeeds. A prompt exposed a separate proxy bug: a five-second TCP inactivity
timeout also bounded the wait for response headers, aborting valid long-running
requests with HTTP 502. The focused delayed-response regression and correction
are in progress; the integrated journey is not yet accepted.

## Cumulative review corrections

The review found three additional integration defects. Files and publication now
preserve the native preparation result instead of converting provider errors
into a missing sandbox. Real authenticated routes first reproduced HTTP 409 for
an unavailable provider, then passed HTTP 503 for tree/blob/status/diff/save,
push and PR creation. Existing missing-sandbox and successful warm Files cases
still pass (four selected scenarios, 16.32 seconds); failed saves preserve the
working file and failed publication does not write Git or create a PR.

Base collection now resolves the same configured agent image as preparation and
compares immutable image IDs. The native red check incorrectly collected a
current base immediately after its last fork was released. Both current-image
retention and obsolete-base collection now pass (74.05 seconds, including
fixture setup/cleanup). Docker image discovery runs outside the SQL connection.

Detached deletion after external agent loss now passes its native green check,
together with proxy-delete and network-delete retry cases (three cases, 80.39
seconds including setup/cleanup). The proxy remains an exact native cleanup
anchor after the agent disappears, and another owner remains untouched. The
reviewer has cleared all three implementation defects.

The delayed-response proxy regression also passes (12.7 seconds including the
existing CONNECT reset case). Both outbound HTTP and authenticated ingress
accept a real 5.5-second delay before headers after a successful connection.

The checkpoint also passes scoped Biome (32 files), proof policy (436 test/story/
config files and 29 command files), complete test partition (190 backend plus
49 required contract files, no overlap/omission), Compose deploy configuration
validation, and the repository whitespace check outside generated patches.
Full CI and integrated acceptance remain pending.
