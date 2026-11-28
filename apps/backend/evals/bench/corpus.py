"""Build the B1+ corpus of a twin as plain files (OrgBench phase 1, CTX-1664).

The corpus holds the repositories of the twin at their pinned SHAs and the
Markdown of the frozen context repo (issues, pull requests, chat), with no git
history. A scale size pads the repositories with distractor repositories of
other public orgs (distractors.json), or keeps only the first repositories of
the plan. See README.md.

  python corpus.py --twin zulip-v1 [--repos N]   prints the folder to mount
"""

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

BENCH = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache" / "ctxpipe-bench" / "corpus"


def fetch(source, sha, private=False):
    """The tree of one repository at one commit, fetched one time, with no .git."""
    dest = CACHE / "trees" / f"{source.replace('/', '__')}@{sha}"
    if dest.is_dir():
        return dest
    tmp = dest.with_name(dest.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    # The private context repo reads through the gh login; the public
    # repositories need no credential.
    auth = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] if private else []
    git = ["git", *auth, "-C", str(tmp)]
    subprocess.run(["git", "init", "-q", str(tmp)], check=True)
    subprocess.run([*git, "fetch", "-q", "--depth", "1", f"https://github.com/{source}.git", sha], check=True)
    subprocess.run([*git, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], check=True)
    shutil.rmtree(tmp / ".git")
    tmp.rename(dest)
    return dest


def link_tree(source, target):
    """Copy a tree as hard links: a view costs no space."""
    for root, dirs, files in os.walk(source):
        out = target / Path(root).relative_to(source)
        out.mkdir(parents=True, exist_ok=True)
        for name in files:
            src = Path(root) / name
            if src.is_symlink():
                # Keep a link as a link; a link that points out of the corpus reads nothing in the container.
                (out / name).symlink_to(os.readlink(src))
            else:
                os.link(src, out / name)


def repositories(twin, size):
    plan = json.loads((BENCH / twin["plan"]).read_text())
    repos = [r for corpus in plan["corpora"] for r in corpus["repositories"]]
    if size is None or size == len(repos):
        return repos
    if size < len(repos):
        return repos[:size]
    distractors = json.loads((BENCH / "distractors.json").read_text())["repositories"]
    if size - len(repos) > len(distractors):
        raise SystemExit(f"distractors.json has {len(distractors)} repositories, the size needs {size - len(repos)}")
    return repos + distractors[: size - len(repos)]


def build(twin_name, size=None):
    """The corpus folder of the twin at this size; build it when it is missing."""
    twin = json.loads((BENCH / "arms.json").read_text())["twins"][twin_name]
    repos = repositories(twin, size)
    view = CACHE / "views" / f"{twin_name}-r{len(repos)}"
    if view.is_dir():
        return view
    tmp = view.with_name(view.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    names = [r["source"].split("/")[1] for r in repos]
    if len(set(names)) != len(names):
        raise SystemExit("two repositories have the same name")
    for repo, name in zip(repos, names):
        print(f"repo {repo['source']}@{repo['sha'][:8]}", flush=True)
        link_tree(fetch(repo["source"], repo["sha"]), tmp / "repos" / name)
    context = twin["context"]
    tree = fetch(context["repo"], context["sha"], private=True)
    for part in context["paths"]:
        link_tree(tree / part, tmp / part)
    tmp.rename(view)
    return view


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--twin", default="zulip-v1")
    parser.add_argument("--repos", type=int, help="the count of repositories (default: the repositories of the plan)")
    args = parser.parse_args()
    print(build(args.twin, args.repos))
