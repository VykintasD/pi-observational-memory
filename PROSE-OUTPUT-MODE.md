# Prose output mode (PARKED — reference branch)

**Status: PARKED 2026-09-29.** The local-observer idea is shelved pending better
models/hardware. This branch is kept on remote as a complete, documented
reference. It contains no production behavior that main lacks, and nothing
here is required by main. To revive, see [Resuming](#resuming).

## What this branch adds

| commit | content |
|---|---|
| `f9e26a3` | Prose output mode: `OM_OUTPUT_MODE=prose` switches the observer from native tool calls to one-shot prose output |
| `fa5d3ec` | Anchored line format + `CONFIRMATION:` marker (A/B-tested canonical format) |
| (uncommitted→last commit) | `src/spawn/launch.ts`: wires `PI_CONTEXT_SAFETY_TOKENS=512` for prose-mode observer workers |

Files touched: `agent/observer/prompt.ts` (prose system prompt + anchored
format in all paths), `agent/observer/fallback.ts` (lenient anchored-line
parser), `agent/index.ts` (soft warning on missing CONFIRMATION marker),
`src/hooks/observer-trigger.ts` (prose kickoff, exact marker wording, no
`Current local time` header), `src/spawn/launch.ts` (env wiring).

## Why prose mode exists

Small local models (Qwen2.5-Coder-3B, Phi-4-mini, Llama 3.2 3B) **cannot
reliably produce native tool calls** — Qwen2.5-Coder-3B fails the contract
entirely (full investigation:
`ai-local-setup` repo, `docs/observer-qwen25-coder-3b-findings.md`). Prose
mode makes the observer a pure one-shot: one prompt in, structured text out,
no tool round trips.

## Design (and the evidence behind it)

- **Anchored line format** `- [YYYY-MM-DD HH:MM]: observation` — won A/B vs
  bare lines 6/6 vs 4/6 (2/6 degeneration on bare). Anchors make parsing
  robust and the model's own output self-checking.
- **Fixed `CONFIRMATION: Observation pass complete.` line** — presence is a
  soft health signal (missing → stderr warning only, never a failure; lines
  are what matter).
- **Lenient regex parser** (`fallback.ts`) — accepts bullet or bracket
  anchors, dedups, 500-line cap.
- **Strict timestamp guards** — lines outside the chunk's time span are
  dropped; synthetic date `2020-01-02` in few-shot examples to avoid
  collision with real chunk timestamps; `Current local time` header is
  **omitted** in prose mode (small models otherwise stamp lines with run
  time).
- **Fail-on-empty** — 0 valid lines → exit 1 (no silent no-ops).
- **Sampling** — temperature 0.1 was verified to kill degeneration on
  llama-3.2-3b (0/6 degeneration at temp 0.1 vs recurring degeneration at
  0.2+); repeat_penalty 1.15.

## The pi context-clamp bug (found while testing this)

pi 0.84.4 hardcodes `CONTEXT_SAFETY_TOKENS = 4096` in
`clampMaxTokensToContext`: any one-shot prompt exceeding ~4k *estimated*
tokens on an 8192-ctx window gets clamped to `max_completion_tokens: 1` →
**silent empty output** (HTTP 200). This is a production hazard for any
large local prompt, not just this feature.

- Root cause, proxy-capture evidence, and the fix: `ai-local-setup` repo,
  `bench/prose_battery/INVESTIGATION-ctx-clamp.md`.
- Upstream issue report (draft, ready to file against
  @earendil-works/pi): `bench/prose_battery/INVESTIGATION-upstream-issue.md`.
- Fix status: we patched the global pi dist to honor a
  `PI_CONTEXT_SAFETY_TOKENS` env override (hence the `launch.ts` wiring
  above, which is a **no-op on unpatched pi** — harmless, kept for when the
  fix ships). **The dist patch was REVERTED on 2026-09-29**; pi is stock
  again. Until upstream ships the fix, prose-mode prompts above ~4k est.
  tokens on an 8192-ctx model will hit the clamp.

## Battery results (why it's parked)

Full battery (33 fixtures × 10 raw runs + 10 real-worker E2E) against
llama-3.2-3b, 8192 ctx — results and per-case tables in `ai-local-setup`
repo, `bench/prose_battery/` (README + `results/REPORT.md`).

- **Raw: 268/330 (81.2%)** — below the predefined 95% pass bar.
- **E2E (real worker): 10/10.**
- Failure clusters are **model capability**, not harness: needle fidelity
  (specific numbers/targets paraphrased away — decision-rationale 0/10),
  coverage on long/dense chunks (50-turn span 0/10), early EOS at ~80% ctx
  occupancy, 2 hallucinated timestamps (extrapolation, not clock leaks).
- The **consolidator** does not fit an 8192-ctx 3B at all (multi-turn tool
  loop + journey included verbatim → context wall after 1–2 tool calls, and
  fact-preservation is exactly the skill the battery showed the 3B lacks).
  Production consolidator stays cloud.

## Resuming

1. **Context headroom:** wait for the upstream pi fix (or re-apply the dist
   patch described in `INVESTIGATION-ctx-clamp.md` §9). The `launch.ts`
   wiring already sets the env var for prose observers.
2. **Model:** pick a model that clears the capability floor — the battery's
   failure clusters (number fidelity, dense-chunk coverage) are the
   acceptance criteria. 7B+ or a stronger small model; 8192 ctx suffices
   for the observer (it's one-shot), the consolidator needs more.
3. **Re-run the battery:** `ai-local-setup` → `bench/prose_battery/`
   (swap the model in the runner; raw 10 runs/case is the statistical
   baseline; E2E 10/10 + raw ≥ 95% was the original pass bar).
4. Cherry-pick `f9e26a3` + `fa5d3ec` + the `launch.ts` change onto current
   main (or merge this branch once it catches up).
