---
name: factory
description: Run the software factory. Use when the user types /factory <feature>, /factory next, /factory approve <job-id>, /factory rework <job-id> <note>, /factory retry <job-id>, or /factory cleanup. The session that runs it becomes the orchestrator of the spec → build → review → approve → PR loop for one job, and cleanup finishes merged jobs.
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
  "pr": null, "devServerPid": null, "error": null,
  "failedStep": null, "stepsDone": [] }
```

- `stage` is one of `spec`, `build`, `review`, `approve`, `pr-open`,
  `deployed-dev`, `merged`, `needs-human`. Worktree setup counts as `spec`.
- `round` is the current review round (0 until the first round starts).
- `reviews` holds the current round only. Each value is `pending`, `PASS` or
  `CHANGES`. Earlier rounds live in their `round-<N>/` folders.
- `port` is the dev server port, `dbPort` the review database port (both picked at
  job creation), `builderSession` the codex session id, `pr` the PR url once open,
  `devServerPid` the PID of a running dev server (else `null`), `error` the reason
  when the stage is `needs-human` (else `null`), `failedStep` the name of the step
  that failed when the stage is `needs-human` (else `null`; names are listed under
  **Needs human**), `stepsDone` the indexes of the `## Post-merge steps` already
  completed, in order (`[]` until cleanup runs one).
- Rewrite the whole file on every change. `worktree` is always an absolute path.

### Reading agent files

Spec and decision files you may read in full. **Build and review files you read
only on line 1** (`head -n 1 <file>`): their text must stay out of your context.
The one exception is quoting a `needs-human` reason to the owner. Everything else
about them travels by path.

### Prompts

The job's absolute paths are one sentence:
`Job folder: <job>/. Worktree: <worktree>. Branch: factory/<job-id>.`
Below, `<paths>` stands for that sentence. A native subagent prompt (spec-writer,
approver) starts with `<paths>`. A dispatch prompt is the prompt file's contents
followed by `<paths>`. Builders and reviewers also get
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
   Then make sure its server is running in the background (it reads `jobs/*/job.json`
   over HTTP, which a `file://` page cannot). If `<repo>/.factory/dashboard.pid` and
   `dashboard.port` exist, `kill -0 <pid>` succeeds and
   `curl -sf http://127.0.0.1:<port>/dashboard.html` answers, it is up: do nothing.
   Otherwise pick the lowest port from 8800 up that `ss -ltn` shows no listener on, start
   `setsid python3 -m http.server --bind 127.0.0.1 -d <repo>/.factory <port> > /dev/null 2>&1 < /dev/null & echo $!`,
   and write the PID to `dashboard.pid` and the port to `dashboard.port`. Tell the owner
   `Dashboard: http://127.0.0.1:<port>/dashboard.html` whenever you start it. Never stop it;
   the owner does, by its PID. A failure here is reported but does not stop the command.

## /factory <feature>

### Create the job

1. `mkdir -p <repo>/.factory/jobs`, then pick the next 3-digit number after the
   highest numbered folder in `.factory/jobs/` (`001` if none) and a 2–4 word
   kebab-case slug of the feature: `004-blog-reading-time` (drop any word the **Scrub**
   below hits). Claim it with
   `mkdir <repo>/.factory/jobs/<job-id>` (**no `-p`**). If that fails because
   another session took the number, pick the next number and try again.
2. Worktree path: `$(cd <repo>/.. && pwd)/<name>-factory/<job-id>`.
3. Pick `port` and `dbPort`: the lowest free ports from 5200 up that are not in
   the `port` or `dbPort` of any `.factory/jobs/*/job.json` in any of
   `~/Work/replacenc-erp`, `~/Work/my-medusa-store`, `~/Work/ReplaceNCWeb`, or
   `<repo>` if it is none of those, and that `ss -ltn` shows no listener on.
   Write `job.json` immediately after (before any other step), so a second session
   picking at the same moment sees the ports as taken. Re-read all `job.json` files
   after writing; on a collision the job with the lexicographically smaller job-id
   keeps the port and the other advances to the next free one and rewrites.
   Write `job.json` with `id`, `feature`, `branch`, `worktree`, `port`, `dbPort`,
   `stage: "spec"`, `round: 0`, all reviews `pending`, and `builderSession`, `pr`,
   `devServerPid`, `error` and `failedStep` set to `null`, and `stepsDone` to `[]`.

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

### Scrub

Used on every text that lands in the repository (commit message, PR title and body,
branch slug). Two greps, and any hit counts: the case-insensitive
`grep -iE 'claude|co-authored|generated with|anthropic|codex|deepseek|opencode'` and the
case-sensitive `grep -E '\bAI\b'`.

### Build check

Read line 1 of `build.md`.

- `STATUS: BLOCKED`: **Needs human** (quote its `## Blocked` section to the owner).
- Anything else that is not `STATUS: READY`: **Needs human** ("build.md has no status").
- `STATUS: READY`: check `git -C <worktree> status --porcelain`.
  - Output present: take the first non-empty line after `## Summary` in `build.md`
    (the one allowed read past line 1) into a temp file, never into a shell string:
    `awk '/^## Summary/{f=1;next} f&&NF{print;exit}' <job>/build.md > <tmp>/msg` (`<tmp>` from
    `mktemp -d`). Run the **Scrub** on `<tmp>/msg`. If the file is empty or the scrub hits,
    overwrite it with `Implement <job-id>`. Then
    `git -C <worktree> add -A && git -C <worktree> commit -F <tmp>/msg`. Builder text is
    never interpolated into a command line. No trailer, no mention of any tool or model.
    Then start the next **Review round**.
  - No output: in the first build round, **Needs human** ("builder changed nothing"). In a
    fix round or a rework, the builder may rightly have found nothing to change: go straight
    to the next **Review round**.

### Review round N

1. Set `stage: "review"`, `round: N`, all four reviews `pending`. Create
   `<job>/round-<N>/` and `<job>/round-<N>/shots/`.
2. **Review DB.** If the Factory section's Review DB bullet does not start with `none` (case-insensitive), run its commands
   in the worktree with `$JOB=<job-id>` and `$DB_PORT=<dbPort>`, and, only when the
   bullet defines a `DATABASE_URL`, export it for the next step. (A container left over from an earlier
   round is reused if it is running; otherwise remove it with `docker rm -f <job-id>-db`
   and start it again.) A failure here is **Needs human**.
3. **Dev server.** Start the Dev server command in its own session from the worktree
   with `PORT=<port>` (and `DATABASE_URL`), output to `<job>/round-<N>/dev-server.log`:
   `cd <worktree> && PORT=<port> DATABASE_URL=… setsid bash -c '<Dev server command>' > <job>/round-<N>/dev-server.log 2>&1 < /dev/null & echo $!`.
   Record the printed PID as `devServerPid`; it is also the process group id. Poll the readiness URL (with `<port>`)
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
   - `kill -- -<devServerPid>` (the whole group, by its own PID, never by pattern), then
     `kill -0 -- -<devServerPid>` must fail (the group is gone). Wait up to 10 s for that;
     if it is still alive, `kill -KILL -- -<devServerPid>`. Set `devServerPid: null`.
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
2. Write a body file in a temp dir (`mktemp -d`) with these sections:
   - `## Summary`: from `spec.md` (title and requirements, short).
   - `## Reviews`: the four final verdicts, one line each (`security: PASS`, ...).
   - `## Gate`: `decision.md` from line 2 on (`tail -n +2`), or for a job the owner
     approved by hand, `Approved by the owner.`
   - `## Post-merge steps`: the `## Post-merge steps` section of `build.md`, copied
     verbatim with `sed -n '/^## Post-merge steps/,$p'` (it is always the last section).
3. Run the **Scrub** on the body file and the title. Remove each hit (rewrite the line
   without it) and scrub again until clean.
4. If `pr` in `job.json` is already set (a rework or retry), the push updated the existing
   PR: refresh its description with `gh pr edit <pr> --body-file <tmp>` (same sections, so
   `## Reviews` and `## Post-merge steps` match the final round), set `stage: "pr-open"`,
   say so and stop. If `gh pr edit` fails, **Needs human** with gh's message.
5. Otherwise `gh pr create --base dev --head factory/<job-id> --title "<short feature summary>" --body-file <tmp>`.
   If it fails (gh auth, existing PR for the branch), **Needs human** with gh's
   message; keep the branch and worktree. If the message gives an existing PR url, put
   it in `pr`.
6. Set `stage: "pr-open"` and `pr: <url>`. Report the url. The worktree and branch stay.

### Needs human

Set `stage: "needs-human"`, `error` to the reason and `failedStep` to the step that
failed: `worktree`, `spec`, `build`, `build-check`, `review-db`, `dev-server`, `review`,
`approve`, `open-pr` or `post-merge`. The branch and its worktree stay
for the owner to inspect. Stop the dev server if one is running (as in Review round
step 6). Tell the owner which job is waiting, give the worktree path, and quote the
reason (`decision.md`, the `## Blocked` section of `build.md`, or the dispatch error).
This is the only time you print build or review text.

## Other subcommands

`/factory next`, `approve`, `rework`, `retry` and `cleanup` are in `subcommands.md` next to this file. Read it before you run any of them.

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
- run a step labelled `target: dev` whose command names a prod host, without the owner's yes.
