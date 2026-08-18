# Changelog

## Unreleased

- Added local-only activation milestones for setup, first real MP4, approval, publication, and repeat generation
- Added an explicit opt-in anonymous milestone reporter with no default endpoint
- Added reproducible GitHub growth baselines and public fork census reports
- Reworked the README around product outcomes and moved release history here
- Synchronized the in-repo provider catalog with current official model IDs and corrected Gemini free-tier claims

## v2.5

- **Operator-first dashboard** — live jobs, content pipeline, review queue, calendar, idea backlog, analytics, and channel setup in one responsive console
- **Asynchronous generation** — generation returns immediately with a persistent job ID; progress, errors, cancellation, and restart interruptions are visible
- **Approval-first publishing** — generated content must pass quality checks, factual review, media-rights confirmation, and human approval before it can be scheduled by default
- **Review studio** — preview real video and thumbnail assets, edit title/description/tags/privacy/schedule, reject, retry, or approve
- **Brand guardrails** — channel goal, audience, voice, CTA, visual direction, timezone, and blocked-topic policy guide generation and quality review
- **Actionable operations** — pause/resume automation, webhook-ready notifications, real activity history, and warning-free linting

## v2.4

- **Guided walkthrough for first-time setup** — `npm run walkthrough` explains each choice, opens provider pages, tests keys, guides Google Cloud setup, and saves progress
- **`.env` loading fixed** — runtime and setup tools now load local environment settings
- **Safer example environment** — placeholder credentials are commented out
- **Browser OAuth opens automatically** — YouTube authorization opens in the default browser

## v2.3

- **Gemini media pipeline** — Gemini image generation (`gemini-3.1-flash-image`) and narration (`gemini-3.1-flash-tts-preview`) are supported. Text and TTS currently have free tiers; AI image generation requires Gemini paid-tier access. Gradient visuals remain the no-image-provider fallback.
- **Faster slideshow rendering** — the renderer captures one still per slide and uses FFmpeg for video and crossfades
- **Better template topics** — template mode uses curated evergreen topics and rejects malformed trend fragments
- **Model catalog correction** — removed the nonexistent `gemini-3.5-pro` entry in favor of supported Gemini models

## v2.2

- Any configured AI text provider can satisfy startup credential validation
- FFmpeg is bundled through `ffmpeg-static`
- Successful production reaches the publish queue
- Silent real MP4 output is supported when TTS is not configured
- Startup reports real versus simulated capabilities
- Missing credentials and FFmpeg produce actionable warnings
- Publish-queue logging reports queue state and timing

## v2.1

- Real AI generation for strategy, scripts, and SEO
- Optional API-key protection for mutating routes
- Private-by-default publishing and placeholder upload protection
- Scheduler, dependency, database, and publish-queue fixes
- Template scripts no longer fabricate statistics
- ESLint and GitHub Actions CI

## v2.0

- Provider and media model refresh
- OpenAI SDK v6, `@google/genai` v2.9, `replicate` v1.4, and `googleapis` v173
- Revamped setup wizard and TTS selection
- Deprecated OpenAI SDK call patterns removed
- Dynamic year handling in content strategy
- Developer-focused README and Mermaid architecture diagrams
