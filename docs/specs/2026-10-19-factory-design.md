# Software factory design

2026-10-19. Replaces cross-model-dev, the task-board mod, and xagent's routing.

## Intent

The owner wants every feature to go through more of the development lifecycle than
cross-model-dev covers. That means a spec, a build, and four reviews (security, UX, UI,
code) that loop back to the builder. A final gate then either opens a PR or hands the
job to the owner. The per-task quota router in cross-model-dev was the main irritation,
so models are now fixed per role. The owner also wants to run several features at once,
one Claude session each, every job in its own git worktree.

The base is zazencodes' software factory
(`zazencodes-season-3/src/software-factory-claude-code`, read 2026-10-19): a `/factory`
skill that orchestrates, seven agents, per-job `job.json` state, a backlog, and an HTML
dashboard. This design keeps its loop, its file layout, and its worktree-per-job
parallelism. It changes who runs each role, where merges go, and where the factory lives.

## Goals

- `/factory <feature>`, `/factory next`, `/factory approve <job-id>`,
  `/factory rework <job-id> <note>` work in replacenc-erp, ReplaceNCWeb and
  my-medusa-store.
- Several sessions can run jobs at the same time without touching each other's files,
  branches, ports or browser sessions.
- Fixed models per role (owner's decisions):

  | Role | Runs on |
  |---|---|
  | spec-writer | Claude Opus (native subagent) |
  | builder | Codex `gpt-6.1-sol` via the owner's ChatGPT login |
  | reviewer-security, reviewer-ux, reviewer-ui, reviewer-code | opencode `opencode/deepseek-v4.1-flash-free`, variant `max` (free) |
  | approver | Claude Opus (native subagent) |

- Opus is the gate (owner's decision). For a small change it judges correct, it writes
  APPROVE, and the factory pushes `factory/<job-id>` and opens a PR to `dev`. For anything
  that needs human judgment, it writes ESCALATE. The owner then runs `/factory approve`
  (push + PR) or `/factory rework` (back to the builder).
- The owner merges every PR. The factory never merges into `dev` or `main` and never
  pushes either one.

## Non-goals

- No per-task routing, quota weighting, or model choice at run time.
- No Antigravity or Copilot backends.
- No changes to the other mods (hud, rulebook, handoff, agent-radar, mission-control,
  blast-radius, review-watch, where-am-i, secret-box).

## Anti-goals (a failure even if it works)

- Any merge into `dev` or `main`, or any push to them.
- Spending Claude tokens on reviews. The four reviewers must run on the free DeepSeek model.
- Any mention of Claude, Codex, DeepSeek, Anthropic, AI, or a Co-Authored-By trailer in
  commits, branch names, PR titles or PR bodies (global rule).
- Touching the main checkout's working tree or HEAD. Other sessions move HEAD in the ERP
  main checkout. The factory only adds worktrees and writes its own state folder.
- Stopping processes with `pkill -f` patterns. Dev servers are stopped by their own PID.
- Silently swapping a model when a backend fails. The factory stops and tells the owner.

## What changes in claude-config

### Removed

- `skills/cross-model-dev/` (skill, routing table, plan-review schema).
- `mods/task-board/`, plus its rows in README.md and THIRD-PARTY.md. The factory's
  `job.json` files and dashboard replace the board.
- From xagent: the `route` tool, `hooks/routing.ts`, the quota weighting, and the agy and
  Copilot backends with their parsers and tests. The `dispatch` tool, the codex quota
  read, and the 90 % refusal stay. agent-radar and mission-control show xagent's running
  agents, so the mod itself stays.
- The `~/.claude/skills/cross-model-dev` symlink.

### Added

- `skills/factory/SKILL.md`: the orchestrator, adapted from the original (details below).
- `agents/` with `spec-writer.md` and `approver.md` (Opus). `install.sh` symlinks each
  one into `~/.claude/agents/`, the same way it handles skills.
- Prompt files for the roles that run outside Claude, read by the orchestrator and sent
  through `dispatch`: `skills/factory/prompts/builder.md` and
  `skills/factory/prompts/reviewer-{security,ux,ui,code}.md`. They are adapted from the
  original agent files: same checklists and the same output formats.
- An `opencode` backend in xagent's `dispatch`:
  `opencode run -m <model> --variant <effort> --format json --dir <dir> [-s <session>]`,
  with a JSON event parser and tests alongside the codex ones. Read-only mode runs the
  `factory-reviewer` opencode agent (below) and never passes `--auto`.
- An opencode agent config, `opencode/agent/factory-reviewer.md`, installed by
  `install.sh` into `~/.config/opencode/agent/`. Its permissions are: file edits denied,
  bash allowed (needed for git diff, tests, the dev server and agent-browser), webfetch
  denied.
- `agent-browser` installed through mise (npm), so the UX and UI reviewers can look at
  pages. The free DeepSeek model accepts image input, so it can read the screenshots.
- `factory/dashboard.html` in the skill folder, adapted to read the per-repo state folder
  below and to show the `pr-open` stage with its PR link.
- README rows for the factory, and xagent's row updated to "dispatch for Codex and opencode".

### Memories

These move to `archive/`, with the MEMORY.md lines removed:
`cross-model-dev-commit-without-asking`, `xagent-implementer-sol-only`,
`reviewer-deepseek-free-opus-branch`. The factory's fixed models replace them. A new
memory points at the factory and its role table. `claude-code-mods-installed` gets the
task-board removal.

## How the factory works (changes from the original)

### State lives outside the repo's tracked files

The original keeps state in `<repo>/factory/` and needs a `.gitignore` entry. Here,
state lives in `<repo>/.factory/` (`backlog.md`, `jobs/<job-id>/...`). The factory adds
it to `.git/info/exclude` on first run, so nothing lands in a commit and the three
repos need no committed change for it.

### Worktrees from `origin/dev`

The worktree path is `<parent>/<repo-name>-factory/<job-id>`. The factory first runs
`git fetch origin dev`, then `git worktree add -b factory/<job-id> <worktree> origin/dev`.
It never uses the local `dev`, because other sessions may have moved or dirtied the main
checkout. Diffs and reviews compare against `origin/dev...factory/<job-id>` (the
merge-base form). After that, the setup steps from the repo's CLAUDE.md/AGENTS.md run in
the worktree.

### Builder (Codex Sol)

The orchestrator runs `dispatch` with `backend: codex`, `model: gpt-6.1-sol`,
`effort: high`, `mode: write`, and `dir: <worktree>`. The prompt is `prompts/builder.md`
plus the job's paths, the round, and the port. Codex's sandbox can write only inside the
worktree, and the job folder and the worktree's git metadata live outside it. So:

- Codex edits code and runs tests. It does not commit, and it does not write `build.md`.
- Its final answer is the full `build.md` content, starting with `STATUS: READY` or
  `STATUS: BLOCKED`.
- The orchestrator writes that answer verbatim to `build.md`. When it says READY and the
  tree has changes, the orchestrator commits in the worktree. The commit message is a
  one-line summary taken from `build.md`, with no attribution.
- Later rounds and reworks resume the same Codex session (`resume: <sessionId>`, stored in
  `job.json`) with the review paths. That replaces the original's `SendMessage` to a
  named builder. A fresh session is used only when the stored one cannot be resumed, and
  the orchestrator says so.
- If `dispatch` fails or refuses (codex at 90 %), the job goes to `needs-human` with the
  error. There is no fallback model.

### Reviewers (DeepSeek, free)

All four start in one message as parallel `dispatch` calls: `backend: opencode`,
`model: opencode/deepseek-v4.1-flash-free`, `effort: max`, `mode: read-only`,
`dir: <worktree>`. The prompt is the role's prompt file plus the paths, the round, and
(for UX and UI) the port.

- The reviewer's final answer is its review, starting with `VERDICT: PASS` or
  `VERDICT: CHANGES`. The orchestrator writes it verbatim to
  `round-<N>/review-<role>.md` and updates `job.json` as each one lands.
- The UX and UI reviewers start the dev server on their port in the background, record
  its PID, and stop it by that PID. They pass `--session <job-id>-<role>` to every
  `agent-browser` call, as in the original.
- If the branch has no visible change, UX and UI write PASS and say so. This is the
  usual case for my-medusa-store backend work.
- A reviewer that fails, or whose answer doesn't start with a verdict, gets one rerun. A
  second failure stops the job and the orchestrator tells the owner (as in the original).

### Spec-writer and approver (Opus)

These are native subagents (`subagent_type: spec-writer` / `approver`, model `opus`),
taken from the original agent files. Their changes:

- Every `main` in them becomes `origin/dev`.
- The approver's ESCALATE list is tailored to these repos. It always escalates:
  - Prisma schema or migration changes
  - backfills or data scripts
  - auth/session or API hardening code
  - anything that modifies sales orders from purchasing flows
  - UPS/shipping label logic
  - deploy, CI, or env config
  - anything the spec flagged as needing owner judgment
  - a diff over roughly 400 changed lines

  It approves only small changes it would merge itself.

### Ending a job

The original's **Merge** step becomes **Open PR**:

1. Push from the worktree: `git push -u origin factory/<job-id>`.
2. `gh pr create --base dev --head factory/<job-id>`. The title is a short feature
   summary. The body holds the spec summary, the four final verdicts, and the approver's
   reason. It contains no AI mentions. `gh` runs as the configured account (boaterstop).
3. `stage: "pr-open"`, with `pr: <url>` in `job.json`. The worktree and branch stay, so
   CI or owner feedback can go through `/factory rework`.

Its triggers:

- APPROVE from the approver opens the PR right away.
- ESCALATE puts the job in `needs-human`, and the owner chooses between
  `/factory approve <job-id>` (open the PR) and `/factory rework <job-id> <note>`.
- `/factory rework` also works on a `pr-open` job. The builder resumes, the full review
  round and gate run again, and new commits push to the same PR branch. In this case the
  gate's APPROVE or `/factory approve` pushes to the existing PR and doesn't open a new one.

### Post-merge steps and `/factory cleanup` (owner's decision, 2026-10-19)

Owner's rule: anything a merge needs run by hand on dev or production is the factory's job,
never a list handed back. That covers migrations, backfills, data scripts, sweeps,
settings syncs and re-indexes.

- **Recording.** `build.md` ends with a `## Post-merge steps` section. Each step is one entry
  with its target (`dev` or `prod`), the exact command and where it runs (for example
  `ssh dev-apps 'docker exec replacenc-erp …'`), whether it is a dry run, and how to check
  that it worked. If nothing is needed, the section says "None." The code reviewer checks
  this list against the diff (a new migration or script with no step counts as CHANGES).
  The PR body copies the list.
- **`/factory cleanup`** checks each `pr-open` and `deployed-dev` job with `gh pr view`:
  - **PR merged into `dev`:**
    1. Wait for the Deploy Dev run of the merge commit to go green.
    2. Prove migrations through `prisma migrate status` on `dev-apps`. They apply when the
       container starts. Never run `prisma migrate dev`.
    3. Run every `dev` step in order, dry run first wherever the step has one, and run its
       check.
    4. If any `prod` steps are listed, set `stage: "deployed-dev"`. If not, remove the
       worktree, the local branch and the per-job database container, and set
       `stage: "merged"`.
  - **`deployed-dev` job whose merge commit has reached `origin/main` and whose prod deploy
    run is green:**
    1. Show the owner the `prod` steps and wait for a yes in the session. Production is
       owner-gated by the standing rules. *(Designer's call: one confirmation per job,
       not per step.)*
    2. Run them over `ssh prod-erp` / `ssh prod-vps`, dry run first, then the check.
    3. Remove the worktree, branch and container, and set `stage: "merged"`.
  - **A step fails, or its check doesn't pass:** stop that job and set
    `stage: "needs-human"` with the output. Never retry a data-changing step on its own.
  - **Closed, unmerged PRs:** list them for the owner, and delete nothing.
- **Approver.** Any job with `prod` steps escalates, which is already implied by the
  backfill/migration rule.

### Job stages

`spec`, `build`, `review`, `approve`, `pr-open`, `deployed-dev`, `merged`, `needs-human`. `MAX_RESUMES = 2`
(at most 3 review rounds), as in the original.

## Per-repo prerequisites

Each repo's CLAUDE.md/AGENTS.md must give the fresh-checkout setup, how to start the dev
server on a given port, and the test, build and lint commands.

- **replacenc-erp**: has CLAUDE.md and AGENTS.md.
  - Check that they cover worktree setup: shared Prisma client generation, and
    `npm install` when node_modules is empty.
  - E2E tests run sparingly on a private Postgres container with a distinct `E2E_PORT`.
    The builder and reviewers run unit tests, type-check and lint by default, plus only
    the E2E specs the change touches.
- **my-medusa-store**: has CLAUDE.md. Check that it has the same coverage.
- **ReplaceNCWeb**: has neither file. A CLAUDE.md with these sections gets written and
  goes in as a PR to `dev`.

## Calls made after the builder check (designer's calls, not the owner's)

- **Builder network.** Codex runs with network on for the builder role
  (`sandbox_workspace_write.network_access=true`). It needs npm and the local Postgres
  container. The builder does not run a dev server or a browser. Page checks belong to
  the UX and UI reviewers, so the builder gets no port.
- **No copying answers through Claude.** `dispatch` gets an `outputFile` parameter, and
  the answer is written straight to that path. The orchestrator reads only the first
  line of `build.md` and of each review. This keeps review text out of Claude's context.
- **Reviewer guard rails.** The `factory-reviewer` opencode agent denies `git commit`,
  `git push`, `git checkout`, `git reset`, package installs, and `rm`. It allows reads
  of `<repo>/.factory/`. After each round, the orchestrator runs
  `git status --porcelain` in the worktree. If a reviewer changed anything, the job stops
  and goes to `needs-human`. Nothing is discarded silently.
- **One dev server per round.** The orchestrator starts the job's dev server once before
  a review round, on the job's port, and stops it by PID once the UX and UI reviewers
  are done. Both reviewers use that one server, each with its own agent-browser session.
  The port is picked as a free port at job creation and stored in `job.json`. The
  original's number-based scheme collides across repos.
- **Repo prerequisites are part of this work.** The plan checks and fixes ERP's and
  my-medusa-store's docs, and writes ReplaceNCWeb's CLAUDE.md, each as its own PR to
  `dev`. `/factory` refuses to start in a repo whose CLAUDE.md/AGENTS.md has no factory
  section (setup, dev server on a port, validation commands).
- **Review data (owner's decision, 2026-10-19).** UX and UI reviewers never use the
  shared dev database. For ERP, each job gets its own Postgres container
  (`<job-id>-db`, `pgvector/pgvector:pg17`, on a free port stored in `job.json`). The
  container is seeded the way the E2E global setup does it, and the dev server points at
  it through a `DATABASE_URL` override. Reviewers sign in with the E2E admin session
  (`e2e/.auth/admin.json`), never with Authentik. `/factory cleanup` removes the
  container along with the worktree. my-medusa-store and ReplaceNCWeb state their own
  equivalent in their factory section.
- **Env files.** Worktree setup symlinks the main checkout's git-ignored env files
  (ERP `.env.local`, medusa `apps/backend/.env`), as listed in each repo's factory section.

## Left to the builder

- The exact JSON event parsing for `opencode run --format json`. Pin it with recorded
  sample output in tests, as the codex parser does.
- The dashboard's polling and its path handling for `.factory/`.
- Prompt wording, as long as the checklists, output formats and rules above hold.
- How `install.sh` symlinks agents and the opencode agent file (idempotent, like the
  skills loop).
