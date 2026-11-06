# Status board and one-time cleanup

Owner approved the direction on 2026-11-06. This doc has two parts. Part 1 sets up a status board so work status lives in one place. Part 2 is a one-time cleanup of stale memory, repo docs, worktrees and files under `~/Work` and `~/.claude`. Build Part 1 first, because the cleanup moves owed items onto board pages.

## Why

Sessions pick up wrong information. The 2026-11-06 audit found the cause: status notes get written once and never updated when work ships.

- Memory (`~/.claude/projects/-home-aidan-Work/memory/`): of 77 files, 22 are "mostly done, some items owed" project notes and 3 are finished. Five contradict themselves or another source. Seven index descriptions say "pending" or "owner merges" for PRs that merged. Several still say "releases frozen" after v2.0.0 shipped on 2026-11-04.
- Repo docs:
  - The replacenc-erp `CLAUDE.md` is 33 KB, always loaded, and gives a wrong branch model (`develop`) and a wrong rate limit.
  - The ERP `AGENTS.md` says to use `prisma migrate dev`, which contradicts the owner's rule.
  - The my-medusa-store `CLAUDE.md` says prod is "not built yet".
  - `ReplaceNCWeb/medusa-context/CLAUDE.md` is an old copy that disagrees with the current one.
- Checkouts:
  - The main `replacenc-erp` checkout sits on merged branch `fix/726-3828-receiving-conditions`, 1,130 commits behind `dev`.
  - The main `my-medusa-store` checkout sits on `preserve/main-before-sync-20261002`, 114 behind.
  - Sessions started in either checkout read old docs.
- Disk: 15 worktrees for merged PRs hold about 11 GB. Ledgers sit in `~/Work/progress/` (15 MB) and `~/Work/.task-archives/` (53 MB).

When the owner wants to know what is owed on a feature, they ask the agent. The agent needs one place to answer from.

## Goals

- One page per piece of work (feature, bug, UI change, infra project). The agent reads that page to answer "what's still owed on X".
- Any session that learns something owed writes it on the page right away.
- A page moves to `done/` when nothing is owed, so open work and finished work are separate at a glance.
- Memory holds only lasting rules, owner preferences and reference facts.
- Repo `CLAUDE.md`/`AGENTS.md` files hold only instructions that are true today.
- Remove the bloat listed in Part 2.

## Non-goals

- No app, database or web UI for the board. It is plain markdown files.
- No code behaviour changes in any repo. Repo changes are docs only.
- The 3D-print folders (`f410-abs-270-110`, `f410-abs-no-m73`, `f410-pla-210-60`) stay.
- Line 3 of the replacenc-erp `CLAUDE.md` and the "boaterstop" line in `ReplaceNCWeb/frontend/AGENTS.md` stay as they are.

## Anti-goals

The work fails, even if every file gets cleaned, if any of these happens:

- Unpushed commits or uncommitted changes get lost.
- A worktree, DB container or file another session is using gets deleted.
- The board turns into another pile of stale notes. The verify-against-GitHub rule and the `done/` move below exist to prevent that.

## Part 1: Status board

### Layout

```
~/Work/status/
  BOARD.md            one line per open page
  <slug>.md           one page per open piece of work
  done/<slug>.md      finished pages
```

`~/Work/status/` is a plain folder, not a git repo (my call). Pages hold business detail (order numbers, owner decisions), so they stay off GitHub.

`BOARD.md` has one line per open page: `- [Title](slug.md) — repo, PR numbers, what's owed next, updated YYYY-MM-DD`. It has no other content. Done pages are not listed; `ls done/` finds them.

### Page

Keep a page under about 60 lines. A page has:

- Title and a two- or three-line description of what the work is and why.
- High-level plan: the main steps as a checklist. This is the overview, not the build plan; detailed plans stay in the repo's `docs/superpowers/plans/` or the factory job folder.
- Links: repo, branch, worktree path, PR numbers, design doc, plan doc, ledger folder, issue/ticket numbers.
- Owed: one line per item, each tagged with who owes it (`me` for an agent, `owner`) and the date it was added.
- Log: dated one-line entries for decisions and rulings, newest first.

Slugs are short kebab-case names, plus a ticket number when there is one (`bulk-payments`, `expired-quotes-726-1266`).

### Rules for every session

1. A page gets created when work will span sessions: a brainstorm design gets approved, the build-pipeline skill starts, a `/factory` job starts, or a bug fix needs follow-up after merge.
2. When something owed comes up (a prod check, an owner decision, a flake to watch, a follow-up fix), the session writes it on the page in the same turn, not in memory.
3. When asked what is owed, the session reads the page, then checks every PR and branch on it with `gh`/`git`. If the page is wrong (a PR listed open has merged, an item is already done), the session fixes the page first, then answers.
4. When Owed is empty, the session asks the owner, or follows the owner's word, then moves the page to `done/` and removes its `BOARD.md` line. Empty means all of it: merged, released, prod-checked, owner decisions made, worktree and test DB removed.
5. Edits are small `Edit` calls, not whole-file rewrites, because several sessions run at once. This session saw another session add a memory line mid-audit.

### Where the rules live

- `~/.claude/CLAUDE.md` (global, always loaded; a plain file that `install.sh` does not manage, so edit the live file): a short "Status board" section with rules 1–5 in about 10 lines.
- `skills/build-pipeline/SKILL.md`:
  - Create or update the page at plan time.
  - Copy owed items to the page at the PR, dev E2E and cleanup stages.
  - `progress.md` in the worktree ledger stays the stage-by-stage log; the board page is the summary.
- `skills/factory/SKILL.md` and `subcommands.md`:
  - Job start creates a page that links `.factory/jobs/<job-id>`.
  - `/factory cleanup` moves the page to `done/` when nothing is owed.
- Memory `MEMORY.md`: one line pointing at the board. Memory type `project` gets no new files; status goes on pages.

Both skill files had uncommitted edits on 2026-11-06: `M skills/factory/SKILL.md` (11 insertions, 108 deletions), plus untracked `skills/build-pipeline/` and `skills/factory/subcommands.md`. The owner had them committed as PR #4 (`skills/build-pipeline-and-factory-split`); build the skill changes after #4 merges. Skill edits go on a branch off `main` in this repo with a PR to `main`. This repo has no `dev`. `feat/factory` has no commits beyond `main` and is checked out in another worktree; leave it alone.

## Part 2: One-time cleanup

Run the steps in order. Before deleting anything, look at it. For any git checkout, check `git status --porcelain` and unpushed commits (`git log origin/<branch>..HEAD` or "no upstream") first.

### Step 1: Board pages from memory

Create a page for each memory file below and move its owed items, links and log lines onto the page. Re-check each owed item with `gh`/`git` while moving it; the audit found many are already done. Pages with nothing left owed go straight to `done/`. Then delete the memory file and its index line.

The audit classed these 22 files PARTLY-DONE. Each owed item below is what the 2026-11-06 audit recorded:

| Memory file | Owed per audit |
|---|---|
| beast-backups-project | prod-vps Medusa DB backup, host-config backup; DR drill claim in the index is not in the file |
| blocked-seller-purchase-2116 | dev migration + E2E on fresh DB, mark 726-2116 fixed, remove worktree |
| bundle-po-sent-9906 | tracker note on 726-9906, prod check, owner decisions (no-PO bundle, backfill, hotfix) |
| cloudflare-dashboard-sso-authentik | connector still disabled (ask before enabling), new-location alert untested, company MFA waits on owner's boss |
| crowdsec-npmplus-spec | phase 2 review overdue since 2026-10-09; HTTP scenarios in simulation; ERP IP allowlist, Tailscale deferred |
| ct111-oom-knowledge-lanes | owner options: postgres Restart=on-failure + OOM guard, lane counts |
| ebay-api-quota-growth-check | Browse 15k Growth Check reply; daily run stays off (rule stays in scrape-schedule-stays-off) |
| erp-db-timezone-new-york | owner-run prod `ALTER DATABASE ... SET timezone TO 'UTC'` + restart; 7-creates/151-reports sync check |
| erp-open-followups | split each item onto its feature's page or drop it if v2.0.0 shipped it; verify item by item |
| expired-quotes-726-1266 | prod sweep check (200 per 30-min run), dashboard counts; sweep audit rows, held-intake exception, emailed PDF date not dev-verified |
| fast-website-sync-prs | #862 measurements comment, route-side prod check, 500-SKU auto-accept timing |
| manual-facts-review-plan2 | worktree + mfr-db cleanup, release, prod Sync permissions, owner turns on paid reads, plan 3 writer, Generate lumping fix |
| nda-phone-required-prs | prod check; quoted/customer_account not gated; Accept drops ship-to name |
| network-unification | Spectrum DHCP/DNS (secondary stays 1.1.1.1), Cloudflare erp-test CNAME + tunnel, secmon PR #1, homelab PR #2 |
| photo-station-design | A2 (worktree serial-protection-a2), A3 detection, then B and C |
| pr931-manual-captures | #961 and #963 ship next release; owner confirms zip on prod |
| secmon-crowdsec-dashboard | projects 3–4; owner deletes remote branch feat/crowdsec-dashboard, CT 104 reboot check, n8n group binding, Cloudflare token check |
| settings-regroup-design | dev E2E loop, remove worktree |
| stripe-dev-e2e | resolve the D1/D2/D6/D7/E4/E5/F1/F2 contradiction; remove worktrees replacenc-erp-descriptor and -e2efix |
| ups-power-alerts-design | after-hours FSD test; owner BIOS restore-on-AC |
| website-checkout-feature-specs | unpushed draft specs (worktree web-checkout-specs); UX nits in the file |
| website-purchase-drop-findings | Merchant Center logo review result; optional blue/green deploy follow-up |

These in-flight memories also become open pages: `bulk-payments-build`, `pricing-autopilot-design`, `numeral-pre-sept-backfill`, `godaddy-m365-email-migration`, `fact-extraction-paused` (state: factSlots 0 on prod and dev until owner says otherwise). For `fact-extraction-paused`, also keep a one-line rule memory "fact extraction stays paused until owner says so", because it is a standing rule.

These go straight to `done/`: `ci-dev-push-skip-946`, `manual-facts-build-pipeline`, `stripe-plan4-build`. Keep the rule "never enter real cards or charge on prod" from `stripe-plan4-build` as a rule memory if no existing memory covers it.

### Step 2: Fix the remaining memory

- `erp-e2e-needs-ci`: rewrite to the current truth (E2E runs locally on a private Postgres container, sparingly, CI does full suites). Drop the contradicting headline.
- `erp-shared-prisma-client` and `erp-empty-node-modules-npm-install`: check one live worktree. If node_modules is per worktree (ERP `CLAUDE.md` Factory section line 331 says so; the bulk-payments worktree has its own), rewrite both to match and merge them into one file.
- `stripe-build-review-pipeline`: delete. `build-pipeline-workflow` covers it. Move the Opus-fallback line that `subagents-use-sonnet-haiku` cites into that file.
- `assistant-model-eval`: drop the superseded "keep Qwen on vLLM" verdict, keep the native-tool-calling finding.
- `ups-ship-to-attention-926-3547`: fix the description to match the body (no fallback anywhere).
- `evdi-kernel7-patch`: remove dangling link `[[display-topology-limits]]`.
- `erp-shared-worktree-wip`: drop the 2026-09 worktree names, keep the hazards.
- Remove "releases frozen" wherever it remains.
- Rebuild `MEMORY.md`. Use the headings Rules, Environment, ERP working knowledge, Infra, plus the board pointer, with each line under the right heading. The audit found Bulk payments, Expired quotes and Numeral under "Infra / other", and ct111/ci-ct107 under "ERP in flight".
- Delete `memory/archive/` (102 files) after Step 1. Its content is either on pages now or shipped. Before deleting, grep it for any owed item that no page has, and put any hit on a page.

### Step 3: Worktrees and checkouts

Leave these 6 worktrees alone:

- `replacenc-erp-fewer-manual` (pricing autopilot, 21 dirty)
- `replacenc-erp-queue-refill` (3 dirty)
- `replacenc-erp/.worktrees/bulk-payments-design` (18 dirty)
- `replacenc-erp/.worktrees/manual-facts-review` (PR #971 open)
- `replacenc-erp/.worktrees/removal-ui-gaps` (PR #970 open)
- `replacenc-erp/.worktrees/vision-page-reading` (PR #755 merged, but it has 22 uncommitted fixture changes; the owner said leave it for now)

Remove these 14 worktrees whose PRs merged with `git worktree remove`, after the checks above. `ReplaceNCWeb-cardform` has only untracked `frontend/test-results/`, which can go.

| Worktree | Branch | PR | Note |
|---|---|---|---|
| `.worktrees/docs-compress` | docs/compress-agent-docs | 942 | |
| `.worktrees/manual-capture-design` | chore/capture-extension-zip-install | 961 | |
| `.worktrees/settings-regroup-design` | feature/settings-regroup | 905 | after its dev E2E item is on the board page |
| `replacenc-erp-descriptor` | fix/stripe-statement-descriptor | 908 | |
| `replacenc-erp-e2efix` | fix/stripe-e2e-erp-followups | 933 | |
| `replacenc-erp-lastattempt` | fix/card-last-attempt-stale | 909 | |
| `replacenc-erp/.worktrees/blocked-seller-purchase` | feature/blocked-seller-purchase-726-2116 | 913 | ledger is in the worktree: copy owed items to the page first |
| `replacenc-erp/.worktrees/serial-protection-a2` | feature/serial-protection-a2 | 965 | check photo-station page first; A2 may continue on a new branch |
| `replacenc-erp/.worktrees/stripe` | feat/stripe | 854 | |
| `ReplaceNCWeb-card-polish` | fix/stripe-card-form-polish | 148 | |
| `ReplaceNCWeb-cardform` | fix/card-form-consent-layout | 152 | only `frontend/test-results/` untracked |
| `ReplaceNCWeb-stripe` | feat/stripe | 146 | |
| `ReplaceNCWeb/.worktrees/erp-image-cache` | feature/erp-image-cache-forget | 155 | |
| `.worktrees/medusa-billing-phone` | fix/erp-billing-phone | 64 (Medusa) | |

Push these 7 worktrees with unpushed local commits to `archive/<worktree-name>` branches on their GitHub repo, then remove them (my call; owner can ask to delete without pushing):

- `.worktrees/erp-ci-repair-20261005` (2 commits)
- `.worktrees/stripe-spec-failure-modes` (0 commits ahead of dev: remove without pushing)
- `replacenc-erp/.worktrees/company-sources-design` (2)
- `replacenc-erp/.worktrees/extraction-eval` (45, plus 2 untracked `.tmp.ts` files: drop those)
- `replacenc-erp/.worktrees/photo-station-design` (3)
- `replacenc-erp/.worktrees/sku-global-availability` (4, plus 8 modified files: commit them on the archive branch with message "WIP snapshot")
- `replacenc-erp/.worktrees/web-checkout-specs` (2; its page links the archive branch)

Also:

- Delete leftover folder `replacenc-erp/.worktrees/price-intel-popover` (436 KB, not a registered worktree). Check its contents first.
- Run `git worktree prune` in each repo. Delete local branches whose PRs merged and whose worktree is gone.
- Move the main `replacenc-erp` checkout to `dev` and pull. It is clean today, but other sessions move HEAD there (memory `erp-shared-worktree-wip`). Check `git status` and branch right before switching; if dirty or on a branch that is not the merged #816 branch, stop and ask.
- Move the main `my-medusa-store` checkout to `dev` and pull. `preserve/main-before-sync-20261002` has no PR. Check whether it has commits absent from `origin/main` and `origin/dev`; if so, push it to GitHub under the same name before switching.
- `ReplaceNCWeb` is on `dev` already; pull.
- Drop the per-repo test DB containers of removed worktrees (`docker ps -a` names with the worktree slug, for example `mfr-db`) once their pages say they are no longer needed. Use the container name; no pattern kills (memory `no-pattern-pkill`).

### Step 4: `~/Work` folders

Delete:

- `capture-extension-dev` (compiled build of `replacenc-erp/extensions/manual-capture`, pointed at erp-dev; no browser profile loads it)
- `cpi-c20`, `brand-assets` (owner said they can go)
- Old audit outputs: `analytics-concepts`, `company-source-mockups`, `manual-capture-mockups`, `settings-redesign-mockups`, `test-report-mockups`, `outputs`, `tries`, `pr755-dev-evaluation`, `supplier-audit-20261015`, `catalog-manual-audit-20261005`
- `archive/` and `.task-archives/` after grepping both for owed items no page has
- Empty folders `.aws`, `.codex`
- The empty `~/Work/.git` folder. It makes tools report `~/Work` as a git repo.

`progress/`:

- `bulk-payments`, `manual-facts-review` and `numeral-backfill` belong to open work. Link each from its page and keep it until the page moves to `done/`.
- For every other subfolder, copy owed items to a page, then delete it: `6869-piece-3-sdd`, `868-dev-e2e`, `capture-clock-skew`, `ci-runner-restart`, `ebay-daily-pacing-sdd`, `expired-quotes-726-1266`, `manual-capture-dev-e2e`, `serial-protection-a1`, `stripe-dev-e2e`, `stripe-plan4`.
- Delete the loose 6869 logs and `oc-*.sh` scripts.
- From now on, a ledger folder gets deleted when its page moves to `done/`. Add that to rule 4.

Keep: the three repos, the 3D-print folders, `homelab-infra`, `security-monitoring`, `dev-pipeline`, `personal`, `claude-desktop` (AUR package clone), `.claude`, `.mise.toml`, `.worktrees` (now holds only active worktrees).

### Step 5: `~/.claude`

- Delete the 105 `projects/` folders whose directory no longer exists (about 100 MB). Decode each name back to a path and confirm the path is gone before deleting. None of them has a memory folder.
- Leave `security/` (316 MB) alone. It is the security plugin's virtualenv and per-session state.
- Delete `backups/pre-claude-config-2026-10-14` (17 MB), the config from before `claude-config` took over (owner OK 2026-11-06).

### Step 6: Repo docs (one PR per repo against `dev`, owner merges)

Use the owner's writing rules (memory `writing-rules`) and the no-attribution rule. Do not edit migration SQL comments, because editing them changes Prisma checksums. Do not touch line 3 of `CLAUDE.md`.

replacenc-erp:

- `CLAUDE.md`:
  - Fix the branch model to `main` → `dev` → feature (§23).
  - Fix the rate limit to `api-read` 300/min, `api-write` 100/min (§15/§17; `src/middleware.ts:129-130`).
  - Delete blocks that `docs/BUSINESS-RULES.md` already holds in full. The audit lists them with line numbers: Company sources, Shared AI retrieval, Document Statuses, Contact/Company, Blind/Drop-Ship, Confirmed Business Rules, Frontend shared components. Leave a one-line pointer for each.
  - Move the CI internals paragraph (§13) to `docs/TESTING.md`.
  - Move the Factory section (lines 330-337) to `docs/runbooks/factory.md`. Make the runbook read secrets from `e2e/setup/global-setup.ts` and `playwright.config.ts` by path instead of quoting them. Leave a one-line pointer.
  - Drop incident narratives where the rule stands without them (line 94, 137-139).
  - Line 149 (taxonomy website content publish "paused until the Phase 0 pull"): the owner thinks this is wrong. Check the code on `origin/dev` for a publish gate and the git log for the Phase 0 pull. If no gate exists, delete the line and its copy at `docs/BUSINESS-RULES.md:70`. If a gate exists, keep both and note it on the cleanup page.
  - §17's "SMTP + Nextcloud still read env vars": check `src/lib/integrations/registry.ts` and the settings service, then make the line match the code.
- `AGENTS.md`: replace "Schema changes go through `prisma migrate dev`" with the `docs/TESTING.md:939` recipe (`migrate diff` + `db execute` + `migrate resolve`, never `migrate dev`).
- `docs/SDLC.md`: `develop` → `dev`; replace "deploy to staging (future)" with the dev tier.
- `README.md`: Next.js 14 → 15, fix `docs/UI_GUIDELINES.md` → `docs/UI-GUIDELINES.md`, drop stale counts.
- Delete root duplicates `BUG-REPORT-2026-08-12.md`, `BUG-TRIAGE-VERDICTS-2026-08-12.md`, `SECURITY-REVIEW-2026-07-30.md`, `BUG_REPORT_GPT-5.6-SOL_2026-08-12.md` (identical copies live under `docs/`), plus `plans/bug-triage-2026-08-12.md` and the tracked `.superpowers/sdd/2026-09-14-github-issue-sync-concurrency-hardening/branch-fix-report.md`.
- Move `docs/launch/stripe-go-live-checklist.md`, `docs/refactoring-audit-2026-09-29.md` and `docs/URL_FileStructure_Plan.md` to `docs/archive/`.
- `docs/superpowers` (20 MB):
  - Delete plans for shipped work: all of `archive/plans/` (156 files, about 11 MB) and October/November `plans/` whose PR merged. Keep plans for open work: serial-protection A2, manual facts, bulk payments, pricing autopilot.
  - Keep all specs, which record why things were built.
  - Rewrite or drop every reference to a deleted plan (grep `docs/superpowers/plans` and `docs/superpowers/archive/plans` across the repo, excluding migrations).
- Fix the 72 `docs/decisions/*.md` links that point at `docs/superpowers/{plans,specs}/X` when the file is under `archive/`. Links to deleted plans become plain text with the PR number. The one missing target, `specs/2026-07-10-avalara-tax-design.md`, becomes plain text.
- `TESTING.md:74-75`: drop the hard-coded test counts.

my-medusa-store:

- `CLAUDE.md`:
  - Rewrite Environments (dev deploys from registry images, prod is live on prod-vps via `deploy.yml`).
  - Fix the CI/CD table (ci.yml runs on push and PR to main and dev; deploy-dev.yml on dev; add deploy.yml).
  - List the 8 custom modules plus numeral-tax and erp-rates providers.
  - Update subscribers to the 11 `erp-*` files.
  - Add `SMTP2GO_API_KEY`, `ERP_ALERT_TO`, `ERP_ALERT_FROM`.
  - Fix Gotcha 3 to `apps/backend/.env.template`.
  - Node `>=20.19`.
  - Mark Gotchas 1–2 as local docker-compose only.
- `docs/ERP-INTEGRATION.md`: fix the subscriber count and table.
- Delete the stock Medusa boilerplate READMEs (`apps/backend/README.md`, `src/modules/README.md`, `src/subscribers/README.md`) if nothing links them.

ReplaceNCWeb:

- Delete `medusa-context/CLAUDE.md`, an old copy of the my-medusa-store file that contradicts it. Move `medusa-context/`'s June–July snapshots (`ORDER-NUMBER-SYNC.md`, `ERP-SYNC-HANDOFF.md`, `ACCOUNTS-EMAIL-SETUP.md`, `medusa-test-app.html`) to `docs/archive/`.
- `CLAUDE.md`: fix the CI line (ci.yml runs `npm test` plus Playwright E2E; `frontend_build.yml` builds on push and PR to main and dev). Drop the point-in-time "lint reports errors on dev" note after checking it.
- Move `docs/` and `frontend/docs/launch/` historical files to `docs/archive/`: the June–July planning notes, launch runbooks, and `parked/quote-checkout-alternatives`. Fix `docs/docker-deploy.md` for prod on prod-vps.
- Move shipped `docs/superpowers` and `frontend/docs/superpowers` plans to `archive/`, or delete them, using the same rule as the ERP repo.

### In-use check

Right before removing any worktree, folder or container, check that nothing is using it (my call):

- No process has its working directory inside it: `ls -l /proc/*/cwd 2>/dev/null | grep <path>`.
- No file in it changed in the last 24 hours.
- For containers, no other worktree's `.factory/jobs/*/job.json` or ledger names them.

If any check hits, skip the item and record it on the cleanup page.

### Owner gates

The owner answered the up-front questions on 2026-11-06. Their answers are in the steps above: skill edits in PR #4, line 149, `backups/`, and `vision-page-reading`. During the run, stop only for:

- a dirty or unexpected main checkout
- anything the in-use check flags

Moving a page to `done/` during this cleanup needs no per-page OK when `gh`/`git` show everything on it shipped. It needs an OK when any item is an owner decision or a prod check.

### Unverifiable owed items

When an owed item can't be checked with `gh` or `git` (owner decisions, prod state, conflicting notes such as the `stripe-dev-e2e` D/E/F rows), keep it on the page tagged `unverified` (my call). A noisy page is cheaper than a lost item. The owner can strike items when they read the board.

### Tracking this cleanup

This cleanup gets its own page, `~/Work/status/cleanup-2026-11.md`, created in Part 1. It records skipped items and owner answers.

## Constraints

- Several sessions work at the same time. Never stash, reset or clean in a shared checkout. Stage by path.
- Repo changes go through PRs; the owner merges. No direct pushes to `dev` or `main`.
- No AI attribution in commits, PR bodies, branch names or committed docs (global `CLAUDE.md`). Check before pushing.
- Prod DB actions are owner-only.
- The repo-docs PRs in Step 6 target `dev` in the three ReplaceNC repos. Claude-config changes target `main`.
- Subagents run on Sonnet or Haiku; at most one Opus at a time.

## Left to the builder

- Exact page and `BOARD.md` wording, within the shape above.
- Slug names.
- Order of work inside each step.
- Whether a borderline memory file is a rule (keep) or status (page), using the test "would this still be true after the feature ships?"
