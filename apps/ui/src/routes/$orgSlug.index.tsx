import {
  IconBrandGithub,
  IconCheck,
  IconChevronRight,
  IconFileDescription,
  IconPlug,
} from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { motion, type Variants } from "motion/react"
import { type ReactNode, useEffect } from "react"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import {
  githubInstallationIsLinked,
  githubInstallationOptions,
} from "@/features/connectors/queries/github-connector"
import { useGithubConnectFlow } from "@/features/connectors/useGithubConnectFlow"
import { useRepositoryIndexingSummary } from "@/features/repositories"
import { useSession } from "@/lib/auth-client"
import { useUserPreferences } from "@/lib/user-preferences"

export const Route = createFileRoute("/$orgSlug/")({
  component: OrgHomePage,
})

const DOCS_ORIGIN = "https://docs.ctxpipe.ai"

/** Home nav rows: teal hover on icon (semantic --primary is near-white in dark; teal matches dashboard accent). */
const onboardingRowClass =
  "group m-0 box-border flex w-full cursor-pointer items-center gap-4 border-0 bg-transparent px-0 py-4 text-left font-sans text-inherit antialiased transition-colors outline-none [-webkit-tap-highlight-color:transparent] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 rounded-none"

const onboardingRowGestureVariants = {
  rest: {},
  hover: {},
} satisfies Variants

const onboardingIconVariants = {
  rest: { rotateX: 0 },
  hover: { rotateX: 35 },
} satisfies Variants

const onboardingIconShellClass =
  "ctx-node h-10 w-10 shrink-0 transition-[color,background-color,border-color] duration-150 ease-out group-hover:border-teal-400 group-hover:bg-teal-400/5 group-focus-visible:border-teal-400 group-focus-visible:bg-teal-400/5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-muted-foreground [&_svg]:transition-colors group-hover:[&_svg]:text-teal-400 group-focus-visible:[&_svg]:text-teal-400"

function OnboardingRowIcon({ icon }: { icon: ReactNode }) {
  return (
    <span
      className="inline-block shrink-0 [transform-style:preserve-3d]"
      style={{ perspective: "200px" }}
    >
      <motion.span
        className={onboardingIconShellClass}
        style={{ transformStyle: "preserve-3d" }}
        variants={onboardingIconVariants}
        transition={{ type: "spring" }}
      >
        {icon}
      </motion.span>
    </span>
  )
}

function OnboardingNavButton(props: {
  to: string
  params: { orgSlug: string }
  icon: ReactNode
  title: string
  description: string
  tag: string
}) {
  const navigate = useNavigate()
  const ariaLabel = `${props.title}. ${props.description}`
  return (
    <motion.button
      type="button"
      className={onboardingRowClass}
      aria-label={ariaLabel}
      variants={onboardingRowGestureVariants}
      initial="rest"
      whileHover="hover"
      onClick={() => {
        void navigate({ to: props.to, params: props.params })
      }}
    >
      <OnboardingRowIcon icon={props.icon} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block font-medium text-foreground">{props.title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          {props.description}
        </span>
      </span>
      <span className="ctx-label-muted shrink-0 uppercase opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {props.tag}
      </span>
    </motion.button>
  )
}

function OnboardingExternalButton(props: {
  href: string
  icon: ReactNode
  title: string
  description: string
  tag: string
}) {
  const ariaLabel = `${props.title}. ${props.description}. Opens in a new tab.`
  return (
    <motion.button
      type="button"
      className={onboardingRowClass}
      aria-label={ariaLabel}
      variants={onboardingRowGestureVariants}
      initial="rest"
      whileHover="hover"
      onClick={() => {
        window.open(props.href, "_blank", "noopener,noreferrer")
      }}
    >
      <OnboardingRowIcon icon={props.icon} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block font-medium text-foreground">{props.title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">
          {props.description}
        </span>
      </span>
      <span className="ctx-label-muted shrink-0 uppercase opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {props.tag}
      </span>
    </motion.button>
  )
}

function OrgHomePage() {
  const { orgSlug } = Route.useParams()
  return <OrgHomePageContent orgSlug={orgSlug} />
}

export function OrgHomeSessionFallback() {
  return (
    <main className="mx-auto box-border flex min-h-screen w-full max-w-2xl items-center p-8 text-zinc-100">
      <PageBodySkeleton label="Loading home" />
    </main>
  )
}

/** Exported for Storybook — same dashboard as org home `/` under `/$orgSlug`. */
export function OrgHomePageContent({ orgSlug }: { orgSlug: string }) {
  const navigate = useNavigate()
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const githubInstallationQuery = useQuery({
    ...githubInstallationOptions(orgSlug),
    enabled: !!session,
  })
  const { data: githubInstallation } = githubInstallationQuery
  const githubConnected = githubInstallationIsLinked(githubInstallation)
  const { summary: repositorySummary } = useRepositoryIndexingSummary(orgSlug, {
    enabled: Boolean(session),
  })
  const repositoryStatus =
    repositorySummary.activeCount > 0
      ? {
          tone: "indexing" as const,
          title:
            repositorySummary.singleActiveStepLabel ??
            `${
              repositorySummary.runningCount > 0 ? "Indexing" : "Preparing"
            } ${repositorySummary.activeCount} ${
              repositorySummary.activeCount === 1
                ? "repository"
                : "repositories"
            }`,
          description:
            repositorySummary.failedCount > 0
              ? `${repositorySummary.failedCount} also ${
                  repositorySummary.failedCount === 1 ? "needs" : "need"
                } attention.`
              : "This continues in the background while you use ctx|.",
        }
      : repositorySummary.failedCount > 0
        ? {
            tone: "failed" as const,
            title: `${repositorySummary.failedCount} ${
              repositorySummary.failedCount === 1
                ? "repository needs"
                : "repositories need"
            } attention`,
            description: "Open Connectors to review GitHub indexing.",
          }
        : null

  const {
    start,
    isPending: ghBusy,
    isSyncing,
    SelfHostedWizardModal,
  } = useGithubConnectFlow({
    orgSlug,
    onAlreadyInstalled: () => {
      void navigate({
        to: "/$orgSlug/repositories/github/setup",
        params: { orgSlug },
      })
    },
    onRegistered: () => {
      void navigate({
        to: "/$orgSlug/repositories/github/setup",
        params: { orgSlug },
      })
    },
  })

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  if (sessionPending) return <OrgHomeSessionFallback />
  if (!session) return <Navigate to="/.auth/sign-in" replace />

  const handleGithubConnect = () => {
    if (githubConnected) return
    start("connect")
  }

  const githubRowBusy = ghBusy || isSyncing

  return (
    <>
      <div className="flex min-h-full min-w-0 flex-1 flex-col text-foreground">
        {/* Dashboard column: w-full up to max-w-2xl (42rem / 672px), centred in main. */}
        <div className="mx-auto box-border flex w-full max-w-2xl flex-1 flex-col justify-center p-8">
          <header className="mb-8">
            <span className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
              Home
            </span>
          </header>

          <section>
            <h1 className="text-3xl font-medium tracking-tight text-foreground">
              Welcome to ctx|
            </h1>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              Your engineering context layer is ready. Connect repositories and
              documentation to power your AI agent fleet.
            </p>
          </section>

          {repositoryStatus ? (
            <button
              type="button"
              className={[
                "group mt-8 flex w-full items-center gap-3 border bg-zinc-950/55 px-4 py-3 text-left transition-colors",
                repositoryStatus.tone === "failed"
                  ? "border-red-400/25 hover:border-red-400/45"
                  : "border-teal-400/25 hover:border-teal-400/45",
              ].join(" ")}
              aria-label={`${repositoryStatus.title}. ${repositoryStatus.description} View repository progress.`}
              onClick={() => {
                void navigate({
                  to: "/$orgSlug/connectors",
                  params: { orgSlug },
                  search: {
                    error: undefined,
                    error_description: undefined,
                    pendingAccountClaim: undefined,
                    notionConnectionId: undefined,
                  },
                })
              }}
            >
              <span
                aria-hidden
                className={
                  repositoryStatus.tone === "failed"
                    ? "ctx-indexing-failed-dot"
                    : "ctx-indexing-dot"
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {repositoryStatus.title}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {repositoryStatus.description}
                </span>
              </span>
              <IconChevronRight
                aria-hidden
                className="h-4 w-4 shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300"
              />
            </button>
          ) : null}

          <ul
            className={`${repositoryStatus ? "mt-6" : "mt-12"} w-full list-none space-y-1 p-0`}
          >
            <li className="w-full">
              <motion.button
                type="button"
                className={`${onboardingRowClass} ${
                  githubConnected || githubRowBusy
                    ? githubConnected
                      ? "cursor-default opacity-55 hover:opacity-55"
                      : "cursor-wait opacity-70"
                    : ""
                }`}
                aria-label={
                  githubConnected
                    ? "GitHub connected. GitHub app installation is complete."
                    : "Connect GitHub. Connect GitHub for code ingestion."
                }
                variants={onboardingRowGestureVariants}
                initial="rest"
                whileHover={githubConnected || githubRowBusy ? "rest" : "hover"}
                disabled={githubRowBusy}
                onClick={handleGithubConnect}
              >
                <OnboardingRowIcon
                  icon={
                    githubConnected ? (
                      <IconCheck aria-hidden />
                    ) : (
                      <IconBrandGithub aria-hidden />
                    )
                  }
                />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block font-medium text-foreground">
                    {githubConnected ? "GitHub connected" : "Connect GitHub"}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted-foreground">
                    {githubConnected
                      ? "GitHub app installation is complete."
                      : "Connect GitHub for code ingestion."}
                  </span>
                </span>
                <span
                  className={`ctx-label-muted shrink-0 uppercase ${
                    githubConnected
                      ? "opacity-100"
                      : "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                  }`}
                >
                  {githubConnected ? "done" : "git"}
                </span>
              </motion.button>
            </li>
            <li className="w-full">
              <OnboardingNavButton
                to="/$orgSlug/connectors"
                params={{ orgSlug }}
                icon={<IconPlug aria-hidden />}
                title="Connect tools"
                description="Link GitHub, Confluence, and other external sources."
                tag="tools"
              />
            </li>
            <li className="w-full">
              <OnboardingExternalButton
                href={DOCS_ORIGIN}
                icon={<IconFileDescription aria-hidden />}
                title="Read our docs"
                description="Product guides, API reference, and setup help."
                tag="docs"
              />
            </li>
          </ul>
        </div>
      </div>
      {SelfHostedWizardModal}
    </>
  )
}
