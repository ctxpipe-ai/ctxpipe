import {
  IconAffiliate,
  IconBrandGithub,
  IconCheck,
  IconFileDescription,
  IconMessageCircle,
} from "@tabler/icons-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { motion, type Variants } from "motion/react"
import { type ReactNode, useEffect } from "react"
import { AppShell } from "@/components/AppShell"
import { client } from "@/lib/api"
import { useSession } from "@/lib/auth-client"
import {
  GITHUB_POPUP_NAME,
  handleGithubSetupPopupResult,
  openCenteredPopup,
  setGithubSetupOrgHint,
  useWatchPopupClose,
} from "@/lib/popup"
import { useGetGithubAppInstallUrl } from "@/lib/useGetGithubAppInstallUrl"
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
  const [preferences, updatePreferences] = useUserPreferences()
  const { data: session, isPending: sessionPending } = useSession()
  const queryClient = useQueryClient()
  const githubAppInstallUrl = useGetGithubAppInstallUrl()
  const githubInstallationQuery = useQuery({
    queryKey: ["github-installation", orgSlug],
    queryFn: async () => {
      const res = await client[":orgSlug"].api.v1.github.installation.$get({
        param: { orgSlug },
      })
      if (!res.ok) throw new Error("Failed to check GitHub installation")
      return res.json()
    },
    enabled: !!session,
  })
  const { data: githubInstallation } = githubInstallationQuery
  const githubConnected = Boolean(githubInstallation)

  useEffect(() => {
    if (preferences.selectedOrganizationSlug !== orgSlug) {
      updatePreferences((prev) => ({
        ...prev,
        selectedOrganizationSlug: orgSlug,
      }))
    }
  }, [orgSlug, preferences.selectedOrganizationSlug, updatePreferences])

  const watchPopupClose = useWatchPopupClose()

  if (sessionPending) return null
  if (!session) return <Navigate to="/.auth/sign-in" replace />
  const user = session.user as { id: string; onboardingCompletedAt?: string | null }
  if (!user.onboardingCompletedAt) {
    return <Navigate to="/onboarding" replace />
  }

  const handleGithubConnect = () => {
    if (githubConnected) return
    setGithubSetupOrgHint(orgSlug)
    const popup = openCenteredPopup(githubAppInstallUrl, {
      name: GITHUB_POPUP_NAME,
      width: 1120,
      height: 780,
    })
    if (!popup) return
    watchPopupClose(popup, () =>
      handleGithubSetupPopupResult(orgSlug, queryClient),
    )
  }

  return (
    <AppShell>
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
              Welcome back
            </h1>
            <p className="mt-3 leading-relaxed text-muted-foreground">
              Your context layer is ready. Connect repositories and
              documentation to power your AI agent fleet.
            </p>
          </section>

          <ul className="mt-12 w-full list-none space-y-1 p-0">
            <li className="w-full">
              <motion.button
                type="button"
                className={`${onboardingRowClass} ${
                  githubConnected
                    ? "cursor-default opacity-55 hover:opacity-55"
                    : ""
                }`}
                aria-label={
                  githubConnected
                    ? "GitHub connected. GitHub app installation is complete."
                    : "Connect GitHub. Connect GitHub for code ingestion."
                }
                variants={onboardingRowGestureVariants}
                initial="rest"
                whileHover={githubConnected ? "rest" : "hover"}
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
                to="/$orgSlug/repositories"
                params={{ orgSlug }}
                icon={<IconAffiliate aria-hidden />}
                title="Connect knowledge sources"
                description="Connect docs, tools, and more, for ingestion."
                tag="Tools"
              />
            </li>
            <li className="w-full">
              <OnboardingNavButton
                to="/$orgSlug/chat"
                params={{ orgSlug }}
                icon={<IconMessageCircle aria-hidden />}
                title="Query your knowledge graph"
                description="See what ctx| knows about your context"
                tag="Chat"
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
    </AppShell>
  )
}
