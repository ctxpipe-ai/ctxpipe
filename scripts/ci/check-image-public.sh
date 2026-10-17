#!/usr/bin/env bash
# Fails when an image tag on GHCR cannot be pulled without credentials.
# Usage: check-image-public.sh <owner/image> <tag>
# A new GHCR package is private by default. A self-hosted stack pulls the image
# anonymously, so a private package breaks it after an upgrade.
set -euo pipefail

image="${1:?usage: check-image-public.sh <owner/image> <tag>}"
tag="${2:?usage: check-image-public.sh <owner/image> <tag>}"

# A private package refuses the token request too. Then the token stays empty
# and the manifest request below reports the refusal.
token="$(curl -sS --max-time 30 \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull" |
  sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p' || true)"

status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://ghcr.io/v2/${image}/manifests/${tag}")"

if [ "$status" = "200" ]; then
  echo "ghcr.io/${image}:${tag} pulls without credentials"
  exit 0
fi
echo "::error::ghcr.io/${image}:${tag} cannot be pulled without credentials (HTTP ${status}). Make the package public in the organization package settings, then run the release again."
exit 1
