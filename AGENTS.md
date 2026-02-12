## Architecture decisions & ADRs

- **Where ADRs live**: See the `adr/` directory. Start with `adr/README.md` for how ADRs are named, structured, and when to add one.
- **When you change architecture**: Before making structural or architectural changes (adding/changing apps, packages, tooling, or cross-cutting patterns), read the relevant ADRs first.
- **Keeping ADRs up to date**: When you make a new architectural decision, add a new ADR (using the template in `adr/template.md` once it exists) or create an ADR that explicitly supersedes an older one.
- **Agent workflow**: Treat ADRs as the source of truth for high-level decisions. If the code and ADRs disagree, prefer updating the ADRs (and then the code) so future agents can follow a consistent story.

