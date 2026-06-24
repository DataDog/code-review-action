# code-review-action

A reusable GitHub Actions workflow that runs an AI model as a read-only code reviewer on pull requests, with a three-job security split and support for multiple providers.

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
| `prompt_file` | string | `""` | Newline-separated list of Markdown review guide paths (read from the default branch). Root-level files apply to all PRs; subdirectory files apply only when changed files share that prefix. Falls back to a built-in prompt when empty or no file matches. |

## Custom review guide

Pass a newline-separated list of paths via `prompt_file`. Files are read from the **default branch** only — a PR cannot rewrite its own review instructions.

**Scoping rule:** a file at the repo root applies to every PR; a file under a subdirectory (e.g. `bazel/guide.md`) applies only when at least one changed file lives under that directory.

```yaml
prompt_file: |
  guide.md          # applies to every PR
  bazel/guide.md    # applies only when bazel/ files changed
  pkg/auth/guide.md # applies only when pkg/auth/ files changed
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

## Security model

The pipeline uses a **three-job split**:

```
gate  ──►  review_{provider}  ──►  post
```

| Job | GitHub permissions | What it does |
|---|---|---|
| `gate` | `contents: read`, `pull-requests: read` | Validates the trigger, authorizes the actor (on_demand), resolves PR SHAs. |
| `review_*` | `contents: read`, `pull-requests: read` | Runs the AI with read-only tools. No write permissions. |
| `post` | `contents: read`, `pull-requests: write` | Downloads the artifact, re-scans, posts the review. Never runs AI. |

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

## Schemas

- [`schemas/github-review.json`](schemas/github-review.json) — JSON schema for the AI review payload (GitHub `POST /pulls/{n}/reviews` shape). Used by Claude and Gemini; Codex uses the same shape via an inline schema written at runtime.

## Limitations

- Fork PRs are not reviewed in `always` mode (provider API keys would be exposed to untrusted code). Use `on_demand` if you want to review fork PRs selectively.
- The `gemini` provider uses `--yolo` (auto-approve all tool calls) as required by the upstream action. Tool restriction is enforced via the `settings` input using `tools.core` with snake_case built-in names (`read_file`, `glob`, `grep_search`, `list_directory`).
- All three providers use the same output format (`github-review.json` shape). The `review_event` policy controls whether `REQUEST_CHANGES` and `APPROVE` are passed through or downgraded to `COMMENT`.
