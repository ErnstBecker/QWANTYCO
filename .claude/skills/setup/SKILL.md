---
name: setup
description: Generate a .env.setup draft from .env.example by asking the user for model provider, model, LangSmith settings and limits; the user turns it into .env. Use when the user runs /setup or asks to configure the environment.
disable-model-invocation: true
---

# /setup — draft the local environment

Goal: produce `.env.setup`, a draft built from `.env.example` with the user's choices. The user then moves it to `.env` and fills the secrets. Use `AskUserQuestion` for every choice (max 4 questions per call; the user can always type "Other").

## Hard rules

- **Never read, create, edit, move or delete `.env`** (nor `.env.local` or other real env files), with any tool, including Bash. The only files this skill writes are `.env.setup`.
- **Never ask the user to paste secrets in the chat** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LANGSMITH_API_KEY`). They stay empty in the draft.
- **Never overwrite an existing `.env.setup` silently.**
- Keep every comment and the variable order of `.env.example`; only change values.
- Do not stage or commit anything.

## Steps

### 1. Pre-checks
- Read `.env.example` (source of truth for variable names).
- If `.env.setup` already exists, ask: **Replace** / **Abort**.
- Confirm the draft is git-ignored: `git check-ignore -q .env.setup`. If it is not, stop and warn.
- Do not check whether `.env` exists; if the user mentions it, remind them that moving the draft will replace it.

### 2. Model (one `AskUserQuestion` call)
1. **Provider** — `ollama` (local, no key, data stays on the machine) / `openai` / `anthropic`.
2. **Model** — options depend on the provider; it must support tool calling:
   - ollama: `qwen2.5:7b-instruct` (recommended), `qwen3:8b`, `llama3.1:8b`
   - anthropic: `claude-haiku-5-5` (recommended, cheap/fast), `claude-sonnet-5-5`
   - openai: ask for the model name ("Other"); remind the user to pick one with tool calling.

   If the provider was not known yet, ask the provider first, then the model in a second call.

### 3. Provider specifics
- **ollama**
  - Ask for the base URL only if the user does not want `http://localhost:11434`.
  - Check: `ollama --version`; `curl -s -m 3 <base_url>/api/tags`.
    - Server down → tell the user to run `! ollama serve &`.
    - Model missing from `/api/tags` → tell the user to run `! ollama pull <model>`.
  - Hardware note: on CPU-only machines a 7–8B model takes 10–30s per answer.
- **openai / anthropic**: the key stays empty; note which variable the user must fill.

### 4. LangSmith (one `AskUserQuestion` call)
1. **Tracing** — `true` (recommended; required for traces and evaluation) / `false` (run offline without LangSmith).
2. **Region** — US (`https://api.smith.langchain.com`) / EU (`https://eu.api.smith.langchain.com`). The key only works in its own region.
3. **Project name** — default `aurora-support`.

`LANGSMITH_API_KEY` stays empty.

### 5. Limits
Ask once: **Keep defaults** (recommended) / **Customize**.
- Unless the user customized it, set `MODEL_TIMEOUT_MS` by provider: `60000` for ollama, `20000` for hosted APIs.
- On "Customize", ask for `TOOL_TIMEOUT_MS`, `TOOL_MAX_ATTEMPTS`, `ACTIVE_BUDGET_MS`, `GRAPH_RECURSION_LIMIT` (positive integers only).

### 6. Write `.env.setup`
- Copy `.env.example` to `.env.setup`, then replace values in place. Variables of providers not chosen stay empty.
- Run `chmod 600 .env.setup`.

### 7. Verify and hand off
- Reachability, using only the values chosen in this conversation: Ollama `/api/tags` if chosen; `curl -s -m 5 -o /dev/null -w '%{http_code}' <langsmith_endpoint>/info` should be `200` (the bare endpoint returning 404 is normal).
- Short summary table: provider, model, LangSmith tracing/region/project, limits.
- Tell the user to finish by themselves, outside the chat:
  1. `mv .env.setup .env` (replaces any existing `.env`)
  2. fill in `.env`, in their editor: the provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) if applicable, and `LANGSMITH_API_KEY` if tracing is on
  3. `! ollama pull <model>` if the model is missing
- Finish with the next command: `pnpm dev` (app) or `pnpm test` (offline tests, no model needed).
