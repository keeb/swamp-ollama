---
name: ollama
description: Run local LLM inference through Ollama from swamp workflows using the @keeb/ollama model type. Use when generating text, summarizing, classifying, extracting structured JSON, or processing many inputs through the same prompt against a local Ollama server. Triggers on "ollama", "local llm", "llm generate", "qwen", "llama", "ollama generate", "ollama batch", "unload model from vram", "free gpu memory", "@keeb/ollama", or wiring an LLM step into a swamp workflow.
---

# @keeb/ollama

Swamp extension that wraps an Ollama HTTP server. One model type, three
methods. No vault credentials required — Ollama is unauthenticated and reached
over HTTP at `ollamaUrl`.

## Model

**Type:** `@keeb/ollama`

### Global arguments

Set on the model definition under `globalArguments:`.

| Field       | Default                  | Description                |
| ----------- | ------------------------ | -------------------------- |
| `ollamaUrl` | `http://localhost:11434` | Base URL of Ollama server  |
| `model`     | `qwen3:14b`              | Ollama model tag to invoke |

The `model` global argument selects the Ollama model for every method on this
model instance — there is no per-method override. To run multiple Ollama
models, declare multiple swamp models with different `globalArguments.model`
values.

### Resource

Each method writes a `result` resource (`lifetime: infinite`,
`garbageCollection: 20`) containing:

- `input` — the input string sent
- `raw` — raw model output (fenced ``` blocks are stripped)
- `parsed` — populated if `raw` parsed as JSON, otherwise omitted
- `model` — the Ollama model tag used
- `duration` — wall-clock generation time in ms

### Methods

**`generate`** — single prompt+input call.

Arguments:

- `prompt` (string, required) — system prompt / instructions
- `input` (string, required) — content to process
- `instanceName` (string, optional) — resource instance name. Defaults to a
  slugified version of `input` (lowercased, non-alphanumerics → `-`, max 80
  chars).

**`generate_batch`** — fan-out factory. Sends multiple inputs through the same
prompt and writes one `result` resource per input. Failures on individual
inputs are logged and skipped (the method does not abort). Always prefer this
over looping `generate` calls — it acquires the per-model lock once.

Arguments:

- `prompt` (string, required) — shared system prompt
- `inputs` (string[], required) — list of inputs to process

Each output instance name is the slugified input. Beware collisions: two inputs
that slugify to the same string will overwrite each other.

**`unload`** — POSTs `keep_alive: 0` to free GPU VRAM. Writes a sentinel
`result` resource named `unload`. Use after expensive batch jobs or before
switching models.

## Quick model definition

```yaml
# models/llm.yaml
name: llm
type: "@keeb/ollama"
globalArguments:
  ollamaUrl: http://localhost:11434
  model: qwen3:14b
```

## Workflow patterns

### Single classification

```yaml
- name: classify-ticket
  model: llm
  method: generate
  arguments:
    prompt: |
      Classify the following support ticket as one of: bug, feature, question.
      Respond with JSON: {"category": "..."}
    input: "${data.latest('tickets', 'ticket-42').attributes.body}"
    instanceName: ticket-42
```

The CEL `data.latest(...)` reference pulls input from another model's resource
data. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>`
over the deprecated
`model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.

### Batch processing

```yaml
- name: summarize-issues
  model: llm
  method: generate_batch
  arguments:
    prompt: "Summarize each GitHub issue in one sentence."
    inputs:
      - "${data.latest('github-issues', 'issue-1').attributes.body}"
      - "${data.latest('github-issues', 'issue-2').attributes.body}"
      - "${data.latest('github-issues', 'issue-3').attributes.body}"
```

### Free VRAM after the job

```yaml
- name: free-vram
  model: llm
  method: unload
  dependsOn: [summarize-issues]
```

## JSON output

To get parsed JSON in the `parsed` field, instruct the model to respond with
JSON in the `prompt`. The extension auto-strips ```` ```json ```` and
```` ``` ```` fences before parsing, so models that wrap JSON in fenced blocks
still work. Non-JSON output leaves `parsed` undefined — downstream CEL must
handle the absence:

```cel
data.latest("llm", "ticket-42").attributes.parsed?.category ?? "unknown"
```

## Gotchas

- **No streaming.** Calls block until the full response is generated. Long
  prompts on large models can hang for minutes — workflow timeouts apply.
- **`num_predict` is hardcoded to 1024 tokens.** There is no argument to raise
  it. Outputs longer than ~1024 tokens are truncated.
- **`think: false`** is sent on every chat call, suppressing reasoning traces
  on models that support them (qwen3, deepseek-r1). The `raw` field never
  contains `<think>` blocks.
- **Slug collisions in `generate_batch`.** Two inputs that slugify identically
  silently overwrite the same `result` resource. If inputs may collide, run
  `generate` per input with explicit `instanceName`s instead.
- **No retries.** A single network blip fails the call. `generate_batch` logs
  and continues; `generate` aborts the workflow step.
- **Per-model lock contention.** All three methods are serialized by swamp's
  per-model lock. Don't fan multiple `generate` steps out against the same
  model — declare a second swamp model or use `generate_batch`.
- **No auth.** `ollamaUrl` is hit with plain HTTP and no headers. If the
  Ollama server is exposed publicly, secure it at the network layer — this
  extension cannot pass tokens or basic-auth credentials.
