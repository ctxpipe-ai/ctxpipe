#!/bin/sh
# The "no credential in the sandbox" check of the ingestion v2 proof (CTX-630).
# It runs inside one shard sandbox, as the agent user, after the first step of
# the shard. It looks in the environment variables, the environment of every
# readable process (/proc/<pid>/environ), the git config (also the credential
# helpers) and the files that can hold a token (~/.netrc, git credential
# files, the .git/config of a checkout).
#
# It prints names and counts only, never a value:
#   FINDING <where> <name> <rule>
#   SUMMARY envVars=<n> processes=<n> files=<n> findings=<n> proxySessionVars=<n>
# It exits 1 when it has a finding.
#
# FORBIDDEN_SHA256 (optional): SHA-256 hashes, separated by spaces, of secret
# values that must not be here (the model key, the vault owner password).
# CRED_CHECK_PROC (test seam): the /proc directory, default /proc.
#
# The vault proxy session in HTTPS_PROXY is by design: the session lets the
# sandbox use the proxy and holds no upstream credential. It is counted, not
# flagged.
set -u

proc=${CRED_CHECK_PROC:-/proc}
forbidden=${FORBIDDEN_SHA256:-}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
: >"$tmp/findings"
env_vars=0
processes=0
files=0
proxy_vars=0

# A GitHub token. The installation token form has a numeric id and a second
# underscore (CTX-845).
token_pattern='gh[pousr]_([0-9]{1,20}_[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{20,})|github_pat_[A-Za-z0-9_]{20,}'
key_pattern='-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-or-v1-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{40,}'

finding() { printf 'FINDING %s %s %s\n' "$1" "$2" "$3" >>"$tmp/findings"; }

# Check one value without printing it. $1 where, $2 name, $3 value.
check_value() {
  if printf '%s' "$3" | grep -Eq -e "$token_pattern"; then
    finding "$1" "$2" github-token
  fi
  if printf '%s' "$3" | grep -Eq -e "$key_pattern"; then
    finding "$1" "$2" model-or-private-key
  fi
  if [ -n "$forbidden" ] && [ "${#3}" -ge 8 ]; then
    hash=$(printf '%s' "$3" | sha256sum | cut -d' ' -f1)
    case " $forbidden " in
      *" $hash "*) finding "$1" "$2" known-secret-value ;;
    esac
  fi
}

# Read KEY=VALUE lines from the file $2. $1 is the label.
scan_env_file() {
  while IFS= read -r line; do
    case $line in *=*) ;; *) continue ;; esac
    name=${line%%=*}
    value=${line#*=}
    env_vars=$((env_vars + 1))
    case $name in
      GITHUB_TOKEN | GH_TOKEN | GITHUB_PRIVATE_KEY | MODEL_PROVIDER_API_KEY | OPENAI_API_KEY | ANTHROPIC_API_KEY | OPENROUTER_API_KEY | AGENT_VAULT_OWNER* | AGENT_VAULT_TOKEN* | AGENT_VAULT_PASSWORD* | AGENT_VAULT_ADMIN*)
        [ -z "$value" ] || finding "$1" "$name" secret-variable-name
        ;;
    esac
    case $name in
      https_proxy | HTTPS_PROXY | http_proxy | HTTP_PROXY)
        case $value in *@*) proxy_vars=$((proxy_vars + 1)) ;; *) check_value "$1" "$name" "$value" ;; esac
        ;;
      *) check_value "$1" "$name" "$value" ;;
    esac
  done <"$2"
}

# The environment of this check, which the sandbox exec gave it.
env >"$tmp/env"
scan_env_file env "$tmp/env"
# FORBIDDEN_SHA256 is the only variable that this check adds itself.
[ -z "$forbidden" ] || env_vars=$((env_vars - 1))

# The environment of each process that this user can read.
for environ in "$proc"/[0-9]*/environ; do
  [ -r "$environ" ] || continue
  pid=${environ%/environ}
  pid=${pid##*/}
  tr '\0' '\n' <"$environ" >"$tmp/proc" 2>/dev/null || continue
  processes=$((processes + 1))
  scan_env_file "proc:$pid" "$tmp/proc"
done

# Files that can hold a token.
for file in \
  "${HOME:-/nonexistent}/.netrc" \
  "${HOME:-/nonexistent}/.git-credentials" \
  "${HOME:-/nonexistent}/.config/git/credentials" \
  "${HOME:-/nonexistent}/.gitconfig" \
  "${HOME:-/nonexistent}/.config/git/config" \
  /ctxpipe/home/.netrc \
  /ctxpipe/home/.git-credentials \
  /ctxpipe/home/.gitconfig \
  /etc/gitconfig \
  /ctxpipe/*/.git/config; do
  [ -f "$file" ] && [ -r "$file" ] || continue
  files=$((files + 1))
  case $file in
    */.netrc | */.git-credentials | */credentials)
      [ ! -s "$file" ] || finding file "$file" credential-file
      ;;
  esac
  if grep -Eq -e "$token_pattern|$key_pattern" "$file"; then
    finding file "$file" token-in-file
  fi
  if grep -Eqi 'https?://[^/@[:space:]]+:[^/@[:space:]]+@' "$file"; then
    finding file "$file" url-with-password
  fi
done

# A credential helper in any git config that git reads.
if command -v git >/dev/null 2>&1; then
  git config --show-origin --get-regexp '^credential\.' >"$tmp/helpers" 2>/dev/null || true
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    origin=${line%%[[:space:]]*}
    finding git "${origin#file:}" credential-helper
  done <"$tmp/helpers"
fi

findings=$(grep -c . "$tmp/findings" || true)
cat "$tmp/findings"
printf 'SUMMARY envVars=%s processes=%s files=%s findings=%s proxySessionVars=%s\n' \
  "$env_vars" "$processes" "$files" "$findings" "$proxy_vars"
[ "$findings" -eq 0 ]
