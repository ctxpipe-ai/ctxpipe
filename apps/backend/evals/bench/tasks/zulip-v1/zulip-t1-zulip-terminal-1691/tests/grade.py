"""The verifier of an OrgBench task (CTX-1664): score an answer against gold.json.

`taskset.ts build` copies this file into the tests folder of each task, because
Harbor copies only the task folder into the container. The grader of a task
(`grader` in gold.json) is one of:

- `file-set-f1`, `repo-set-f1`, `rule-set-f1`: the F1 of the files, the
  repositories or the guideline pages that the answer names, against the gold
  set. The answer names them in its list section (`## Files`,
  `## Repositories`, `## Rules`); with no such section, the whole answer counts.
- `abstention`: 1 when the first line of the answer is `NO ANSWER`, else 0.
- `citations-and-claims` (T3): half the citation score, half the claims rubric.
- `claims` (T4): the claims rubric.

The claims rubric needs the judge panel, which has no place in the container
(the verifier has no network). For those graders this verifier writes the
part that code can score, the answer, and `needsPanel: true`; `taskset.ts
judge` then scores the answer on the host. run.py refuses a claims task until
the recorder runs that judge.

In the container, the answer is /app/answer.md, or the final text of the Claude
Code run when the agent wrote no such file. On the host:
  python3 grade.py gold.json --answer FILE   (prints the result as JSON)
"""

import json
import re
import sys
from pathlib import Path

SECTIONS = {"file-set-f1": "files", "repo-set-f1": "repositories", "rule-set-f1": "rules"}
EXTENSIONS = "py|pyi|ts|tsx|js|jsx|cjs|mjs|dart|kt|swift|java|md|mdx|css|scss|html|hbs|json|yaml|yml|toml|sh|txt|cfg|ini|conf|pp|erb|j2|xml|svg|sql|lock"


def container_answer() -> tuple[str, str]:
    """The answer of a run, and where it came from."""
    path = Path("/app/answer.md")
    if path.is_file():
        return path.read_text(errors="replace"), "answer.md"
    stream = Path("/logs/agent/claude-code.txt")
    if stream.is_file():
        for line in reversed(stream.read_text(errors="replace").splitlines()):
            if line.startswith("{") and '"type":"result"' in line.replace(" ", ""):
                return json.loads(line).get("result") or "", "result event"
    return "", "none"


def section(text: str, name: str) -> str | None:
    """The lines under the heading `name` (any level), up to the next heading."""
    match = re.search(rf"^#+\s*{name}\s*$(.*?)(?=^#+\s|\Z)", text, re.I | re.M | re.S)
    return match.group(1) if match else None


def file_items(text: str, repos: list[str], listed: bool) -> set[tuple[str | None, str]]:
    """The files that `text` names, as (repository or None, path). In a list
    section (`listed`), the first word of each line is one file, also a file
    with no extension (`docs/THIRDPARTY`); in prose, each word that looks
    like a path."""
    names = "|".join(sorted(map(re.escape, repos), key=len, reverse=True))
    if listed:
        tokens = [m.group(1) for m in re.finditer(r"^[\s>*+\-\d.)]*`?([^\s`]+)", text, re.M)]
    else:
        tokens = re.findall(r"[\w@~/.:-]*[\w-]\.[A-Za-z][\w]*\b", text)
    items = set()
    for token in tokens:
        token = token.strip(".,;:`*")
        url = re.search(rf"github\.com/zulip/({names})/(?:blob|tree)/[^/]+/(.+)", token)
        mounted = re.search(rf"repos/({names})/(.+)", token)
        prefixed = re.match(rf"(?:zulip/)?({names}):(.+)", token)
        if url or mounted or prefixed:
            repo, path = (url or mounted or prefixed).groups()
        elif "/" in token or "." in token:
            repo, path = None, token.lstrip("./")
        else:
            continue
        # A word with a dot ("e.g") is no file: a file has a folder or a
        # known extension.
        if not listed and "/" not in path and not re.search(rf"\.(?:{EXTENSIONS})$", path):
            continue
        # A link keeps a line anchor (`#L42`) and the end of its Markdown.
        items.add((repo, re.split(r"[#)\]]", path)[0]))
    return items


def repo_items(text: str, repos: list[str], listed: bool) -> set[str]:
    """The repositories that `text` names. In a list section, each line is one
    repository, also a name that is not of the org (it counts against the
    precision); in prose, each name of the org."""
    if listed:
        lines = (m.group(1) for m in re.finditer(r"^[\s>*+\-\d.)]*`?([^\s`]+)", text, re.M))
        return {line.strip(".,;:`*").removeprefix("zulip/") for line in lines}
    names = "|".join(sorted(map(re.escape, repos), key=len, reverse=True))
    return {m.group(1) for m in re.finditer(rf"(?<![\w-])(?:zulip/)?({names})(?![\w-])", text)}


def rule_items(text: str) -> set[str]:
    """The guideline pages that `text` names, as `docs/<page>.md`."""
    items = set()
    for page in re.findall(r"readthedocs\.io/en/[\w.-]+/([\w/.-]+?)\.html", text):
        items.add(f"docs/{page}.md")
    for page in re.findall(r"(?<![\w/])(?:docs/)?((?:contributing|git|production|subsystems|tutorials|testing|documentation|development|overview|webhooks)/[\w.-]+?)(?:\.md|\.html)?(?=[\s)`#,;:]|$)", text, re.M):
        items.add(f"docs/{page}.md")
    return items


def citation_items(text: str) -> set[str]:
    """The issues, pull requests and chat topics that `text` cites, as keys."""
    keys = set()
    for repo, number in re.findall(r"github\.com/zulip/([\w-]+)/(?:issues|pull)/(\d+)", text):
        keys.add(f"gh:{repo}#{number}")
    for repo, number in re.findall(r"github/(?:issues|pulls)/zulip/([\w-]+)/(\d+)(?:--\d+)?\.md", text):
        keys.add(f"gh:{repo}#{number}")
    for channel, first in re.findall(r"chat/zulip/(\d+)/(\d+)\.md", text):
        keys.add(f"czo:{channel}/{first}")
    for message in re.findall(r"chat\.zulip\.org/#narrow/[^\s)]*?/(?:near|with)/(\d+)", text):
        keys.add(f"czo-msg:{message}")
    for channel, topic in re.findall(r"chat\.zulip\.org/#narrow/channel/(\d+)[\w-]*/topic/([^/\s)]+)", text):
        keys.add(f"czo-topic:{channel}/{topic_key(topic)}")
    return keys


def topic_key(encoded: str) -> str:
    """A topic of a Zulip narrow URL, in a form that its name gives too."""
    from urllib.parse import unquote

    return re.sub(r"\s+", " ", unquote(encoded.replace(".", "%"))).strip().lower()


def f1(predicted: int, matched: int, gold: int) -> float:
    # A name with no repository can match a gold file of two repositories;
    # it is still one prediction.
    matched = min(matched, predicted)
    if predicted == 0 or matched == 0:
        return 0.0
    precision, recall = matched / predicted, matched / gold
    return 2 * precision * recall / (precision + recall)


def abstained(text: str) -> bool:
    first = next((line for line in text.splitlines() if line.strip()), "")
    return re.sub(r"[#*_`>\s]", "", first).upper().startswith("NOANSWER")


def grade(gold: dict, text: str) -> dict:
    grader = gold["grader"]
    if grader == "abstention":
        return {"reward": 1.0 if abstained(text) else 0.0, "abstained": abstained(text)}
    if abstained(text):
        return {"reward": 0.0, "abstained": True, "needsPanel": False}
    if grader in SECTIONS:
        listed = section(text, SECTIONS[grader])
        scope = text if listed is None else listed
        gold_items = gold["items"]
        if grader == "file-set-f1":
            named = file_items(scope, gold["repos"], listed is not None)
            # A path with no known repository can still start with the
            # repository name (`zulip/web/src/x.ts`, or `zulip/web:src/x.ts`).
            matched = {
                item for item in gold_items
                if any(
                    path == item.split(":", 1)[1] and repo in (None, item.split(":", 1)[0])
                    or repo is None and path.replace(":", "/") == item.replace(":", "/", 1)
                    for repo, path in named
                )
            }
            predicted = {f"{repo}:{path}" if repo else path for repo, path in named}
        elif grader == "repo-set-f1":
            predicted = repo_items(scope, gold["repos"], listed is not None)
            matched = predicted & set(gold_items)
        else:
            predicted = rule_items(scope)
            matched = predicted & set(gold_items)
        return {
            "reward": round(f1(len(predicted), len(matched), len(gold_items)), 4),
            "predicted": sorted(predicted),
            "matched": sorted(matched),
        }
    # The citation part of T3: the recall of the gold records, with a cap on
    # the citations that do not count against it (two more than the gold).
    cited = citation_items(text)
    found = [c for c in gold.get("citations", []) if cited & set(c["aliases"])]
    hits = {alias for c in found for alias in c["aliases"]} & cited
    extra = len(cited - hits)
    recall = len(found) / len(gold["citations"]) if gold.get("citations") else 0.0
    citation = recall * min(1.0, (len(gold.get("citations", [])) + 2) / max(1, len(found) + extra))
    result = {"citation": round(citation, 4), "cited": sorted(cited), "needsPanel": True}
    # The reward before the panel: the part that code can score.
    result["reward"] = round(citation / 2, 4) if grader == "citations-and-claims" else 0.0
    return result


def main() -> None:
    gold = json.loads(Path(sys.argv[1]).read_text())
    if "--answer" in sys.argv:
        text = Path(sys.argv[sys.argv.index("--answer") + 1]).read_text(errors="replace")
        print(json.dumps(grade(gold, text)))
        return
    text, source = container_answer()
    result = {"answer_source": source, "answer_chars": len(text), **grade(gold, text)}
    # The host judge reads the answer from here: Harbor keeps the logs of
    # the verifier, not the workspace of the agent.
    if result.get("needsPanel"):
        result["answer"] = text
    out = Path("/logs/verifier")
    out.mkdir(parents=True, exist_ok=True)
    (out / "reward.txt").write_text(f"{result['reward']:.4f}\n")
    (out / "facts.json").write_text(json.dumps(result, indent=2))
    print(f"reward {result['reward']:.4f}")


if __name__ == "__main__":
    main()
