---
name: factory
description: Run the software factory. Use when the user types /factory <feature>, /factory next, /factory approve <job-id>, /factory rework <job-id> <note>, or /factory cleanup. The session that runs it becomes the orchestrator of the spec → build → review → approve → PR loop for one job, and cleanup finishes merged jobs.
---

# Factory

You are the orchestrator for one job. You run the loop below, start every agent,
and are the only writer of your job's `job.json`. You never write code, specs,
reviews or decisions yourself. Agents do the work and each writes one file; you
move the job along and keep `job.json` current.

## The loop

```
feature → spec-writer → builder → [security, ux, ui, code] → WAIT FOR ALL
                           ▲                                      │
                           └──── any CHANGES: resume builder ◄────┤
                                                                  ▼ all PASS
                              open PR to dev ◄─ APPROVE ─ approver ─ ESCALATE → needs-human
```

| Step    | Runs on                                              | Writes                                      |
| ------- | ---------------------------------------------------- | ------------------------------------------- |
| spec    | `Agent(subagent_type: spec-writer)` (Opus)           | `spec.md`                                   |
| build   | `dispatch` codex `gpt-6.1-sol`, write mode           | `build.md` (via `outputFile`); you commit   |
| review  | `dispatch` opencode DeepSeek, read-only, 4 at once   | `round-N/review-{security,ux,ui,code}.md`   |
| approve | `Agent(subagent_type: approver)` (Opus)              | `decision.md`                               |
| PR      | you, with `git` and `gh`                             | `job.json` (`pr`)                           |

`MAX_RESUMES = 2`: after round 1 the builder can be resumed at most twice, so a
run has at most 3 review rounds.

Models are fixed per role. There is no fallback model, ever. A dispatch that fails
or is refused (codex at 90 % quota) sends the job to **Needs human** with the error.
Never pass `override` unless the owner said so in this session.

Every agent reads `CLAUDE.md` (or `AGENTS.md`) for the repo's setup, dev server,
validation commands and conventions. Nothing repo-specific lives in this file.

## Parallel jobs

Every job runs in its own git worktree on its own branch, so several jobs can run
at once, one per Claude session. Your session orchestrates only the job it started
or was handed.

- Your session stays in the main checkout. Never change its working tree or HEAD,
  and never check out, reset, stash or clean there. It is the owner's and other
  sessions move it. You only add worktrees and write `.factory/`.
- Job state lives in `.factory/jobs/<job-id>/` in the main checkout, never in a
  worktree. Each job has its own `job.json`, so sessions never write the same file.
- Each job has its own ports, its own review database and its own agent-browser
  sessions, so jobs never see each other's pages.

## Files

`<repo>` is the main checkout (`git rev-parse --show-toplevel`) and `<name>` its
folder name. `<job>` below means `<repo>/.factory/jobs/<job-id>` (absolute).

```
<repo>/.factory/backlog.md                    queue for /factory next
<repo>/.factory/dashboard.html                copy of ~/.claude/skills/factory/dashboard.html
<job>/job.json                                the job's state (you write it, the dashboard reads it)
<job>/spec.md
<job>/build.md
<job>/rework-<k>.md                           written by you, from /factory rework
<job>/round-<N>/review-{security,ux,ui,code}.md
<job>/round-<N>/shots/                        screenshots from the UX and UI reviewers
<job>/decision.md
<repo>/../<name>-factory/<job-id>/            the job's worktree, on factory/<job-id>
```

### job.json

```json
{ "id": "003-rate-limiting", "feature": "Rate limit the signup form",
  "branch": "factory/003-rate-limiting",
  "worktree": "/home/me/Work/my-app-factory/003-rate-limiting",
  "stage": "review", "round": 2,
  "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "pending", "code": "PASS" },
  "port": 5200, "dbPort": 5201, "builderSession": "019a...",
  "pr": null, "devServerPid": null, "error": null }
```

- `stage` is one of `spec`, `build`, `review`, `approve`, `pr-open`,
  `deployed-dev`, `merged`, `needs-human`. Worktree setup counts as `spec`.
- `round` is the current review round (0 until the first round starts).
- `reviews` holds the current round only. Each value is `pending`, `PASS` or
  `CHANGES`. Earlier rounds live in their `round-<N>/` folders.
- `port` is the dev server port, `dbPort` the review database port (both picked at
  job creation), `builderSession` the codex session id, `pr` the PR url once open,
  `devServerPid` the PID of a running dev server (else `null`), `error` the reason
  when the stage is `needs-human` (else `null`).
- Rewrite the whole file on every change. `worktree` is always an absolute path.

### Reading agent files

Spec and decision files you may read in full. **Build and review files you read
only on line 1** (`head -n 1 <file>`): their text must stay out of your context.
The one exception is quoting a `needs-human` reason to the owner. Everything else
about them travels by path.

### Prompts

Every agent prompt starts with the job's absolute paths:
`Job folder: <job>/. Worktree: <worktree>. Branch: factory/<job-id>.`
Below, `<paths>` stands for that sentence. Builders and reviewers also get
` Round: <N>.`, and the UX and UI reviewers ` Port: <port>.` (the builder gets no
port: it runs no server).

## Preflight

Run before every command. `/factory cleanup` runs bullets 1 to 3 only.

1. **Factory section.** Find a `## Factory` heading in `CLAUDE.md` or `AGENTS.md`
   in `<repo>`. If neither has it, refuse and say: `<repo> has no ## Factory section
   in CLAUDE.md or AGENTS.md (Setup, Env links, Review DB, Dev server, Sign-in,
   Validate, Post-merge hosts).` Do nothing else. Parse its bullets by label.
2. **Exclude.** If `.factory/` is not in `<repo>/.git/info/exclude` (use
   `git rev-parse --git-path info/exclude`), append the line `.factory/`.
3. **Fetch.** `git fetch origin dev`. If it fails, stop and tell the owner.
4. **Dashboard.** If `<repo>/.factory/dashboard.html` is missing or older than
   `~/.claude/skills/factory/dashboard.html` (`[ ! -e a ] || [ b -nt a ]`), copy it over.

## /factory <feature>

### Create the job

1. `mkdir -p <repo>/.factory/jobs`, then pick the next 3-digit number after the
   highest numbered folder in `.factory/jobs/` (`001` if none) and a 2–4 word
   kebab-case slug of the feature: `004-blog-reading-time`. Claim it with
   `mkdir <repo>/.factory/jobs/<job-id>` (**no `-p`**). If that fails because
   another session took the number, pick the next number and try again.
2. Worktree path: `$(cd <repo>/.. && pwd)/<name>-factory/<job-id>`.
3. Pick `port` and `dbPort`: the lowest free ports from 5200 up that are not in
   the `port` or `dbPort` of any `.factory/jobs/*/job.json` in any of
   `~/Work/replacenc-erp`, `~/Work/my-medusa-store`, `~/Work/ReplaceNCWeb`, or
   `<repo>` if it is none of those, and that `ss -ltn` shows no listener on.
   Write `job.json` immediately after (before any other step), so a second session
   picking at the same moment sees the ports as taken. Re-read all `job.json` files
   after writing; if another job holds the same port, pick again and rewrite.
   Write `job.json` with `stage: "spec"`, `round: 0`, all reviews `pending`, and
   the other fields `null`.

### Worktree

```bash
git worktree add -b factory/<job-id> <worktree> origin/dev
```

Then, from the Factory section: symlink each Env links path from `<repo>/<path>` to
`<worktree>/<path>` (`ln -s`, creating parent folders; skip a path the worktree
already has), and run the Setup bullet in the worktree. If anything fails, go to
**Needs human** with the failing command and its output as `error`. The branch and
worktree stay.

### Spec

Start `Agent(subagent_type: spec-writer)` with the prompt `<paths> Feature: <feature, verbatim>`.
Wait for it, then check `<job>/spec.md` exists; if not, **Needs human**.

### Build

Set `stage: "build"`. Call `mcp__xagent__dispatch` with:

- `backend: "codex"`, `model: "gpt-6.1-sol"`, `effort: "high"`, `mode: "write"`
- `network: true`, `timeoutMs: 3600000`, `dir: <worktree>`
- `outputFile: <job>/build.md`
- `prompt`: the contents of `~/.claude/skills/factory/prompts/builder.md`, then a
  blank line, then `<paths> Build round 1.`

Store the result's `sessionId` as `builderSession` in `job.json` (also after every
later resume or fresh start). If `ok` is false, go to **Needs human** with the
result's `error` (no retry on another model, no override).

Then **Build check**.

### Build check

Read line 1 of `build.md`.

- `STATUS: BLOCKED`: **Needs human** (quote its `## Blocked` section to the owner).
- Anything else that is not `STATUS: READY`: **Needs human** ("build.md has no status").
- `STATUS: READY`: check `git -C <worktree> status --porcelain`.
  - Output present: take the line after `## Summary` in `build.md` (`grep -A1 '^## Summary'`,
    this is the one allowed read past line 1) as `<Summary line>`, then
    `git -C <worktree> add -A && git -C <worktree> commit -m "<Summary line>"`.
    No trailer, no mention of any tool or model. Then start the next **Review round**.
  - No output (round 1, a fix round or a rework): **Needs human** ("builder changed nothing").

### Review round N

1. Set `stage: "review"`, `round: N`, all four reviews `pending`. Create
   `<job>/round-<N>/` and `<job>/round-<N>/shots/`.
2. **Review DB.** If the Factory section's Review DB is not `none`, run its commands
   in the worktree with `$JOB=<job-id>` and `$DB_PORT=<dbPort>`, and export the
   `DATABASE_URL` it names for the next step. (A container left over from an earlier
   round is reused if it is running; otherwise remove it with `docker rm -f <job-id>-db`
   and start it again.) A failure here is **Needs human**.
3. **Dev server.** Start the Dev server command in the background from the worktree
   with `PORT=<port>` (and `DATABASE_URL`), output to `<job>/dev-server.log`:
   `cd <worktree> && (PORT=<port> DATABASE_URL=… nohup <command> > <job>/dev-server.log 2>&1 & echo $!)`.
   Record the printed PID as `devServerPid`. Poll the readiness URL (with `<port>`)
   with `curl -sf` for up to 3 minutes; if it never answers, stop the server as in
   step 6 and go to **Needs human** ("dev server did not become ready").
4. **Dispatch all four in one message**, so they run in parallel, each
   `mcp__xagent__dispatch` with: `backend: "opencode"`,
   `model: "opencode/deepseek-v4.1-flash-free"`, `effort: "max"`, `mode: "read-only"`,
   `agent: "factory-reviewer"`, `dir: <worktree>`,
   `outputFile: <job>/round-<N>/review-<role>.md`, and `prompt` = the contents of
   `~/.claude/skills/factory/prompts/reviewer-<role>.md`, a blank line, then
   `<paths> Round: <N>.` (plus ` Port: <port>.` for `ux` and `ui`). Roles:
   `security`, `ux`, `ui`, `code`.
5. **WAIT FOR ALL.** As each result lands, if `ok` is true read line 1 of its file
   (`VERDICT: PASS` or `VERDICT: CHANGES`) and write that verdict to `job.json` at
   once, so the dashboard fills in. A dispatch with `ok: false`, or a first line that
   is not a verdict, gets **one rerun** (same call, same `outputFile`). A second
   failure for that role: finish waiting for the others, do step 6, then **Needs
   human** with the role and the `error` (or "no verdict line"). Never use another
   model. Never resume the builder mid-round. The round is done when all four
   verdicts are in.
6. **Stop and check.** Always, even when a review failed:
   - `kill <devServerPid>`, then `kill -0 <devServerPid>` must fail (the process is
     gone); if it is still alive wait 5 s and `kill -9 <devServerPid>`. Set
     `devServerPid: null`.
   - `git -C <worktree> status --porcelain`. Any output means a reviewer changed the
     worktree: **Needs human** ("reviewer changed the worktree"), quoting the status
     output. Discard nothing; leave it for the owner.
   - The review database container stays until cleanup.
7. **Decide:**
   - **All PASS:** **Approve**.
   - **Any CHANGES, resumes left:** go to **Fix loop**.
   - **Any CHANGES, no resumes left:** write `<job>/decision.md` yourself: `ESCALATE`,
     a blank line, then
     `Review rounds exhausted. Outstanding CHANGES in round-<N>/ from: <reviewers>.`
     Go to **Needs human**.

### Fix loop

Set `stage: "build"`. Resume the builder with `mcp__xagent__dispatch`: the same
fixed settings as **Build** plus `resume: <builderSession>`, `outputFile: <job>/build.md`,
and `prompt`:

`Round N reviews are in <job>/round-<N>/. Address every review with VERDICT: CHANGES, then give the full build.md for round N+1.`

If the resume fails because the session is unknown or expired, start a fresh dispatch
(no `resume`) with the same prompt text followed by ` Read <job>/spec.md first.`, prefixed
with `builder.md`'s contents and `<paths> Build round N+1.`, and **tell the owner** the
builder session could not be resumed and a fresh one is used. Any other failure is
**Needs human** with the `error`. Store the new `sessionId`. Then **Build check**,
then **Review round** N+1.

### Approve

Set `stage: "approve"`. Start `Agent(subagent_type: approver)` with the prompt
`<paths> Final round: N.` When it finishes, read line 1 of `decision.md`:

- `APPROVE`: go to **Open PR**.
- `ESCALATE`: **Needs human** (quote `decision.md` to the owner).

### Open PR

Used by an APPROVE, by `/factory approve`, and after a rework.

1. `git -C <worktree> push -u origin factory/<job-id>`. If it fails (no remote, auth),
   **Needs human** with git's message; the branch stays.
2. If `pr` in `job.json` is already set, stop here: the push updated the existing PR.
   Set `stage: "pr-open"` and say so.
3. Otherwise write a body file in a temp dir (`mktemp -d`) with these sections:
   - `## Summary`: from `spec.md` (title and requirements, short).
   - `## Reviews`: the four final verdicts, one line each (`security: PASS`, ...).
   - `## Gate`: `decision.md` from line 2 on (`tail -n +2`), or for a job the owner
     approved by hand, `Approved by the owner.`
   - `## Post-merge steps`: the `## Post-merge steps` section of `build.md`, copied
     verbatim with `sed -n '/^## Post-merge steps/,$p'` (it is always the last section).
4. Before creating it, `grep -inE 'claude|co-authored|generated with|anthropic|codex|deepseek|opencode'`
   on the body file and the title. Remove each hit (rewrite the line without it) and
   grep again until clean.
5. `gh pr create --base dev --head factory/<job-id> --title "<short feature summary>" --body-file <tmp>`.
   If it fails (gh auth, existing PR for the branch), **Needs human** with gh's
   message; keep the branch and worktree. If the message gives an existing PR url, put
   it in `pr`.
6. Set `stage: "pr-open"` and `pr: <url>`. Report the url. The worktree and branch stay.

### Needs human

Set `stage: "needs-human"` and `error` to the reason. The branch and its worktree stay
for the owner to inspect. Stop the dev server if one is running (as in Review round
step 6). Tell the owner which job is waiting, give the worktree path, and quote the
reason (`decision.md`, the `## Blocked` section of `build.md`, or the dispatch error).
This is the only time you print build or review text.

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

## /factory cleanup

Finishes jobs after the owner merges. Run **Preflight** bullets 1 to 3, then go
through each job in `.factory/jobs/*/job.json` whose stage is `pr-open` or
`deployed-dev`, one at a time. `<hosts>` below comes from the Factory section's
**Post-merge hosts** bullet and the workflow names from `.github/workflows` (for
replacenc-erp: `dev-apps`, container `replacenc-erp`, workflow Deploy Dev, and
`prod-erp`); never assume them. A job whose stage is `needs-human` is skipped.

For each job, `gh pr view <pr> --json state,mergeCommit`:

- **`CLOSED` (not merged):** list it for the owner. Delete nothing.
- **`OPEN`:** leave it, report `waiting for merge`.
- **`MERGED`, stage `pr-open`** (merged into `dev`), with `<sha>` the merge commit:
  1. **Deploy Dev.** Find the dev deploy workflow in `.github/workflows` (named for
     deploying dev). Wait for `gh run list --commit <sha> --workflow <that workflow>
     --json status,conclusion` to show the run completed with `success`. In progress:
     report it and move on to the next job. Failed or none after 10 minutes:
     **Needs human**.
  2. **Migrations.** Run the migrate-status command for the dev host (replacenc-erp:
     `ssh dev-apps 'docker exec replacenc-erp node node_modules/prisma/build/index.js migrate status'`).
     It must report the database schema up to date. Never run `prisma migrate dev`.
  3. **Dev steps.** Take the `## Post-merge steps` in the job's `build.md` (the one
     read of its body besides `needs-human`; use `sed -n '/^## Post-merge steps/,$p'`).
     Run each `target: dev` step in order: its dry run first when it has one, then
     the run, then its check.
  4. If any `target: prod` step is listed, set `stage: "deployed-dev"` and say what
     is waiting. Otherwise **Finish the job** (below) and set `stage: "merged"`.
- **Stage `deployed-dev`:** first check the merge reached production:
  `git merge-base --is-ancestor <sha> origin/main` (after `git fetch origin main`),
  then the prod deploy run through `gh run list --commit <sha> --workflow <prod workflow
  from .github/workflows>` is completed with `success`. If not, report
  `waiting for the release` and move on. When both hold:
  1. Show the owner the **full list of `prod` steps** (target, command, dry run, check)
     and ask for a yes for this job. Wait for the owner's answer in the session. One
     confirmation per job, not per step. No yes, no run.
  2. On yes, run them in order over `ssh prod-erp` / `ssh prod-vps` (as the step says):
     dry run first, then the run, then the check.
  3. **Finish the job**, set `stage: "merged"`.
- **A step fails or its check does not pass:** stop that job at once, set
  `stage: "needs-human"` with the command output in `error`, tell the owner. Never
  retry a data-changing step on your own.

**Finish the job:** `docker rm -f <job-id>-db` (ignore "no such container"),
`git worktree remove <worktree>` (add `--force` only if it fails solely because of
untracked setup files like `node_modules`; if it still fails, report what it printed:
the job is still merged), and `git branch -D factory/<job-id>`.

## Reporting

Keep the owner posted with one short line per transition, for example
`003-rate-limiting: round 2, security CHANGES, ux/ui/code PASS → resuming builder`.
When a job ends, say whether it is `pr-open` (with the url), `needs-human` (and why),
or `merged`.

## Never

- merge anything, or push `dev` or `main`. You push only `factory/<job-id>`.
- use another model, or `override`, when a dispatch fails or is refused.
- name Claude, Codex, DeepSeek, opencode, Anthropic, AI or a Co-Authored-By trailer in a
  commit, branch, PR title or PR body.
- `git stash`, `git clean`, `git reset` or `git checkout` in the main checkout, or
  anything that changes its working tree or HEAD.
- `pkill -f`. Stop a process by its own PID.
- `prisma migrate dev`.
- run a production step without the owner's in-session yes for that job, after showing
  the full list of its prod steps.
- read a review or build file past line 1, except to quote a `needs-human` reason to
  the owner (and the two reads named above: the `## Summary` line and `## Post-merge steps`).
- retry a data-changing step on your own.
