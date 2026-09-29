# markdown-twain

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `mcdp-adk/markdown-twain`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Invariants

- Changes reach `main` through a PR unless the owner asks for a direct commit.
- Every ticked acceptance criterion has evidence, and an issue closes only with every criterion ticked.
- A PR for an issue starts with `Closes #N` when it finishes the issue, or `Refs #N` when it doesn't.
