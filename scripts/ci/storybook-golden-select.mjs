export const requiredStories = [
  "LateErrorDoesNotClobberSuccess",
  "FirstTurnStreamsLive",
  "FirstTurnFailureRestoresDraft",
  "FollowUpShowsSandboxSetupFirst",
  "LogKeepsStreamOrder",
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
  "PublishPrErrorToast",
  "SingleCreatePr",
  "SingleCreatePrPaneClosed",
  "DiffTriggerPaneClosed",
  "DiffTabRoundedCorner",
  "CreatePrMatchesPaneTriggers",
  "ShowPr",
  "CtaButtonStyle",
  "BranchLabel",
  "SyncCtaWithSubtleShowPr",
  "DirtyShowsOnlySync",
  "PushEntryUnderCard",
  "DiffTriggerNoChanges",
  "PaneTabsStayInPlace",
  "TextTabsKeepPadding",
  "UneditedSaveKeepsAutomaticTitle",
  "EscapeReturnsFocus",
  "MaximizedPaneMatchesHeader",
  "SelectedTabInView",
  "ConversationSandboxFiles",
  "ConversationMaximizedSync",
  "StableRequestBudget",
  "WriteCheckFailedStopsPolling",
  "WriteCheckStallStopsPolling",
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
  "IngestingReducedMotion",
  "DoubleClickMovesOneSlide",
  "AdminFlowCreateOrgLandsOnHome",
  "JoinerFinishLandsInApp",
  "GuideAdminNewOrg",
  "GuideAdminCreatesWorkspaceOnHome",
  "GuideAdminAfterFirstQuestion",
  "GuideMemberView",
  "GuideDismissRemovesIt",
  "GuideSignalFailureKeepsHome",
  "GuideEstablishedUserHidden",
  "ChatProgressDone",
  "ChatProgressLogExpanded",
  "ChatProgressSpacing",
  "OpeningLogKeepsScroll",
  "DiffPaneEmpty",
  "DiffPaneManyFiles",
  "DiffPaneExpandedFile",
  "DiffPaneLongPaths",
  "DiffPaneRenamedAndOmitted",
  "DiffPaneTurnGone",
  "TurnCardCollapsed",
  "TurnCardExpanded",
  "TurnCardOpensDiff",
  "SyncAddsThreadEntry",
  "SyncEntry",
  "CreatePrEntry",
  "ExistingPrEntry",
  "CreatePrWithoutPrEntry",
  "AgentPushEntry",
  "SweepPushEntry",
  "WaitsForDelay",
  "FastLoadSkipsSkeleton",
  "VisibleSkeletonHoldsMinimum",
  "SuspenseHoldsMinimum",
  "RecentCommitsSkeletonMatches",
  "CompactRowTruncates",
  "CommitLineAligns",
  "AuthorFiltersRecent",
  "ResetClearsEveryFilter",
  "LoadMorePages",
  "CustomDateRange",
  "AvatarAndInitialFallback",
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
  "AddSeveralSendsOneBatch",
  "PickerShowsConnectionNames",
  "ChooseWorkspacesMulti",
  "SelectAllPagesOfASpace",
  "EditsASavedPageList",
  "PlainLinkMovesCurrentNav",
  "PaletteShortcutTogglesAndRestoresFocus",
  "PaletteFiltersAtOnce",
  "PaletteArrowKeysAndEnterKeepPane",
  "PaletteEscapeClearsThenCloses",
  "PaletteNoResults",
  "PaletteLoadingKeepsPages",
  "PaletteSkeletonHandsOverOnce",
  "PaletteArrowKeysWalkEveryItem",
  "PaletteHoverAndKeysShareOneHighlight",
  "PaletteEnterAfterDeleteRunsFirstMatch",
  "PaletteShortcutClosesAfterSyncRender",
  "DeleteWorkspaceShowsNoError",
  "DeleteLastWorkspaceShowsNoError",
  "DeleteFromConversationShowsNoError",
  "NewPathsKeepExpandedFolders",
  "DefaultBranchUntilSandboxReady",
  "Loading",
  "WorkspacesLoading",
  "Empty",
  "Populated",
  "ActivityLoading",
  "FirstMessageOpensConversation",
  "NoHistory",
  "ConsentOrgPicker",
  "ConsentNeedsOneOrg",
  "ConsentWriteOffByDefault",
  "ConnectedAppsEditOrgs",
  "ConnectedAppsRevoke",
  "ConnectedAppsRevokeError",
  "ConsentSendsTickedOrgs",
  "UserMenuLinksConnectedApps",
]

export function isGoldenPlaySuccess(phase) {
  return phase === "played"
}

export function selectGoldenStories(index) {
  const entries = Object.values(index.entries ?? {})
  // Names are matched without the file, so a tagged name must be unique.
  const tagged = entries
    .filter((entry) => (entry.tags ?? []).includes("workspace-golden"))
    .map((entry) => entry.exportName)
  const twice = tagged.find((name, at) => tagged.indexOf(name) !== at)
  if (twice)
    throw new Error(`More than one golden story is named ${twice}; rename one`)
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

// Every story with a play function, sorted by id so shards stay stable.
export function selectPlayStories(index) {
  return Object.values(index.entries ?? {})
    .filter(
      (entry) =>
        entry.type === "story" && (entry.tags ?? []).includes("play-fn"),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))
}

// "i/n" keeps every n-th story, starting at the i-th, so the shards cover all
// stories once. Without a spec, every story stays.
export function shardStories(stories, spec) {
  if (!spec) return stories
  const [at, count] = spec.split("/").map(Number)
  if (
    !(Number.isInteger(at) && Number.isInteger(count) && at >= 1 && at <= count)
  )
    throw new Error(`Bad shard ${spec}; use i/n with 1 <= i <= n`)
  return stories.filter((_, position) => position % count === at - 1)
}
