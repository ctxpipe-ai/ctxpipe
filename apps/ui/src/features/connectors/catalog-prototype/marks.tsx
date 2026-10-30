/**
 * PROTOTYPE, throwaway. Lives only on branch prototype/connector-catalog.
 * Do not merge into main. Question (CTX-1078): what should "Add connection"
 * look like with 10+ connectors? The marks that the catalog needs in
 * a form main does not export.
 */
import { ConfluenceMark } from "../components/ConfluenceMark"

/** The outline form, as today's catalog shows it. */
export function ConfluenceOutlineMark({ className }: { className?: string }) {
  return <ConfluenceMark className={className} variant="outline" />
}

/** Copied from the unmerged Zendesk branch (Simple Icons, CC0). */
export function ZendeskMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M12.914 2.904V16.29L24 2.905H12.914zM0 2.906C0 5.966 2.483 8.45 5.543 8.45s5.542-2.484 5.543-5.544H0zm11.086 4.807L0 21.096h11.086V7.713zm7.37 7.84c-3.063 0-5.542 2.48-5.542 5.543H24c0-3.06-2.48-5.543-5.543-5.543z"
        fill="currentColor"
      />
    </svg>
  )
}
