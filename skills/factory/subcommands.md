# Factory subcommands

Moved out of `SKILL.md` on 2026-11-02 so a `/factory <feature>` run does not load them. The preflight, file layout and job.json rules in `SKILL.md` apply here too.

## /factory next

Read `.factory/backlog.md` and take the first `- [ ]` item. Claim it with one Edit
that replaces its exact line with `- [x] <item> → claimed`. If the Edit fails because
the line changed, another session claimed it: re-read the backlog and try the next
`- [ ]` item. If none is left, say so and stop.

Run `/factory <item>`, and once the job has an id, replace `claimed` on its backlog
line with the job id.

## /factory approve <job-id>

The job must be in `needs-human` and its worktree must exist. Run **Open PR** with that
job id.

## /factory rework <job-id> <note>

The job must be in `needs-human` or `pr-open`.

1. Write the note, verbatim, to `<job>/rework-<k>.md`, where `k` is the next unused number.
2. Set `stage: "build"`, `error: null`. A rework run gets a fresh `MAX_RESUMES`.
3. Resume the builder (`resume: <builderSession>`, same fixed settings and `outputFile`
   as **Build**) with the prompt
   `Rework: read <job>/rework-<k>.md and address it, then give the full build.md for round N+1.`
   (`N` is the job's last round.) If the session cannot be resumed, start a fresh one as in
   **Fix loop** and tell the owner.
4. **Build check**, then the full **Review round** and **Approve** again. In the end
   **Open PR** pushes to the existing PR when `pr` is set.

## /factory retry <job-id>

The job must be in `needs-human` with a `failedStep`. Fix nothing yourself. Set `error: null`
and resume from that step, with the job's recorded state:

- `worktree`: redo **Worktree** (skip what already exists).
- `spec`: redo **Spec**. `build`: redo the build or fix dispatch for the current round
  (resume the builder as in **Fix loop** when `builderSession` is set, else **Build**), then
  **Build check**.
- `build-check`: redo **Build check**.
- `review-db`, `dev-server`, `review`: redo **Review round** `<round>` from step 1 (reviewers
  overwrite their files).
- `approve`: redo **Approve**. `open-pr`: redo **Open PR**.
- `post-merge`: redo the cleanup of that job, skipping every step listed in `stepsDone`.

If the same step fails again, **Needs human** again. A retry never passes `override`.

## /factory cleanup

Finishes jobs after the owner merges. Run **Preflight** bullets 1 to 3, then go
through each job in `.factory/jobs/*/job.json` whose stage is `pr-open` or
`deployed-dev`, one at a time. `<hosts>` below comes from the Factory section's
**Post-merge hosts** bullet and the workflow names from `.github/workflows` (for
replacenc-erp: `dev-apps`, container `replacenc-erp`, workflow Deploy Dev, and
`prod-erp`); never assume them. A job whose stage is `needs-human` is skipped, except
one that has `pr` set: run `gh pr view <pr> --json state,mergeCommit` on it too and report
any that is `MERGED` (so the owner can `/factory retry` it) or `CLOSED`. Change nothing on it.

For each job, `gh pr view <pr> --json state,mergeCommit`:

- **`CLOSED` (not merged):** list it for the owner. Delete nothing.
- **`OPEN`:** leave it, report `waiting for merge`.
- **`MERGED`, stage `pr-open`** (merged into `dev`), with `<sha>` the merge commit:
  1. **Deploy Dev.** Find the dev deploy workflow in `.github/workflows` (named for
     deploying dev). Wait for `gh run list --commit <sha> --workflow <that workflow>
     --json status,conclusion` to show the run completed with `success`. In progress:
     report it and move on to the next job. Failed or none after 10 minutes:
     **Needs human** (`failedStep: post-merge`).
  2. **Migrations.** Only when the Post-merge hosts bullet names a migrate-status command
     for the dev host (replacenc-erp:
     `ssh dev-apps 'docker exec replacenc-erp node node_modules/prisma/build/index.js migrate status'`),
     run it; it must report the database schema up to date. If the bullet names none, skip
     this step. Never run `prisma migrate dev`.
  3. **Dev steps.** Take the `## Post-merge steps` in the job's `build.md` (the one
     read of its body besides `needs-human`; use `sed -n '/^## Post-merge steps/,$p'`).
     Number the steps from 0 and skip every index already in `stepsDone`. Before running a
     `target: dev` step, check its command names only the dev host or alias from the
     Post-merge hosts bullet and none of its prod hosts; the builder's label is not trusted.
     A command that names anything else is treated as `prod`: do not run it now, handle it
     with the prod steps. Run each remaining dev step in order: its dry run first when it
     has one, then the run, then its check. After each step passes, append its index to
     `stepsDone` in `job.json`.
  4. If any `target: prod` step is listed, set `stage: "deployed-dev"` and say what
     is waiting. Otherwise **Finish the job** (below) and set `stage: "merged"`.
- **Stage `deployed-dev`:** first check the merge reached production:
  `git merge-base --is-ancestor <sha> origin/main` (after `git fetch origin main`). If
  that fails, also accept a merged dev→main release PR that contains the merge commit:
  `gh pr list --base main --state merged --search <sha>` returns one. Then
  the prod deploy run through `gh run list --commit <sha> --workflow <prod workflow
  from .github/workflows>` is completed with `success`. If not, report
  `waiting for the release` and move on. When both hold:
  1. Show the owner the **full list of `prod` steps** (target, command, dry run, check)
     and ask for a yes for this job. Wait for the owner's answer in the session. One
     confirmation per job, not per step. No yes, no run.
  2. On yes, run them in order over `ssh prod-erp` / `ssh prod-vps` (as the step says),
     skipping indexes already in `stepsDone`: dry run first, then the run, then the check.
     After each step passes, append its index to `stepsDone`.
  3. **Finish the job**, set `stage: "merged"`.
- **A step fails or its check does not pass:** stop that job at once, set
  `stage: "needs-human"`, `failedStep: "post-merge"` and the command output in `error`,
  tell the owner. Never retry a data-changing step on your own; only the owner's
  `/factory retry` resumes it, and it skips every step in `stepsDone`.

**Finish the job:** `docker rm -f <job-id>-db` (ignore "no such container"),
`git worktree remove <worktree>` (add `--force` only if it fails solely because of
untracked setup files like `node_modules`; if it still fails, report what it printed:
the job is still merged), and `git branch -D factory/<job-id>`. Then on
`~/Work/status/factory-<job-id>.md` tick cleanup and clear the Owed lines that are done.
When Owed is empty, move the page to `~/Work/status/done/` and drop its `BOARD.md`
line. A job left at `deployed-dev` keeps its page open with the prod steps owed.
