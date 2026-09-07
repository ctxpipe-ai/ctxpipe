#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/workspace-recovery-baseline.sh \
  --base <merge-base> --head <pr-head> --pr-url <url> \
  --expect-commits <n> --expect-files <n> \
  --expect-additions <n> --expect-deletions <n> \
  --output <new-artifact-directory>

Creates one atomic Gate 0 artifact bundle. Refuses shallow repositories, a base
that is not the actual merge base, mismatched expected PR totals, and an existing
output path.
USAGE
}

base=""
head=""
pr_url=""
expected_commits=""
expected_files=""
expected_additions=""
expected_deletions=""
output=""

while (($#)); do
  case "$1" in
    --base|--head|--pr-url|--expect-commits|--expect-files|--expect-additions|--expect-deletions|--output)
      [[ $# -ge 2 ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      case "$1" in
        --base) base="$2" ;;
        --head) head="$2" ;;
        --pr-url) pr_url="$2" ;;
        --expect-commits) expected_commits="$2" ;;
        --expect-files) expected_files="$2" ;;
        --expect-additions) expected_additions="$2" ;;
        --expect-deletions) expected_deletions="$2" ;;
        --output) output="$2" ;;
      esac
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

for value in base head pr_url expected_commits expected_files expected_additions expected_deletions output; do
  [[ -n "${!value}" ]] || { usage >&2; exit 2; }
done
for value in expected_commits expected_files expected_additions expected_deletions; do
  [[ "${!value}" =~ ^[0-9]+$ ]] || { printf '%s must be a non-negative integer\n' "$value" >&2; exit 2; }
done
[[ ! -e "$output" ]] || { printf 'Output already exists: %s\n' "$output" >&2; exit 2; }

if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  cat >&2 <<'SHALLOW'
Gate 0 baseline refused: this repository is shallow.
Fetch the complete PR head and base branch before recording scope, for example:
  git fetch --unshallow origin
  git fetch origin main refs/pull/280/head
SHALLOW
  exit 3
fi

command -v gh >/dev/null || { printf 'Gate 0 baseline requires the GitHub CLI.\n' >&2; exit 2; }
command -v jq >/dev/null || { printf 'Gate 0 baseline requires jq.\n' >&2; exit 2; }
base_sha="$(git rev-parse --verify "${base}^{commit}")"
head_sha="$(git rev-parse --verify "${head}^{commit}")"
merge_base="$(git merge-base "$base_sha" "$head_sha")"
[[ "$merge_base" == "$base_sha" ]] || {
  printf 'Gate 0 baseline refused: --base must be the PR merge base.\nProvided: %s\nActual:   %s\n' "$base_sha" "$merge_base" >&2
  exit 4
}

output_parent="$(dirname "$output")"
output_name="$(basename "$output")"
mkdir -p "$output_parent"
staging="$(mktemp -d "$output_parent/.${output_name}.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
manifest="$staging/changed-files.txt"
if [[ "$pr_url" =~ ^https://github\.com/([^/]+)/([^/]+)/pull/([0-9]+)$ ]]; then
  pr_owner="${BASH_REMATCH[1]}"
  pr_repo="${BASH_REMATCH[2]}"
  pr_number="${BASH_REMATCH[3]}"
else
  printf 'Unsupported GitHub pull request URL: %s\n' "$pr_url" >&2
  exit 2
fi
gh pr view "$pr_url" \
  --json additions,deletions,changedFiles,headRefOid,url \
  >"$staging/github-pr.json"
read -r gh_url gh_head gh_files gh_additions gh_deletions < <(
  jq -r '[.url, .headRefOid, .changedFiles, .additions, .deletions] | @tsv' \
    "$staging/github-pr.json"
)
gh api graphql \
  -f owner="$pr_owner" \
  -f repo="$pr_repo" \
  -F number="$pr_number" \
  -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){commits{totalCount}}}}' \
  >"$staging/github-pr-commit-count.json"
gh_commits="$(
  jq -r '.data.repository.pullRequest.commits.totalCount' \
    "$staging/github-pr-commit-count.json"
)"
[[ "$gh_url" == "$pr_url" ]] || { printf 'GitHub returned a different PR URL: %s\n' "$gh_url" >&2; exit 5; }
[[ "$gh_head" == "$head_sha" ]] || { printf 'PR head mismatch: local %s, GitHub %s\n' "$head_sha" "$gh_head" >&2; exit 5; }

git diff --name-only -z "$base_sha...$head_sha" \
  | while IFS= read -r -d '' path; do
      if [[ "$path" == *$'\n'* || "$path" == *$'\t'* ]]; then
        printf 'Gate 0 baseline refuses paths containing tabs or newlines: %q\n' "$path" >&2
        exit 6
      fi
      printf '%s\n' "$path"
    done \
  | sort >"$manifest"
commit_count="$(git rev-list --count "$base_sha..$head_sha")"
changed_files="$(wc -l <"$manifest" | tr -d ' ')"
read -r additions deletions < <(
  git diff --numstat "$base_sha...$head_sha" \
    | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { add += $1; del += $2 } END { print add + 0, del + 0 }'
)

mismatch=0
for actual_expected in \
  "$commit_count:$expected_commits:calculated commits" \
  "$changed_files:$expected_files:calculated files" \
  "$additions:$expected_additions:calculated additions" \
  "$deletions:$expected_deletions:calculated deletions" \
  "$gh_commits:$expected_commits:GitHub commits" \
  "$gh_files:$expected_files:GitHub files" \
  "$gh_additions:$expected_additions:GitHub additions" \
  "$gh_deletions:$expected_deletions:GitHub deletions"; do
  IFS=: read -r actual expected label <<<"$actual_expected"
  if [[ "$actual" != "$expected" ]]; then
    printf 'PR total mismatch for %s: calculated %s, expected %s\n' "$label" "$actual" "$expected" >&2
    mismatch=1
  fi
done
((mismatch == 0)) || exit 5

repair_commits="$(git log --format='%s' "$base_sha..$head_sha" | awk '
  {
    value = tolower($0)
    if (value ~ /(^|[^[:alnum:]_])(fix(e[ds])?|restore[ds]?|recover(ed|y)?|retr(y|ied)|re-apply|retrigger(ed)?|regress(ion)?|typecheck)($|[^[:alnum:]_])/) count++
  }
  END { print count + 0 }
')"

awk -F/ '
  /^apps\// || /^packages\// || /^examples\// { print $1 "/" $2; next }
  /^\.ai\// { print ".ai"; next }
  /^\.cursor\// { print ".cursor"; next }
  /^\.github\// { print ".github"; next }
  /^[^\/]+$/ { print "."; next }
  { print $1 }
' "$manifest" | sort -u >"$staging/affected-surfaces.txt"
if rg -qx '\.' "$staging/affected-surfaces.txt"; then
  git ls-tree -d --name-only "$head_sha" -- apps/ packages/ examples/ \
    >>"$staging/affected-surfaces.txt"
  sort -u -o "$staging/affected-surfaces.txt" "$staging/affected-surfaces.txt"
fi

printf 'path\tkind\thas_play\tclassification\towner\tevidence\n' >"$staging/test-classification.tsv"
while IFS= read -r surface; do
  git ls-tree -r --name-only "$head_sha" -- "$surface"
done <"$staging/affected-surfaces.txt" \
  | awk '/\.(test|spec|stories)\.(ts|tsx|js|jsx)$/ { print }' \
  | sort -u | while IFS= read -r path; do
  kind="test"
  has_play="n/a"
  case "$path" in
    *.stories.ts|*.stories.tsx|*.stories.js|*.stories.jsx)
      kind="story"
      if git show "$head_sha:$path" | rg '(^|[^[:alnum:]_])play[[:space:]]*[:=]' >/dev/null; then has_play="yes"; else has_play="no"; fi
      ;;
  esac
  printf '%s\t%s\t%s\tUNCLASSIFIED\tUNASSIGNED\t\n' "$path" "$kind" "$has_play"
done >>"$staging/test-classification.tsv"

{
  printf 'tool\tversion\n'
  printf 'git\t%s\n' "$(git --version)"
  printf 'bash\t%s\n' "${BASH_VERSION}"
  printf 'gh\t%s\n' "$(gh --version | awk 'NR == 1')"
  if command -v node >/dev/null; then printf 'node\t%s\n' "$(node --version)"; fi
  if command -v pnpm >/dev/null; then printf 'pnpm\t%s\n' "$(pnpm --version)"; fi
  if command -v bun >/dev/null; then printf 'bun\t%s\n' "$(bun --version)"; fi
  printf 'jq\t%s\n' "$(jq --version)"
} >"$staging/environment.tsv"

cat >"$staging/evidence.tsv" <<'EVIDENCE'
area	command	exit_code	artifact	environment	repetitions	status
install	UNRECORDED					MISSING
typecheck	UNRECORDED					MISSING
builds	UNRECORDED					MISSING
tests	UNRECORDED					MISSING
storybook_interactions	UNRECORDED					MISSING
migrate_fresh	UNRECORDED					MISSING
migrate_upgrade	UNRECORDED					MISSING
golden_journey	UNRECORDED					MISSING
latency	UNRECORDED					MISSING
flake_rate	UNRECORDED					MISSING
adversarial_review	UNRECORDED					MISSING
remote_checkpoint	UNRECORDED					MISSING
EVIDENCE

{
  printf '# Gate 0 — Git-backed Workspaces baseline\n\n'
  printf 'Generated by `scripts/workspace-recovery-baseline.sh`.\n\n'
  printf '## Identity and fixed points\n\n'
  printf -- '- PR: <%s>\n' "$pr_url"
  printf -- '- Base: `%s` (`%s`)\n' "$base" "$base_sha"
  printf -- '- Head: `%s` (`%s`)\n' "$head" "$head_sha"
  printf -- '- Merge base: `%s`\n\n' "$merge_base"
  printf '## Reconciled authoritative scope\n\n'
  printf '| Measure | Calculated | Expected |\n| --- | ---: | ---: |\n'
  printf '| Commits | %s | %s |\n' "$commit_count" "$expected_commits"
  printf '| Changed files | %s | %s |\n' "$changed_files" "$expected_files"
  printf '| Additions | %s | %s |\n' "$additions" "$expected_additions"
  printf '| Deletions | %s | %s |\n' "$deletions" "$expected_deletions"
  printf '| Repair-loop commit subjects | %s | n/a |\n\n' "$repair_commits"
  printf 'Binary changes are listed in `changed-files.txt` but excluded from numeric line totals. Paths containing tabs or newlines are rejected because the human-review TSV/line manifests cannot represent them safely.\n\n'
  printf '## Bundle artifacts\n\n'
  printf -- '- `github-pr.json`: primary-source PR metadata captured by GitHub CLI.\n'
  printf -- '- `github-pr-commit-count.json`: uncapped GraphQL `commits.totalCount`.\n'
  printf -- '- `changed-files.txt`: complete sorted three-dot scope manifest.\n'
  printf -- '- `affected-surfaces.txt`: affected app/package/example/root surfaces.\n'
  printf -- '- `test-classification.tsv`: every tracked test and story at the PR head under an affected directory; all rows must be classified as `proof`, `characterization`, or `redundant`.\n'
  printf -- '- `environment.tsv`: captured tool versions for reproducing evidence.\n'
  printf -- '- `evidence.tsv`: exact commands, exit codes, artifacts, tool environment, repetitions, and completion status.\n\n'
  printf '## Affected surfaces\n\n```text\n'
  cat "$staging/affected-surfaces.txt"
  printf '```\n\n'
  for section_spec in \
    'Design and decision files:^(.ai/|docs/)' \
    'Schemas and migrations:(schema|migration)' \
    'Routes, workflows, and workers:(routes/|workflow|worker)' \
    'Build, CI, and deployment:(^Dockerfile$|/Dockerfile$|^docker-compose|^.github/|infra/|package.json$|pnpm-lock.yaml$|turbo.json$)'; do
    title="${section_spec%%:*}"
    pattern="${section_spec#*:}"
    printf '## %s\n\n```text\n' "$title"
    { rg -N "$pattern" "$manifest" || true; }
    printf '```\n\n'
  done
  printf '## Most changed non-generated files\n\n'
  printf '| Churn | Added | Deleted | File |\n| ---: | ---: | ---: | --- |\n'
  git diff --numstat "$base_sha...$head_sha" \
    | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 !~ /migrations\/.*snapshot\.json$/ { print $1 + $2, $1, $2, $3 }' \
    | sort -nr \
    | awk 'NR <= 30 { churn=$1; add=$2; del=$3; $1=$2=$3=""; sub(/^   /, "", $0); printf "| %s | %s | %s | `%s` |\n", churn, add, del, $0 }'
  printf '\n## Completion rules\n\n'
  printf -- '- Every `UNCLASSIFIED` and `UNASSIGNED` test row must be resolved.\n'
  printf -- '- Every evidence row must contain an exact command, exit code, artifact/log, environment/tool versions, repetitions where applicable, and final status.\n'
  printf -- '- The adversarial review and verified GitHub checkpoint are mandatory evidence rows.\n'
} >"$staging/baseline.md"

mv "$staging" "$output"
trap - EXIT
printf 'Wrote atomic Gate 0 bundle %s\n' "$output"
