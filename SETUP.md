# Setup on a new machine

This walks through loading the extension in dev mode — pi runs the
TypeScript directly from the repo, nothing is installed or built — and
configuring the worker models. You need pi installed, Node.js, and a
stable path to put the repo in.

## 1. Clone the repo

```bash
git clone <repo url> ~/repos/pi-observational-memory
cd ~/repos/pi-observational-memory
npm install
```

`npm install` provides the pi packages the extension imports. There is no
build step for the TypeScript.

## 2. Point pi at the repo

Add the repo path to the `extensions` list in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/home/you/repos/pi-observational-memory"]
}
```

pi loads `src/index.ts` from the repo.

## 3. The Go CLI

The extension talks to the memory database (a SQLite file at
`~/.pi/agent/om/om.db`, created on first use) through a small Go CLI. On
Linux x86-64 you can use the committed binary at `cli/om` as-is. On macOS
or any other platform it must be built — one command, no CGO:

```bash
cd cli
go build -o om .    # needs Go 1.25+
```

## 4. Configure the models and Google auth

Add an `observational-memory` block to the same settings file:

```json
"observational-memory": {
  "models": {
    "observer":     { "provider": "google", "id": "gemini-3.5-flash-lite" },
    "consolidator": { "provider": "google", "id": "gemini-3.5-flash-lite" }
  },
  "compactAtContextTokens": 100000
}
```

The two models are the only required knobs; everything else falls back to
defaults. The `google` provider is built into pi and authenticates with
the `GEMINI_API_KEY` environment variable. Get a key from Google AI Studio
(aistudio.google.com/apikey) and export it in the shell that launches pi:

```bash
export GEMINI_API_KEY=...
```

The observer and consolidator subprocesses inherit pi's environment, so
this one export covers them.

## 5. The timing knobs

The pipeline has three clocks, and the knobs set when each one fires:

- **`chunkTokens`** — an observer fires every time this many new tokens
  have accumulated in the conversation. This is the "how often to observe"
  knob: 5000 observes roughly every 5k tokens of new conversation; 15000
  observes about three times less often. Smaller means finer-grained
  observations and more worker runs (more cost); larger means the opposite.
- **`compactAtContextTokens`** — compaction fires when the main session's
  context passes this. Set it below the context window of the model your
  main session runs on, with headroom to spare.
- **`tailTokens`** — at compaction, the most recent N tokens of the
  conversation are kept verbatim in the compaction block; everything older
  is covered by the observations instead. A larger tail keeps more recent
  detail but compresses less.
- **`poolTargetTokens` / `consolidateAtPoolTokens`** — observations
  accumulate in a per-session buffer. When the buffer passes
  `consolidateAtPoolTokens`, the consolidator folds the oldest
  observations into the durable store until the buffer is back down to
  `poolTargetTokens`, so it oscillates between the two. Keep the trigger
  around 2× the target. A lower target consolidates more often and keeps
  the in-context buffer smaller.
- **`journeyTargetTokens`** — the size of the running project history
  pushed into every compaction block. Past this size the consolidator
  compresses the oldest parts. Leave it at the default unless you want
  more or less of that section.
- **`observerConcurrency`** — how many observer subprocesses may run at
  once. Fine to raise for a fast, cheap cloud model; keep it at 2 for a
  local model.

Tune in practice by adjusting one knob at a time and watching `/om:status`
(pool size, observer progress) and the cost in the footer. If observations
keep arriving too late to be useful, lower `chunkTokens`. If compaction
feels like it throws away recent context, raise `tailTokens`. If the
observer runs are eating money, raise `chunkTokens` or lower the
consolidation frequency by raising both pool knobs.

For a small local observer model (8k context class), you also want a
`toolResultMaxChars` cap (e.g. 4000) so big tool results from the main
session don't overflow its context — the README's Configuration section
explains the knob with a small local model example.

## 6. Turn it on and verify

Start pi, run `/om on` in a session, then `/om:status`. The status should
show your models and profile with no errors. Every observer run is an
ordinary recorded pi session — open it in the session browser to see what
the observer saw and wrote.
