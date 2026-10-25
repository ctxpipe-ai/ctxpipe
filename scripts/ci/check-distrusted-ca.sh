#!/usr/bin/env bash
# Fails when a runtime in an image accepts a TLS chain through one of the eight
# eMudhra intermediate CA certificates that the CA stores removed in
# October 2026 (CTX-975).
# Usage: check-distrusted-ca.sh <image>
# The check runs each runtime that the image has: Bun and Node (each with its
# bundled CA store) and git (the OS CA store, which curl, Python and Go also
# use). The test hosts are public hosts of the advisory site
# (https://emudhra.we-have-a-problem.com). Each host serves a chain through
# one of the removed intermediates.
set -euo pipefail

image="${1:?usage: check-distrusted-ca.sh <image>}"

# Prints one line for each host: "rejected", "TRUSTED" or "unreachable".
# The same code runs under Bun and Node.
probe='(async () => {
  for (const host of process.env.HOSTS.split(" ")) {
    try {
      const response = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(20000) })
      console.log(`${host} TRUSTED ${response.status}`)
    } catch (error) {
      const code = String((error.cause ?? error).code ?? (error.cause ?? error).name)
      const tls = /CERT|ISSUER|SIGNATURE|SELF_SIGNED|UNTRUSTED/.test(code)
      console.log(`${host} ${tls ? "rejected" : "unreachable"} ${code}`)
    }
  }
})()'

result="$(docker run --rm --entrypoint sh \
  -e PROBE="$probe" \
  -e HOSTS="dv-g3b-emudhra.we-have-a-problem.com dv-g3b-aaa-emudhra.we-have-a-problem.com" \
  -e GIT_TERMINAL_PROMPT=0 \
  "$image" -c '
    for runtime in bun node; do
      if command -v "$runtime" >/dev/null; then
        "$runtime" -e "$PROBE" | sed "s/^/$runtime /"
      fi
    done
    if command -v git >/dev/null; then
      for host in $HOSTS; do
        out="$(git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=20 ls-remote "https://$host/" 2>&1 || true)"
        case "$out" in
          *"SSL certificate problem"* | *"certificate verification failed"* | *"certificate verify failed"*) echo "git $host rejected" ;;
          *"Could not resolve"* | *"Failed to connect"* | *"timed out"* | *"Operation too slow"*) echo "git $host unreachable" ;;
          *) echo "git $host TRUSTED" ;;
        esac
      done
    fi
  ')"

echo "$result"
if [ -z "$result" ]; then
  echo "::error::${image} has no Bun, Node or git to check. Add the image runtime to scripts/ci/check-distrusted-ca.sh."
  exit 1
fi
if grep -q ' TRUSTED' <<<"$result"; then
  echo "::error::A runtime in ${image} accepts a chain through a removed eMudhra intermediate CA. Update the base image to a Bun, Node or ca-certificates release that removes it (CTX-975)."
  exit 1
fi
if grep -q ' unreachable' <<<"$result"; then
  echo "::error::The check could not reach the test hosts from ${image}. Run the job again. If the advisory site has removed the hosts, remove this check."
  exit 1
fi
echo "Each runtime in ${image} rejects the removed eMudhra intermediates."
