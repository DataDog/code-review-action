# code-review-action

A reusable GitHub Actions workflow that runs an AI model as a read-only code reviewer on pull requests, with a six-stage security split and support for multiple providers.

## Providers

| Input value | Action used | Secret required |
|---|---|---|
| `claude` (default) | [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) | `anthropic_api_key` |
| `codex` | [openai/codex-action](https://github.com/openai/codex-action) with Codex CLI `0.144.5` | `openai_api_key` |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) `0.47.0` | `gemini_api_key` |

## Trigger modes

| `trigger_mode` | When it runs | Auth check |
|---|---|---|
| `always` (default) | Every PR event (`opened`, `reopened`, `synchronize`, `ready_for_review`). Fork PRs are skipped automatically. | None — only same-repo PRs are processed. |
| `on_demand` | When a collaborator with **write access** comments `/dd-review` on a PR. | Commenter must have `write`, `maintain`, or `admin` permission. |

You can enable both modes at once by wiring up both event triggers in the calling workflow.

## Quickstart

```yaml
# .github/workflows/ai-review.yml
name: AI Code Review

on:
  # Remove whichever trigger you do not want
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created]

jobs:
  review:
    uses: DataDog/code-review-action/.github/workflows/code-review.yml@355e6507276ad912a4cd82f8bc1b363cede290a4 # v1.0.0
    with:
      provider:      claude        # claude | codex | gemini
      trigger_mode:  on_demand     # always | on_demand
      review_event:  COMMENT_ONLY  # COMMENT_ONLY | ALL
      prompt_file:   .claude/review-prompt.md   # optional
    secrets:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      # openai_api_key:  ${{ secrets.OPENAI_API_KEY }}
      # gemini_api_key:  ${{ secrets.GEMINI_API_KEY }}
```

### Required secrets

Add the API key for your chosen provider as a repository secret:

- `ANTHROPIC_API_KEY` — for Claude
- `OPENAI_API_KEY` — for Codex
- `GEMINI_API_KEY` — for Gemini

## Inputs

| Name | Type | Default | Description |
|---|---|---|---|
| `provider` | string | `claude` | AI provider: `claude`, `codex`, or `gemini`. |
| `trigger_mode` | string | `always` | `always` runs on PR events; `on_demand` requires a `/dd-review` comment from a write-access collaborator. |
| `prompt_file` | string | `""` | Newline-separated list of Markdown review guide paths (read from the default-branch commit pinned by `gate`). Root-level files apply to all PRs; subdirectory files apply only when changed files share that prefix. Falls back to a built-in prompt when empty or no file matches. Mutually exclusive with `prompt_file_pattern`. |
| `prompt_file_pattern` | string | `""` | Glob pattern (evaluated against the default-branch commit pinned by `gate`) used to auto-discover review guide files instead of listing them, e.g. `**/codereview_guideline.md`. Every matched file follows the same scoping rule as `prompt_file`. Mutually exclusive with `prompt_file`. |
| `review_event` | string | `COMMENT_ONLY` | `COMMENT_ONLY` always posts a non-approving review. `ALL` allows the model to request changes or approve. |

## Custom review guide

Pass a newline-separated list of paths via `prompt_file`, or a single glob via `prompt_file_pattern` to auto-discover guide files instead of listing them explicitly. The two inputs are mutually exclusive — the workflow fails fast if both are set. Files are read from a commit snapshot of the **default branch** pinned by `gate` — a PR cannot rewrite its own review instructions, and a branch update during the run cannot change them.

**Scoping rule:** a file at the repo root applies to every PR; a file under a subdirectory (e.g. `bazel/guide.md`) applies only when at least one changed file lives under that directory. This rule applies identically whether the file came from `prompt_file` or was discovered via `prompt_file_pattern`.

```yaml
prompt_file: |
  guide.md          # applies to every PR
  bazel/guide.md    # applies only when bazel/ files changed
  pkg/auth/guide.md # applies only when pkg/auth/ files changed
```

Or, to have every directory's own guide picked up automatically (as used on `datadog-agent`):

```yaml
prompt_file_pattern: '**/codereview_guideline.md'
```

Each file is plain Markdown. Example content:

```markdown
# Review guide

Review as a senior Go engineer.

- Enforce the error-wrapping convention: `fmt.Errorf("context: %w", err)`.
- Flag any use of `interface{}` where a typed interface could be used.
- Only comment on lines present in the diff.
```

The workflow appends a standardized output-format section automatically, so you do not need to describe the JSON shape in your guide files.

## `find-guidelines` CLI

The guideline discovery/scoping/aggregation logic that powers `prompt_file` and `prompt_file_pattern` inside the workflow (`src/guidelines.js`) is also exposed as a standalone, dependency-free CLI so other tooling — e.g. a local dev command in another repo — can reuse the exact same implementation instead of reimplementing it:

```
node bin/find-guidelines.js \
  --repo-root /path/to/repo \
  --pattern '**/codereview_guideline.md' \
  --base main
```

Run `node bin/find-guidelines.js --help` for the full flag list (`--prompt-file` for an explicit list instead of `--pattern`, `--changed-files`/`--head` to control the diff, `--builtin`/`--builtin-file` for a fallback). It prints one JSON object to stdout:

```json
{
  "error": null,
  "included": 2,
  "guidelines": [{ "path": "codereview_guideline.md", "content": "..." }],
  "guidelinesBody": "...",
  "info": ["..."]
}
```

Exit code is `1` when `error` is set, `2` on a usage error, `0` otherwise. `bin/find-guidelines.js` is also declared as the `find-guidelines` package `bin` entry, so it can be invoked via `npx github:DataDog/code-review-action#<ref> find-guidelines ...` from a repo that doesn't vendor this one.

## Security model

The pipeline uses a **six-stage split** (only the selected provider job runs):

```
gate  ──►  start_signal + prepare  ──►  review_{provider}  ──►  post  ──►  finish_signal
```

| Job | GitHub permissions | What it does |
|---|---|---|
| `gate` | `contents: read`, `pull-requests: read`, `checks: write` | Validates inputs and the trigger, authorizes the actor (on_demand), pins PR and trusted-guide SHAs, and opens the check run. |
| `start_signal` | `pull-requests: write` | Adds the in-progress reaction for on-demand requests. Never runs AI. |
| `prepare` | `contents: read`, `pull-requests: read` | Generates a complete local diff for the pinned PR commits and assembles trusted review inputs. |
| `review_*` | `contents: read`, `pull-requests: read` | Runs the AI with read-only tools. No write permissions. |
| `post` | `contents: read`, `pull-requests: write` | Downloads the artifact, re-scans, posts the review. Never runs AI. |
| `finish_signal` | `pull-requests: write`, `checks: write` | Closes the check run, reports technical failures, and updates the on-demand reaction. Never runs AI. |

### Trust boundaries

- Claude and Gemini check the PR head out under `__untrusted/`; Codex uses the workspace root because its action expects a repository there. Claude is limited to `Read`, `Glob`, and `Grep`; Gemini and Codex have their provider-specific instruction/config files removed before model execution, and Codex clears PR-controlled artifact/output paths before downloading trusted inputs.
- `_prepare/untrusted/` contains the complete local PR diff and API-derived changed-file list for the SHAs pinned by `gate`. The workflow verifies the pull ref and API state during preparation, then checks the head again immediately before submission; it fails if the PR moved or closed.
- `_prepare/trusted/` contains the assembled review guide, common schema, and validator. The schema and validator are checked out from `job.workflow_sha`, the exact reusable-workflow revision. Review guides are read from the calling repository's default-branch commit pinned by `gate`.
- `post` treats every downloaded artifact as data: it checks out its validator independently at `job.workflow_sha`, downloads model output into an isolated directory, accepts only a bounded regular `review.json` file, and never executes artifact content.
- Fork heads are fetched through the base repository's `refs/pull/<number>/head` ref, so authorized `on_demand` reviews do not need credentials for the fork repository.

### Secret scanning (two passes)

Both `review_*` and `post` scan AI output for:
- GitHub token patterns (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`)
- Anthropic API keys (`sk-ant-*`)
- OpenAI keys (`sk-proj-*`, `sk-svcacct-*`, `sk-*`)
- Google Gemini API keys (`AIzaSy*`)
- AWS access keys (`AKIA*`)
- Private key headers
- Slack tokens (`xox[bpasr]-*`)

Any match suppresses the review and posts a failure notice instead.

### Prompt-injection canary

AI output is checked for shell commands (`curl`, `wget`, `bash`, etc.) and attempts to write to `$GITHUB_OUTPUT` or `$GITHUB_ENV`. Any match suppresses the review.

### Additional hardening

- `persist-credentials: false` on all checkouts — leaves no token in `.git/config`.
- Fork PRs are skipped in `always` mode to prevent API key exposure.
- In `on_demand` mode, the commenter's permission is checked via the `collaborators/.../permission` API (repo-scoped, not the org-wide `author_association` which would over-grant).
- The Claude action is SHA-pinned and runs in agent mode with only `Read`, `Glob`, and `Grep`; shell and write tools are explicitly denied. Project/local settings are disabled, execution is capped at 10 turns, and its subprocess isolation path provides best-effort credential scrubbing with bubblewrap where supported.
- Claude uses the action's schema-backed `structured_output`. The workflow validates and scans that exact value before artifact upload; it never searches the execution transcript or repairs malformed output.
- The Codex action and CLI are both pinned; Codex runs with the `:read-only` permission profile and `drop-sudo`. `AGENTS.md`, `AGENTS.override.md`, and other AI instruction files are removed at every directory depth before execution. Before the action's pre-sandbox CLI installation, PR-controlled `.npmrc` files are removed, npm user configuration is disabled, the public npm registry is selected explicitly, and lifecycle scripts are disabled.
- Gemini CLI is pinned to `0.47.0`, verified against a fixed SHA-512, and installed without lifecycle scripts or optional keychain/PTY dependencies. It runs in its digest-pinned matching Docker sandbox with an isolated home directory and receives only the Gemini API key plus minimal runtime environment; the GitHub token and Actions command-file paths are not inherited.
- Gemini extensions and MCP are disabled. Its only tools are `read_file`, `glob`, `grep_search`, and `list_directory`; repository `GEMINI.md` and `.gemini` content is removed at every depth before workspace trust is enabled.
- Gemini output is captured locally and validated before posting. It is never written to `GITHUB_STEP_SUMMARY`.
- Provider output is accepted only when it matches the complete shared schema. Invalid event values, missing `side`, unknown fields, and more than 100 comments fail closed instead of being repaired or truncated.
- Fork reviews are always posted as `COMMENT`; `review_event: ALL` can only pass through approvals or change requests for same-repository pull requests.
- Completion reactions use the event actually posted after policy enforcement. A model `APPROVE` downgraded by `COMMENT_ONLY`, or a review that falls back to an issue comment, cannot produce an approval reaction.
- Provider jobs have a 30-minute timeout so a stalled model or dependency fetch cannot occupy a runner indefinitely.
- Concurrency is keyed per PR and trigger mode so a replacement trigger cancels the prior in-flight run. A canceled run closes its check as `cancelled` without posting a false technical-failure comment or reaction.

## Schemas

- [`schemas/github-review.json`](schemas/github-review.json) — the single JSON schema for every provider and the GitHub review payload.
- [`src/scan.js`](src/scan.js) — the shared fail-closed validator and output scanner used in provider jobs and again before posting.

## Limitations

- Fork PRs are not reviewed in `always` mode (provider API keys would be exposed to untrusted code). Use `on_demand` if you want to review fork PRs selectively.
- Datadog's strict security pattern assumes `review_event: COMMENT_ONLY`. Selecting `ALL` deliberately relaxes that boundary for same-repository PRs and lets prompt-influenced model output approve or request changes; only enable it where merge policy explicitly permits AI-authored review decisions.
- Claude's read-only tools can inspect unchanged files for review context. Their filesystem access is broader than the prepared diff, so the PR checkout and all model output remain untrusted.
- The pinned Claude action installs its fixed CLI version through Anthropic's mutable installer endpoint at runtime; the action SHA does not pin that installer response.
- The `gemini` provider uses `--approval-mode yolo` only after reducing the tool registry to four read-only tools. It has no shell, write, MCP, or extension tool to auto-approve.
- Gemini's sandboxed CLI process needs network access to call the Gemini API. The workflow provides no model-callable network tool, but it does not enforce destination-level egress filtering on that API connection.
- GitHub's pull-request files API returns at most 3,000 files. The workflow detects an incomplete list and fails preparation rather than applying review-guide scope to partial data.
- Complete diffs larger than 1,000,000 bytes or 20,000 lines fail preparation instead of silently sending a truncated change to the model.
- All three providers use the same output format (`github-review.json` shape). The `review_event` policy controls whether `REQUEST_CHANGES` and `APPROVE` are passed through or downgraded to `COMMENT`.
