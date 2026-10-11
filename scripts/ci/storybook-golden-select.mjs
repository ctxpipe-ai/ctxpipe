export const requiredStories = [
  "LateErrorDoesNotClobberSuccess",
  "FirstTurnStreamsLive",
  "FirstTurnFailureRestoresDraft",
  "SocketCleansUpOnLeave",
  "ReloadReconnects",
  "RapidRouteChanges",
  "EditThenNavigate",
  "OutOfOrderSaves",
  "NewFileKeepsTypedText",
  "DraftSavedShowsFile",
  "DraftRevertedShowsFile",
  "PierreKeyboardFocus",
  "SharedPublishPending",
  "PublishErrorsToast",
  "SingleCreatePr",
  "SingleCreatePrPaneClosed",
  "DiffTriggerPaneClosed",
  "DiffTabRoundedCorner",
  "CreatePrMatchesPaneTriggers",
  "ShowPr",
  "MaximizedPaneMatchesHeader",
  "SelectedTabInView",
  "ConversationSandboxFiles",
  "ConversationMaximizedSync",
  "StableRequestBudget",
  "StableFilesRequestBudget",
  "DeletedFileStaysUntilMerged",
  "ChangeMarkers",
  "NodesWithoutRelationships",
  "GraphPhasePending",
  "GraphPhaseFailed",
  "GraphPhaseReadyStoreUnavailable",
  "NoWebGL",
  "GraphLostRebuilds",
  "TriggersGraphBuilding",
  "PrepareReadingKnowledge",
  "PrepareWaitingForTip",
  "PrepareFailed",
  "PreparePendingWithError",
  "FailedTouchIsCaught",
  "OrgGateTryAgainLoads",
  "LoadingUnderReducedMotion",
  "DoubleClickMovesOneSlide",
  "ChatProgressDone",
  "ChatProgressLogExpanded",
  "DiffPaneEmpty",
  "DiffPaneManyFiles",
  "DiffPaneExpandedFile",
  "DiffPaneLongPaths",
  "DiffPaneRenamedAndOmitted",
  "DiffPaneTurnGone",
  "TurnCardCollapsed",
  "TurnCardExpanded",
  "TurnCardOpensDiff",
  "WaitsForDelay",
  "FastLoadSkipsSkeleton",
  "VisibleSkeletonHoldsMinimum",
  "SuspenseHoldsMinimum",
  "RecentCommitsSkeletonMatches",
  "HeatmapSkeletonMatches",
  "ConnectorRowSkeletonMatches",
  "ConversationListSkeletonMatches",
  "SurfaceSkeletonMatches",
  "DelayStartsAtFirstPaint",
  "HandOverStaysVisible",
  "HandOverKeepsDelayStart",
  "UnrelatedLoadKeepsItsDelay",
  "HandOverHoldsMinimum",
  "HandOverUsesPaintStart",
  "UsedInLinksToSourceSection",
  "SeveralProviders",
  "ScrollsToSourceAnchor",
  "EditSendsChange",
  "ReadOnlyHidesChanges",
  "DirectCommitQueued",
  "PickerShowsConnectionNames",
  "ChooseWorkspacesMulti",
  "SelectAllPagesOfASpace",
  "EditsASavedPageList",
]

export function isGoldenPlaySuccess(phase) {
  return phase === "played"
}

export function selectGoldenStories(index) {
  const entries = Object.values(index.entries ?? {})
  return requiredStories.map((name) => {
    const story = entries.find(
      (entry) =>
        entry.exportName === name &&
        (entry.tags ?? []).includes("workspace-golden"),
    )
    if (!story) throw new Error(`Missing tagged golden story ${name}`)
    if (!(story.tags ?? []).includes("play-fn"))
      throw new Error(
        `${name} is tagged workspace-golden but has no play function`,
      )
    return story
  })
}
