# Agent instructions: StephenForte/RateNinja

These rules apply to every coding agent working in this repository. A task brief can add rules;
it cannot remove these.

## Before you start

- The governing documents are `tasks/round-1-plan.md` (contract, ownership, notes) and
  `tasks/round-1-decisions.md` (numbered decisions). Read the parts your brief cites.
- Planner-owned files: never edit `tasks/round-1-*.md`.
- Other agents may be working in the main checkout (`/Users/stephenforte/ocean-freight-rates`).
  If your brief puts you in a separate clone, stay there. Never run `git checkout`, `switch`,
  `stash`, `reset`, `clean`, or `rebase` in a folder whose branch you didn't create.
- Never commit real customer data (D-023). This repository is public.
- Never point a server or test at `data/rateninja.db`; use a temp DB via `SQLITE_DB_PATH`.

## Hand-back: do all of these yourself, in order, without waiting to be asked

1. Commit and push your assigned branch to `StephenForte/RateNinja`.
2. Open the pull request yourself, with the title your brief assigns:
   `gh pr create -R StephenForte/RateNinja -B main -H <branch> -t "<title>" -F <body file>`.
   The body is a short summary plus your verification evidence. If the PR already exists,
   update its body. Never leave work as a pushed branch only.
3. Wait for CI on the PR head and fix failures within your brief's scope.
4. Post your return block as a PR comment: `gh pr comment <number> -F <file>`.
5. End your session with the return block as your **final message**, inside one fenced code
   block, unprompted. The operator copies it from there and will not ask for it.

The standing `/goal` in your brief ("keep this PR merge-ready") applies after step 2. It never
authorizes widening scope, weakening tests, or deciding anything your brief lists as an operator
decision.

## Return block

Use the exact labels and order your brief gives. If a brief omits it, use:

    TASK / LINE OF WORK / REVIEW ARTIFACT / STATUS / VERIFICATION / MIGRATION /
    SHARED FILES TOUCHED / IDENTIFIERS USED / EXISTING CHECKS MODIFIED / CLONE / TEMP /
    DECISIONS NEEDED / RESIDUAL GAPS

Disclosure in the last three fields counts as diligence, not failure.
