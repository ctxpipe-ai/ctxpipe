import { describe, expect, it } from "vitest"
import { derivePendingGithubRepos } from "./pendingGithubRepos"

const connectedGithubRepos = [
  {
    id: 1,
    full_name: "acme/selected-indexing",
    html_url: "https://github.com/acme/selected-indexing",
    clone_url: "https://github.com/acme/selected-indexing.git",
    name: "selected-indexing",
  },
  {
    id: 2,
    full_name: "acme/selected-pending",
    html_url: "https://github.com/acme/selected-pending",
    clone_url: "https://github.com/acme/selected-pending.git",
    name: "selected-pending",
  },
  {
    id: 3,
    full_name: "acme/unselected",
    html_url: "https://github.com/acme/unselected",
    clone_url: "https://github.com/acme/unselected.git",
    name: "unselected",
  },
]

describe("derivePendingGithubRepos", () => {
  it("select mode only shows saved selected repos that are not already in the repository list", () => {
    const result = derivePendingGithubRepos({
      connectedGithubRepos,
      savedSetupRepos: [
        {
          name: "acme/selected-indexing",
          gitUrl: "https://github.com/acme/selected-indexing.git",
        },
        {
          name: "acme/selected-pending",
          gitUrl: "https://github.com/acme/selected-pending.git",
        },
      ],
      existingGitUrls: new Set([
        "https://github.com/acme/selected-indexing.git",
      ]),
      setupData: {
        ingestAllRepositories: false,
        includeFutureRepos: false,
        savedRepositories: [
          {
            name: "acme/selected-indexing",
            gitUrl: "https://github.com/acme/selected-indexing.git",
          },
          {
            name: "acme/selected-pending",
            gitUrl: "https://github.com/acme/selected-pending.git",
          },
        ],
      },
      setupPending: false,
    })

    expect(result.pendingConnectedGithubRepos).toEqual([])
    expect(result.pendingSavedSetupRepos).toEqual([
      {
        name: "acme/selected-pending",
        gitUrl: "https://github.com/acme/selected-pending.git",
      },
    ])
  })

  it("all mode shows accessible GitHub repos that are not already in the repository list", () => {
    const result = derivePendingGithubRepos({
      connectedGithubRepos,
      savedSetupRepos: [],
      existingGitUrls: new Set([
        "https://github.com/acme/selected-indexing.git",
      ]),
      setupData: {
        ingestAllRepositories: true,
        includeFutureRepos: false,
        savedRepositories: [],
      },
      setupPending: false,
    })

    expect(
      result.pendingConnectedGithubRepos.map((repo) => repo.full_name),
    ).toEqual(["acme/selected-pending", "acme/unselected"])
    expect(result.pendingSavedSetupRepos).toEqual([])
  })

  it("suppresses preview pending rows while setup state is still loading", () => {
    const result = derivePendingGithubRepos({
      connectedGithubRepos,
      savedSetupRepos: [],
      existingGitUrls: new Set(),
      setupData: undefined,
      setupPending: true,
    })

    expect(result.pendingConnectedGithubRepos).toEqual([])
    expect(result.pendingSavedSetupRepos).toEqual([])
  })
})
