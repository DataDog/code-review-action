# code-review-action

A reusable GitHub Actions workflow that runs an AI model as a read-only code reviewer on pull requests, with a security-focused job split, support for multiple providers, and optional privacy-preserving Datadog telemetry.

## Providers

| Input value | Action used | Secret required |
|---|---|---|
| `claude` (default) | [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) | `anthropic_api_key` |
| `codex` | [openai/codex-action](https://github.com/openai/codex-action) | `openai_api_key` |
| `gemini` | [google-github-actions/run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli) | `gemini_api_key` |

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
      prompt_file:   .claude/review-prompt.md   # optional
      telemetry_enabled: false      # default; no Datadog configuration needed
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
| `prompt_file` | string | `""` | Newline-separated list of Markdown review guide paths (read from the default branch). Root-level files apply to all PRs; subdirectory files apply only when changed files share that prefix. Falls back to a built-in prompt when empty or no file matches. Mutually exclusive with `prompt_file_pattern`. |
| `prompt_file_pattern` | string | `""` | Glob pattern (evaluated against the default branch) used to auto-discover review guide files instead of listing them, e.g. `**/codereview_guideline.md`. Every matched file follows the same scoping rule as `prompt_file`. Mutually exclusive with `prompt_file`. |
| `telemetry_enabled` | boolean | `false` | Submit review-run and provider usage metrics to Datadog from an isolated job. |
| `datadog_site` | string | `datadoghq.com` | Datadog site parameter. Standard US, EU, AP, UK, and government sites are accepted; URLs and arbitrary hosts are rejected. |

## Optional Datadog telemetry

Telemetry is disabled by default. Enabling it does not grant Datadog credentials to `gate`, `prepare`, `review_claude`, `review_codex`, `review_gemini`, `post`, or either request-signal job. A single `telemetry` job, which runs once after every provider job settles, checks out only this action's repository at the exact reusable-workflow revision; it never checks out PR code or downloads the review, diff, prompts, PR description, or model output.

### API-key configuration

No Datadog application key is required, only an API key. The reusable workflow itself has no OIDC/dd-sts surface — it only accepts an optional `datadog_api_key` secret and hands it, unmodified, to the isolated `telemetry` job:

```yaml
jobs:
  review:
    uses: DataDog/code-review-action/.github/workflows/code-review.yml@<sha>
    with:
      provider: codex
      telemetry_enabled: true
      datadog_site: datadoghq.com
    secrets:
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
      datadog_api_key: ${{ secrets.DATADOG_API_KEY }}
```

**Internal DataDog callers: minting a short-lived key with dd-sts.** Because this workflow runs directly on `pull_request`/`issue_comment` events (not `pull_request_target`), a GitHub environment cannot be used to gate a stored secret behind an approval step. Internal callers that would rather not store a long-lived API key can mint one at runtime via [dd-sts](https://datadoghq.atlassian.net/wiki/spaces/SECENG/pages/5769659435/User+guide+dd-sts) in their **own** workflow, in a dedicated job that requests the OIDC token, and pass the result into `secrets.datadog_api_key`:

```yaml
jobs:
  dd_sts:
    runs-on: ubuntu-latest
    continue-on-error: true   # fail-open: `review` still runs if dd-sts is unavailable
    permissions:
      id-token: write
    outputs:
      api_key: ${{ steps.dd-sts.outputs.api_key }}
    steps:
      - name: Get Datadog credentials
        id: dd-sts
        uses: DataDog/dd-sts-action@<sha>
        with:
          policy: my-repo-telemetry

  review:
    needs: [dd_sts]
    uses: DataDog/code-review-action/.github/workflows/code-review.yml@<sha>
    with:
      provider: codex
      telemetry_enabled: true
      datadog_site: datadoghq.com
    secrets:
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
      datadog_api_key: ${{ needs.dd_sts.outputs.api_key }}
```

This requires a separate job because [a job that calls a reusable workflow cannot have its own steps](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#supported-keywords-for-jobs-that-call-a-reusable-workflow) — the credential has to be minted in one job and read via `needs.<job>.outputs` in the one that calls `code-review.yml`.

**Be aware:** GitHub Actions job outputs are never masked, regardless of how they're consumed downstream, and are readable via the Actions REST API for as long as the workflow run's logs are retained. In a public repository this means the minted key is visible to anyone for its TTL window, not just to the workflow. This repository's own `ai-review.yml` accepts that tradeoff for its short-lived, narrowly-scoped telemetry key; weigh it against your own threat model before copying the pattern, especially in a public repo. If that exposure is unacceptable, store a long-lived key as a regular repository secret instead (previous example) — the tradeoff there is a static credential rather than a public but short-lived one.

Missing credentials, an invalid site, and Datadog API errors produce GitHub warnings and remain fail-open: they do not change the review result.

### Metrics and tags

The `telemetry` job runs once, after every provider job settles, and submits a single batch of series covering the whole invocation:

- `code_review_action.review_runs`
- `code_review_action.provider_api_requests`
- `code_review_action.input_tokens`
- `code_review_action.cached_input_tokens`
- `code_review_action.output_tokens`
- `code_review_action.cost_usd`
- `code_review_action.duration_ms`
- `code_review_action.telemetry_missing`

All submissions are count metrics so values can be summed across dashboard windows. Tags are limited to `provider`, `trigger` (`manual` or `automatic`), validated resolved `model` (or `unavailable`), `status`, `cost_source`, and `repository`. Actor, PR number, SHA, workflow/run ID, filenames, prompts, descriptions, diffs, and model responses are never sent as metrics or tags.

### Usage and cost accuracy

Normalized usage schema version 1 accepts null for genuinely unavailable fields. `cost_source` means:

- `provider_reported`: the provider supplied the cost directly. Claude currently provides this value and it is preferred.
- `estimated`: a tested local pricing table calculated the value. This workflow does not currently estimate any provider's cost.
- `unavailable`: cost is null, never zero. Gemini exposes structured request/token statistics but not cost. The pinned Codex action exports only its final message, not the CLI's structured usage stream, so Codex request/token/model/cost fields remain unavailable pending an upstream machine-readable output.

`code_review_action.telemetry_missing` is emitted whenever model, request, token, duration, or cost metadata is unavailable or rejected. Gemini output tokens include its candidate and thought-token billing dimensions; cached and uncached input are reported separately.

### Cancellation limitation

Telemetry uses `always()` where GitHub Actions permits, so `telemetry` still runs for a request that failed or was superseded by a newer `/dd-review`, with `status` tagging the outcome. A hard workflow cancellation can still prevent artifact upload or the downstream finish job from running at all. Provider billing reconciliation remains the authoritative source for cost.

## Custom review guide

Pass a newline-separated list of paths via `prompt_file`, or a single glob via `prompt_file_pattern` to auto-discover guide files instead of listing them explicitly. The two inputs are mutually exclusive — the workflow fails fast if both are set. Files are read from the **default branch** only — a PR cannot rewrite its own review instructions.

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

The core review pipeline uses a split trust model, with optional telemetry on a separate branch:

```
gate ─► prepare ─► review_{provider} ─┬─► post
                                     └─► telemetry
```

| Job | GitHub permissions | What it does |
|---|---|---|
| `gate` | `contents: read`, `pull-requests: read` | Validates the trigger, authorizes the actor (on_demand), resolves PR SHAs. |
| `review_*` | `contents: read`, `pull-requests: read` | Runs the AI with read-only tools. No write permissions. |
| `post` | `contents: read`, `pull-requests: write` | Downloads the artifact, re-scans, posts the review. Never runs AI. |
| `telemetry` | `contents: read` | Submits one batch of metrics using the optional `datadog_api_key` secret. Never accesses PR/review content. The reusable workflow has no OIDC surface; callers that mint a key via dd-sts do so in their own workflow before invoking this one. |

### Trust boundaries

- The PR head is checked out into `__untrusted/` (full repo at PR state, for reference during review). The AI is instructed to treat all content there as untrusted user input.
- Trusted files (review guide, scripts) come from the **default branch** via sparse checkout. The PR cannot modify them.
- `.claude/settings.json` is **not** checked out to prevent plugin/MCP server loading that would expand the tool surface.

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
- The Claude sentinel `allowed_non_write_users: "__force_sandbox_dummy__"` activates subprocess isolation without granting any permission bypass.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"` prevents the Anthropic key from leaking into Claude's subprocesses.
- Concurrency is keyed per PR so a second trigger cancels the prior in-flight run.
- Datadog credentials are referenced only in the dedicated telemetry job. The downstream usage artifact is treated as untrusted: schema/provider/fields/numbers/tags are strictly validated, no artifact content is evaluated or interpolated into a shell command, and only allowlisted numeric metrics are submitted over HTTPS to a validated Datadog site.

## Schemas

- [`schemas/github-review.json`](schemas/github-review.json) — JSON schema for the AI review payload (GitHub `POST /pulls/{n}/reviews` shape). Used by Claude and Gemini; Codex uses the same shape via an inline schema written at runtime.

## Limitations

- Fork PRs are not reviewed in `always` mode (provider API keys would be exposed to untrusted code). Use `on_demand` if you want to review fork PRs selectively.
- The `gemini` provider uses `--yolo` (auto-approve all tool calls) as required by the upstream action. Tool restriction is enforced via the `settings` input using `tools.core` with snake_case built-in names (`read_file`, `glob`, `grep_search`, `list_directory`).
- All three providers use the same output format (`github-review.json` shape). The `review_event` policy controls whether `REQUEST_CHANGES` and `APPROVE` are passed through or downgraded to `COMMENT`.
