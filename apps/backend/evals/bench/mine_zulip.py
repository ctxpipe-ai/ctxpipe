"""Mine the candidate tasks of the OrgBench Zulip twin (CTX-1664).

The candidates come from what people did after T, in (T, END]: the issues,
pull requests, reviews and comments of the 8 repositories of the twin, and the
public chat after T (`corpus chat` of `../knowledge`, which gives each person
a pseudonym). Each candidate holds the text of its post-T event, the gold that
code can find (files, repositories, rules, records), and the pre-T evidence of
that gold, with its text. `taskset.ts draft` then writes the task from it, and
the judge panel labels it. See README.md, "The Zulip task set".

The GitHub reads go through the gh CLI (`gh api`), one cached file for each
request, so a second run makes no request. The script writes no task: its
output stays local, because it holds the raw text of the events.

Usage (from apps/backend):
  python3 evals/bench/mine_zulip.py --context CLONE --chat CHAT_DIR \
    --cache DIR --out candidates.json
"""

import argparse
import base64
import hashlib
import json
import re
import subprocess
import urllib.parse
from pathlib import Path

BENCH = Path(__file__).resolve().parent
PLAN = json.loads((BENCH.parent / "knowledge" / "fixtures" / "orgbench-zulip-v1.plan.json").read_text())
T = PLAN["cutoff"]
# The end of the window of the post-T events: the day of the mining run.
END = "2026-11-28T00:00:00Z"
SHAS = {repo["source"]: repo["sha"] for repo in PLAN["corpora"][0]["repositories"]}
# A fix with more source files than this is a refactor, not a locate task.
MAX_GOLD_FILES = 6

# Files that are no place to look for a fix: tests, fixtures, generated
# translations, lock files, and the changelog lines that each API change adds.
NOT_SOURCE = re.compile(
    r"(^|/)(tests?|__tests__|fixtures?|snapshots?|locale)(/|$)|(^|/)test_[^/]+$|_test\.\w+$|\.test\.\w+$"
    r"|^api_docs/changelog\.md$|^version\.py$|\.po$|\.lock$|-lock\.(json|yaml)$|^uv\.lock$"
)
# Files that a tool generates: no fix edits them by hand.
GENERATED = re.compile(r"(^|/)locale/|\.po$|\.lock$|-lock\.(json|yaml)$|^uv\.lock$")
# Pull requests that are a release, a translation sync or a dependency bump.
ROUTINE = re.compile(
    r"\b(release|translations?|weblate|locales?|upgrade dependencies|requirements|version:|changelog|updates levels|"
    r"branch cleanup|backport|do not merge)\b",
    re.I,
)
# Contributor guideline pages that bots and templates link in nearly every
# pull request: a citation of them predicts nothing.
TEMPLATE_RULES = {"docs/contributing/index.md", "docs/git/troubleshooting.md"}
MEMBERS = {"MEMBER", "OWNER", "COLLABORATOR"}

# The upstream changes of the impact family (T8a), read by hand from the
# post-T events: the event whose text asks the question, and each repository
# that a post-T follow-up changed or named as needing a change, with that
# follow-up. Code cannot find these: the follow-ups rarely link the upstream
# change in a form that a pattern can read.
IMPACT_SEEDS = [
    {
        "id": "fcm-fid",
        "question": ["https://github.com/zulip/zulip-flutter/issues/2516"],
        "repos": {
            "zulip-flutter": "https://github.com/zulip/zulip-flutter/issues/2516",
            "zulip": "https://chat.zulip.org/#narrow/channel/378/near/2549438",
        },
    },
    {
        "id": "postgresql-14-eol",
        "question": ["https://github.com/zulip/docker-zulip/issues/719"],
        "repos": {
            "docker-zulip": "https://github.com/zulip/docker-zulip/issues/719",
            "zulip": "https://github.com/zulip/docker-zulip/issues/719",
        },
    },
    {
        "id": "mobile-link-previews-docs",
        "question": ["https://github.com/zulip/zulip/pull/40645"],
        "repos": {
            "zulip-flutter": "https://github.com/zulip/zulip-flutter/issues/2449",
            "zulip": "https://github.com/zulip/zulip/pull/40645",
        },
    },
    {
        "id": "server-maintenance-release",
        "question": ["https://github.com/zulip/docker-zulip/issues/721"],
        "repos": {
            "zulip": "https://github.com/zulip/zulip/pull/40713",
            "docker-zulip": "https://github.com/zulip/docker-zulip/pull/720",
        },
    },
]

# Post-T events whose answer exists only after T: the releases after T and
# their contents. The drafter writes the no-answer task (T11) from each one.
NO_ANSWER_SEEDS = [
    "https://github.com/zulip/zulip/issues/40692",
    "https://github.com/zulip/zulip/issues/40704",
    "https://github.com/zulip/docker-zulip/issues/721",
    "https://github.com/zulip/zulip-terminal/issues/1694",
    "https://github.com/zulip/zulip-desktop/pull/1563",
    "https://github.com/zulip/docker-zulip/pull/724",
]


class GitHub:
    """Cached `gh api` reads: one file for each request."""

    def __init__(self, cache: Path):
        self.cache = cache
        cache.mkdir(parents=True, exist_ok=True)

    def get(self, path: str, paginate: bool = False):
        key = hashlib.sha256(f"{path}{paginate}".encode()).hexdigest()[:24]
        file = self.cache / f"{key}.json"
        if file.exists():
            return json.loads(file.read_text())
        args = ["gh", "api", "-H", "Accept: application/vnd.github+json", path]
        if paginate:
            args[2:2] = ["--paginate", "--slurp"]
        out = subprocess.run(args, capture_output=True, text=True, check=False)
        if out.returncode != 0:
            data = None
        else:
            data = json.loads(out.stdout)
            if paginate:
                data = [item for page in data for item in (page if isinstance(page, list) else page.get("items", [page]))]
        file.write_text(json.dumps(data))
        return data


def in_window(time):
    return time is not None and T < time < END


class People:
    """Replace each GitHub login that the mining saw, and each @-mention."""

    def __init__(self):
        self.logins = set()

    def see(self, user):
        if user and user.get("type") == "User" and user.get("login"):
            self.logins.add(user["login"])

    def scrub(self, text: str) -> str:
        text = re.sub(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", "[email]", text)
        text = re.sub(r"@(?:_?\*\*[^*\n]+\*\*|[A-Za-z0-9][\w-]*)", "@[person]", text)
        if self.logins:
            names = sorted(self.logins, key=len, reverse=True)
            pattern = re.compile(r"(?<![\w/-])(" + "|".join(map(re.escape, names)) + r")(?![\w-])", re.I)
            text = pattern.sub("[person]", text)
        return text


class Corpus:
    """The frozen context repo at T: the mirrors, the chat and the repositories."""

    def __init__(self, clone: Path, github: GitHub):
        self.clone = clone
        self.github = github
        self.trees = {}
        for repo, sha in SHAS.items():
            tree = github.get(f"repos/{repo}/git/trees/{sha}?recursive=1") or {}
            self.trees[repo] = {item["path"] for item in tree.get("tree", []) if item["type"] == "blob"}
        self.topics = {}
        for file in (clone / "chat" / "zulip").rglob("*.md"):
            head = frontmatter(file.read_text())
            self.topics[(head["channelId"], head["topic"].lower())] = str(file.relative_to(clone))

    def mirror(self, repo: str, number: int):
        owner, name = repo.split("/")
        issue = self.clone / "github" / "issues" / owner / name / f"{number}.md"
        if issue.exists():
            return str(issue.relative_to(self.clone))
        pulls = self.clone / "github" / "pulls" / owner / name
        for file in pulls.glob(f"{number}--*.md") if pulls.exists() else []:
            return str(file.relative_to(self.clone))
        return None

    def chat_topic(self, link: str):
        match = re.search(r"channel/(\d+)-[\w-]+/topic/([^/\s)>\]]+)", link)
        if not match:
            return None
        name = urllib.parse.unquote(match.group(2).replace(".", "%")).strip()
        return self.topics.get((match.group(1), name.lower()))

    def code(self, repo: str, path: str):
        """`repo:path` when the file exists at T, else None."""
        return f"{repo}:{path}" if path in self.trees.get(repo, ()) else None

    def links(self, text: str, repo: str):
        """The pre-T evidence that `text` links: corpus documents and files at T."""
        found = []
        for link in re.findall(r"https://chat\.zulip\.org/#narrow/[^\s)>\]]+", text):
            topic = self.chat_topic(link)
            if topic:
                found.append(topic)
        for match in re.finditer(
            r"github\.com/zulip/([\w-]+)/(?:issues|pull)/(\d+)|(?<![\w/])zulip/([\w-]+)#(\d+)|(?<![\w/&])#(\d{2,6})\b", text
        ):
            target = f"zulip/{match.group(1) or match.group(3)}" if (match.group(1) or match.group(3)) else repo
            number = int(match.group(2) or match.group(4) or match.group(5))
            doc = self.mirror(target, number) if target in SHAS else None
            if doc:
                found.append(doc)
        for page in re.findall(r"zulip\.readthedocs\.io/en/[\w.-]+/([\w/.-]+?)\.html", text):
            found.append(self.code("zulip/zulip", f"docs/{page}.md"))
        for page in re.findall(r"zulip\.com/help/([\w-]+)", text):
            found.append(self.code("zulip/zulip", f"starlight_help/src/content/docs/{page}.mdx"))
        for page in re.findall(r"zulip\.com/api/([\w-]+)", text):
            found.append(self.code("zulip/zulip", f"api_docs/{page}.md"))
        for target, path in re.findall(r"github\.com/zulip/([\w-]+)/blob/[\w.-]+/([^\s)#?>\]]+)", text):
            found.append(self.code(f"zulip/{target}", path))
        return sorted({item for item in found if item})

    def evidence(self, ref: str):
        """The text of a piece of evidence, with its source kind and URL."""
        if ":" in ref:
            repo, path = ref.split(":", 1)
            data = self.github.get(f"repos/{repo}/contents/{urllib.parse.quote(path)}?ref={SHAS[repo]}") or {}
            text = base64.b64decode(data.get("content", "")).decode("utf-8", "replace")
            kind = "docs" if re.search(r"(^|/)(docs|starlight_help|api_docs|help)/|\.mdx?$", path) else "code"
            url = f"https://github.com/{repo}/blob/{SHAS[repo]}/{path}"
            return {"ref": ref, "kind": kind, "url": url, "text": text}
        text = (self.clone / ref).read_text()
        head = frontmatter(text)
        kind = {"issue": "issues", "pull_request": "pulls", "topic": "chat"}[head["type"]]
        return {"ref": ref, "kind": kind, "url": head["url"], "text": text}


def frontmatter(text: str) -> dict:
    head = text.split("---")[1]
    fields = dict(re.findall(r"^(\w+): (.*)$", head, re.M))
    return {key: value.strip().strip('"').strip("'") for key, value in fields.items()}


def source_files(files, repo, corpus, tests=False):
    """The source files of a change that exist at T, as `repo:path`. With
    `tests`, also its tests, fixtures and changelog files: each file of the
    change that exists at T and that no tool generates."""
    rule = GENERATED if tests else NOT_SOURCE
    gold = [corpus.code(repo, f["filename"]) for f in files if not rule.search(f["filename"])]
    return sorted({item for item in gold if item})


def siblings(gold, corpus, limit=20):
    """Other source files at T in the folders of the gold: the keyword dump
    of the calibration triad lists them with the gold."""
    def near(repo, folder):
        """The other source files of `repo` under `folder`, at any depth."""
        return [
            f"{repo}:{other}" for other in sorted(corpus.trees[repo])
            if other.startswith(folder) and not NOT_SOURCE.search(other) and f"{repo}:{other}" not in gold
        ]

    found = []
    for ref in gold:
        repo, path = ref.split(":", 1)
        # The folder of the file, or a folder above it when that one has
        # fewer than five other files.
        folder = path
        while "/" in folder:
            folder = folder.rsplit("/", 1)[0]
            if len(near(repo, f"{folder}/")) >= 5:
                break
        found += near(repo, f"{folder}/" if "/" in path else "")
    return sorted(set(found))[:limit]


def body_of(item) -> str:
    """The body of an issue or pull request without its template: the
    self-review checklist (a <details> block) and the HTML comments. The
    checklist links the contributor guidelines in each pull request."""
    text = re.sub(r"<!--.*?-->", "", item.get("body") or "", flags=re.S)
    return re.sub(r"<details>.*?</details>", "", text, flags=re.S | re.I).strip()


def github_ref(url: str):
    """The repository and number of an issue or pull request URL."""
    repo, number = re.search(r"github\.com/(zulip/[\w-]+)/(?:issues|pull)/(\d+)", url).groups()
    return repo, int(number)


def closing_issues(text: str):
    return sorted({int(n) for n in re.findall(r"\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b[^\n#]{0,20}#(\d+)", text, re.I)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", type=Path, required=True, help="a clone of the frozen context repo")
    parser.add_argument("--chat", type=Path, required=True, help="the post-T chat of `corpus chat` (DIR/zulip)")
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    github = GitHub(args.cache)
    corpus = Corpus(args.context, github)
    people = People()
    candidates = []

    def add(family, key, base_time, events, titles, text, evidence_refs, gold):
        """Add a candidate. Its text gets the pseudonyms at the end, when the
        mining has seen each login."""
        candidates.append({
            "id": f"zulip-{family.lower()}-{key}",
            "family": family,
            "baseTime": base_time,
            "events": events,
            # The titles of the events: the drafter must not copy them.
            "titles": titles,
            "text": text,
            "evidence": [corpus.evidence(ref) for ref in evidence_refs],
            "gold": gold,
        })

    # The post-T items of each repository, with their comments and reviews.
    items, comments = [], {}
    for repo in SHAS:
        for item in github.get(f"repos/{repo}/issues?state=all&since={T}&per_page=100", paginate=True) or []:
            people.see(item.get("user"))
            if in_window(item["created_at"]) or in_window(item.get("closed_at")):
                item["repo"] = repo
                items.append(item)
        for path in (f"repos/{repo}/issues/comments?since={T}&per_page=100", f"repos/{repo}/pulls/comments?since={T}&per_page=100"):
            for comment in github.get(path, paginate=True) or []:
                people.see(comment.get("user"))
                url = comment.get("issue_url") or comment.get("pull_request_url") or ""
                if in_window(comment["created_at"]) and url:
                    comments.setdefault((repo, int(url.rstrip("/").split("/")[-1])), []).append(comment)
    by_ref = {(item["repo"], item["number"]): item for item in items}

    def issue(repo, number):
        item = by_ref.get((repo, number)) or github.get(f"repos/{repo}/issues/{number}") or {}
        people.see(item.get("user"))
        return {**item, "repo": repo}

    # T1 and T12, locate: a post-T fix of pre-T code. The problem statement is
    # each closed issue opened after T, or else the pull request when it was
    # opened after T: the text of the task is never a pre-T text of the
    # corpus. A closed pre-T issue is evidence. The gold is each source file
    # of the fix that exists at T.
    for item in items:
        if "pull_request" not in item:
            continue
        repo, number = item["repo"], item["number"]
        merged = in_window(item["pull_request"].get("merged_at"))
        if not merged and not in_window(item["created_at"]):
            continue
        if ROUTINE.search(item["title"]):
            continue
        files = github.get(f"repos/{repo}/pulls/{number}/files?per_page=100", paginate=True) or []
        commits = github.get(f"repos/{repo}/pulls/{number}/commits?per_page=100", paginate=True) or []
        # The size limit counts the source files; the gold is each file of the
        # fix that exists at T (plan §4.3), tests too.
        if not 1 <= len(source_files(files, repo, corpus)) <= MAX_GOLD_FILES:
            continue
        gold = source_files(files, repo, corpus, tests=True)
        body = body_of(item)
        messages = "\n".join(c["commit"]["message"] for c in commits)
        closed = [issue(repo, n) for n in closing_issues(body + "\n" + messages)]
        closed = [c for c in closed if c and "pull_request" not in c]
        asked = [c for c in closed if in_window(c["created_at"])]
        if not asked and not in_window(item["created_at"]):
            continue
        problem = "\n\n".join(f"Issue:\n{body_of(c)}" for c in asked) or f"Pull request:\n{body}"
        evidence = corpus.links("\n".join([body, messages, *(body_of(c) for c in closed)]), repo)
        evidence += [doc for doc in (corpus.mirror(repo, c["number"]) for c in closed) if doc]
        evidence = sorted(set(evidence))
        # An unmerged fix is a gold only when it answers an issue of the corpus.
        if not merged and not any(corpus.mirror(repo, c["number"]) for c in closed):
            continue
        family = "T1" if evidence else "T12"
        add(
            family, f"{repo.split('/')[1]}-{number}",
            min(c["created_at"] for c in asked) if asked else item["created_at"],
            [item["html_url"], *(c["html_url"] for c in asked)], [item["title"], *(c["title"] for c in closed)], problem, evidence,
            {"files": gold, "siblings": siblings(gold, corpus), "fixMerged": merged, "fix": f"{body}\n\n{messages}"},
        )

    # T8a, impact: the hand-read upstream changes of IMPACT_SEEDS.
    for seed in IMPACT_SEEDS:
        asked = [issue(*github_ref(url)) for url in seed["question"]]
        # The question must be a post-T text, as each task text is.
        if not all(in_window(item["created_at"]) for item in asked):
            continue
        texts = [body_of(item) for item in asked]
        evidence = {ref for item in asked for ref in corpus.links(body_of(item), item["repo"])}
        # The files at T that each follow-up pull request changed.
        for url in seed["repos"].values():
            if "/pull/" in url:
                repo, number = github_ref(url)
                files = github.get(f"repos/{repo}/pulls/{number}/files?per_page=100", paginate=True) or []
                evidence.update(source_files(files, repo, corpus))
        add(
            "T8a", seed["id"], asked[0]["created_at"], seed["question"], [item["title"] for item in asked],
            "\n\n".join(texts), sorted(evidence), {"repos": sorted(seed["repos"]), "followUps": seed["repos"]},
        )

    # T10a, review prediction: a post-T pull request whose reviewers cited a
    # contributor guideline. The gold is each cited page that exists at T and
    # that is no template.
    for item in items:
        if "pull_request" not in item or not in_window(item["created_at"]):
            continue
        repo, number = item["repo"], item["number"]
        reviews = github.get(f"repos/{repo}/pulls/{number}/reviews?per_page=100", paginate=True) or []
        cited = set()
        for note in [*comments.get((repo, number), []), *reviews]:
            if (note.get("user") or {}).get("type") != "User" or note.get("author_association") not in MEMBERS:
                continue
            if (note.get("user") or {}).get("login") == item["user"]["login"]:
                continue
            for page in re.findall(r"zulip\.readthedocs\.io/en/[\w.-]+/([\w/.-]+?)\.html", note.get("body") or ""):
                ref = corpus.code("zulip/zulip", f"docs/{page}.md")
                if ref and ref.split(":", 1)[1] not in TEMPLATE_RULES:
                    cited.add(ref)
        if not cited:
            continue
        files = github.get(f"repos/{repo}/pulls/{number}/files?per_page=100", paginate=True) or []
        listing = "\n".join(f"{f['filename']} (+{f['additions']} -{f['deletions']})" for f in files)
        add(
            "T10a", f"{repo.split('/')[1]}-{number}", item["created_at"], [item["html_url"]], [item["title"]],
            f"Pull request description:\n{body_of(item)}\n\nChanged files:\n{listing}",
            sorted(cited), {"rules": sorted(cited)},
        )

    # T3, T4 and T11 from the chat after T: the drafter picks the family of
    # each topic, or none. The evidence is what the topic links at T.
    for file in sorted(args.chat.rglob("*.md")):
        text = file.read_text()
        head = frontmatter(text)
        if int(head["messages"]) < 2:
            continue
        add(
            "chat", f"chat-{head['channelId']}-{head['firstMessageId']}", head["firstMessageAt"], [head["url"]],
            [head["topic"]], text, corpus.links(text, "zulip/zulip"), {},
        )

    # T3, why: a post-T pull request or issue whose text points at a pre-T
    # decision record of the corpus (a chat topic or a mirrored issue).
    for item in items:
        if not in_window(item["created_at"]):
            continue
        repo, number = item["repo"], item["number"]
        notes = [c for c in comments.get((repo, number), []) if c.get("author_association") in MEMBERS]
        text = "\n\n".join([body_of(item), *(c.get("body") or "" for c in notes)])
        records = [ref for ref in corpus.links(text, repo) if ref.startswith(("chat/", "github/"))]
        records = [ref for ref in records if ref != corpus.mirror(repo, number)]
        if not records or not re.search(r"\b(discuss|decid|decision|consensus|agreed|design|approv)", text, re.I):
            continue
        add("T3", f"{repo.split('/')[1]}-{number}", item["created_at"], [item["html_url"]], [item["title"]], text, records, {"records": records})

    # T11, no answer: the seeded post-T events about what happened after T.
    for url in NO_ANSWER_SEEDS:
        repo, number = github_ref(url)
        item = issue(repo, number)
        # The title is no leak here: a no-answer task has no gold.
        add("T11", f"{repo.split('/')[1]}-{number}", item["created_at"], [url], [], f"{item['title']}\n\n{body_of(item)}", [], {})

    for candidate in candidates:
        candidate["text"] = people.scrub(candidate["text"])
        candidate["titles"] = [people.scrub(title) for title in candidate["titles"]]
        if "fix" in candidate["gold"]:
            candidate["gold"]["fix"] = people.scrub(candidate["gold"]["fix"])

    args.out.write_text(json.dumps({"T": T, "end": END, "shas": SHAS, "candidates": candidates}, indent=1))
    counts = {}
    for candidate in candidates:
        counts[candidate["family"]] = counts.get(candidate["family"], 0) + 1
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
