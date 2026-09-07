#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/workspace-recovery-baseline.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.name Test
git -C "$repo" config user.email test@example.com
mkdir -p "$repo/apps/ui/src" "$repo/apps/backend/src"
printf 'export const backend = true\n' >"$repo/apps/backend/src/unmodified.test.ts"
printf 'base\n' >"$repo/apps/ui/src/file.ts"
git -C "$repo" add .
git -C "$repo" commit -qm base
base="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" switch -qc feature
printf 'root\n' >"$repo/README.md"
printf 'export const Scenario = { play: async () => {} }\n' >"$repo/apps/ui/src/file.stories.tsx"
git -C "$repo" add .
git -C "$repo" commit -qm 'change 1'
for number in $(seq 2 465); do
  printf '%s\n' "$number" >>"$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm "change $number"
done
head="$(git -C "$repo" rev-parse HEAD)"

mkdir -p "$repo/apps/ui/dist"
printf "generated test\n" >"$repo/apps/ui/dist/generated.test.ts"
printf "untracked test\n" >"$repo/apps/ui/src/untracked.test.ts"

mkdir "$tmp/bin"
call_log="$tmp/gh-calls.log"
export GH_CALL_LOG="$call_log"
cat >"$tmp/bin/gh" <<GH
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"\$GH_CALL_LOG"
if [[ "\${1:-}" == "--version" ]]; then
  printf 'gh version fixture\n'
elif [[ "\${1:-}" == "api" ]]; then
  [[ " \$* " == *" graphql "* ]]
  [[ " \$* " == *"commits{totalCount}"* ]]
  if [[ " \$* " == *" --jq "* ]]; then printf '465\n'; else printf '{"data":{"repository":{"pullRequest":{"commits":{"totalCount":465}}}}}\n'; fi
elif [[ " \$* " == *" --jq "* ]]; then
  printf 'https://github.com/acme/repo/pull/1\\t$head\\t2\\t466\\t0\\n'
else
  printf '{"url":"https://github.com/acme/repo/pull/1","headRefOid":"$head","changedFiles":2,"additions":466,"deletions":0}\n'
fi
GH
chmod +x "$tmp/bin/gh"

(
  cd "$repo"
  PATH="$tmp/bin:$PATH" "$script" \
    --base "$base" \
    --head HEAD \
    --pr-url https://github.com/acme/repo/pull/1 \
    --expect-commits 465 \
    --expect-files 2 \
    --expect-additions 466 \
    --expect-deletions 0 \
    --output gate0
)

for artifact in baseline.md github-pr.json github-pr-commit-count.json changed-files.txt affected-surfaces.txt test-classification.tsv evidence.tsv environment.tsv; do
  test -f "$repo/gate0/$artifact"
done
# Inventory the two tracked sources exactly once, independent of untracked output.
test "$(wc -l <"$repo/gate0/test-classification.tsv" | tr -d ' ')" -eq 3
! rg -q 'generated.test|untracked.test|^\./' "$repo/gate0/test-classification.tsv"
test "$(rg -c '^pr view ' "$call_log")" -eq 1
test "$(rg -c '^api graphql ' "$call_log")" -eq 1
rg -q -- '- `evidence.tsv`: exact commands' "$repo/gate0/baseline.md"
rg -q $'apps/ui/src/file.stories.tsx\tstory\tyes\tUNCLASSIFIED' "$repo/gate0/test-classification.tsv"
# A root build-graph change conservatively inventories unmodified tests in every workspace.
rg -q $'apps/backend/src/unmodified.test.ts\ttest\tn/a\tUNCLASSIFIED' "$repo/gate0/test-classification.tsv"
rg -q $'^\\.$' "$repo/gate0/affected-surfaces.txt"
rg -q $'gh\tgh version fixture' "$repo/gate0/environment.tsv"
rg -q '\| Commits \| 465 \| 465 \|' "$repo/gate0/baseline.md"

: >"$call_log"
set +e
(
  cd "$repo"
  PATH="$tmp/bin:$PATH" "$script" \
    --base "$base" --head HEAD \
    --pr-url https://github.com/acme/repo/pull/1 \
    --expect-commits 100 --expect-files 2 \
    --expect-additions 466 --expect-deletions 0 \
    --output mismatch
) >/dev/null 2>"$tmp/mismatch.err"
status=$?
set -e
test "$status" -eq 5
test ! -e "$repo/mismatch"
rg -q 'GitHub commits' "$tmp/mismatch.err"

newline_repo="$tmp/newline-repo"
mkdir -p "$newline_repo"
git -C "$newline_repo" init -q -b main
git -C "$newline_repo" config user.name Test
git -C "$newline_repo" config user.email test@example.com
git -C "$newline_repo" commit -q --allow-empty -m base
newline_base="$(git -C "$newline_repo" rev-parse HEAD)"
printf 'unsafe\n' >"$newline_repo/line
break.ts"
git -C "$newline_repo" add .
git -C "$newline_repo" commit -qm change
newline_head="$(git -C "$newline_repo" rev-parse HEAD)"
sed "s/$head/$newline_head/g; s/\\\\t2\\\\t466/\\\\t1\\\\t1/g; s/\"changedFiles\":2/\"changedFiles\":1/; s/\"additions\":466/\"additions\":1/" "$tmp/bin/gh" >"$tmp/bin/gh-newline"
chmod +x "$tmp/bin/gh-newline"
mv "$tmp/bin/gh" "$tmp/bin/gh-main"
ln -s gh-newline "$tmp/bin/gh"
set +e
(
  cd "$newline_repo"
  PATH="$tmp/bin:$PATH" "$script" \
    --base "$newline_base" --head HEAD \
    --pr-url https://github.com/acme/repo/pull/1 \
    --expect-commits 1 --expect-files 1 \
    --expect-additions 1 --expect-deletions 0 \
    --output unsafe
) >/dev/null 2>"$tmp/newline.err"
status=$?
set -e
test "$status" -eq 6
test ! -e "$newline_repo/unsafe"
rg -q 'refuses paths containing tabs or newlines' "$tmp/newline.err"

printf 'workspace recovery baseline fixtures passed\n'
