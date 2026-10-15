# Setup on a new machine

This guide sets up the extension in dev mode: pi runs the TypeScript
directly from the repo, with no build step. Then you configure the worker
models.

Before you begin, install:

- pi
- Node.js
- Go 1.25 or later (for the CLI in §3)

Choose one stable path for the repo and use it everywhere in this guide.

## 1. Clone the repo

```bash
git clone <repo url> ~/repos/pi-observational-memory
cd ~/repos/pi-observational-memory
npm install
```

`npm install` provides the pi packages that the extension imports.

## 2. Point pi at the repo

Add the repo path to the `extensions` list in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/repos/pi-observational-memory"]
}
```

pi loads `src/index.ts` from that path. pi expands a leading `~/` to your
home directory.

The path must point to a real checkout. If it does not exist, pi skips the
extension and shows no error. To verify the setup, start a new `pi` run and
check that pi offers the `om_memory` tool.

## 3. Build the Go CLI

The extension reads and writes the memory database (a SQLite file at
`~/.pi/agent/om/om.db`, created on first use) through a small Go CLI. The
CLI source lives in `cli/`. The binary is build output and is not
committed: build your own, for your platform.

```bash
bash cli/build.sh          # builds cli/om
bash cli/build.sh --check  # checks the binary; exit code 1 if it is
                           # missing, stale, or not runnable here
```

The build needs no CGO. Run `build.sh` again after you change any file in
`cli/`. The script does nothing when the sources and the binary are
current, and it verifies that the binary runs before it reports success.

By default the extension uses `<repo>/cli/om`. To use a binary at another
path, set the `OM_CLI` environment variable to that path. `OM_CLI`
overrides the default.

## 4. Configure the worker models and auth

Add an `observational-memory` block to the same settings file:

```json
"observational-memory": {
  "models": {
    "observer":     { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "low" },
    "consolidator": { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "medium" }
  },
  "compactAtContextTokens": 100000
}
```

The two model entries are the only required keys; everything else uses
defaults. The example uses the `anthropic` provider. You can use any
provider that pi supports.

Workers authenticate the same way as pi itself: they inherit pi's
environment. Export the API key of your provider in the shell that starts
pi, before you start it:

```bash
export GEMINI_API_KEY=...   # example for the google provider
```

One export covers pi and both worker types.

## 5. The timing knobs

The pipeline has three clocks. The knobs set when each clock fires.

- **`chunkTokens`** — how often an observer runs. An observer fires each
  time the conversation gains this many new tokens. A smaller value gives
  finer-grained observations and more worker runs (more cost). A larger
  value does the opposite.
- **`compactAtContextTokens`** — compaction starts when the main session's
  context passes this value. Set it below the context window of your main
  model, with headroom to spare.
- **`tailTokens`** — at compaction, the most recent N tokens of the
  conversation stay verbatim in the compaction block. The observations
  cover everything older. A larger tail keeps more recent detail but
  compresses less.
- **`poolTargetTokens` / `consolidateAtPoolTokens`** — observations
  collect in a per-session buffer. When the buffer passes
  `consolidateAtPoolTokens`, the consolidator folds the oldest observations
  into the durable store until the buffer returns to `poolTargetTokens`.
  The buffer size therefore oscillates between the two values. Set the
  trigger to about 2 times the target. A lower target consolidates more
  often and keeps the in-context buffer smaller.
- **`journeyTargetTokens`** — the size of the running project history that
  goes into every compaction block. Past this size, the consolidator
  compresses the oldest parts. Keep the default unless you want more or
  less of that section.
- **`observerConcurrency`** — how many observer subprocesses may run at
  once.

## 6. Turn it on and verify

Start pi, run `/om on` in a session, then run `/om:status`. The status
must show your models and profile with no errors. Then cause enough
conversation for at least one observer run. Open a worker run in the
session browser to see what the observer received and wrote.
