# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Athena Echosphere** — SIH 2026 hackathon project, now targeting **PS 26140** ("AI-Based Interactive Quantum Algorithm Learning Platform", Egreen Quanta). PS 26207 was the original target and is **abandoned**; `README.md`, `docs/SYSTEM-DESIGN.md` and the rest of `docs/` still describe it, so read them for the classroom architecture, not for the goal.

The base is an audio-first live classroom where a teacher, students, and an AI co-teacher ("Athena") share one Agora voice channel, whiteboard, and sticky-note workspace. PS 26140 adds a quantum playground on top of it: `orchestrator/src/quantum/` (state-vector simulator, guided lessons, grading, and the two-way Athena bridge) and `web/components/quantum/QuantumPlayground.tsx`. See "The quantum playground" below. Built on Agora's `agent-quickstart-nextjs` as a base. `README.md` is the full feature list; `docs/SYSTEM-DESIGN.md` is the architecture reference (read it before non-trivial changes); `docs/HANDOFF.md` is the current engineering state but its branch/commit header is stale (cites `merge-himani-fixes`, which no longer exists on origin) — trust its §1 architecture notes, not its git table; `docs/BUILD-LOG.md` is the bug history. `apps/web/` has its own `AGENTS.md` with web-app-specific rules — it applies to everything under `apps/web/`.

## Commands

pnpm workspace, Node >= 22 (`.nvmrc` pins 24). Run from repo root.

```bash
pnpm install
pnpm dev                 # web only (localhost:3000)
pnpm dev:classroom       # web + orchestrator in parallel — the normal dev loop
pnpm build               # web only (next build); orchestrator has NO build step, it runs TS via tsx
pnpm lint                # recursive (orchestrator lint is a no-op echo)
pnpm typecheck           # recursive

# Orchestrator tests (~354 pure-logic checks, 17 suites, no browser needed):
pnpm --filter @echosphere/orchestrator test
pnpm --filter @echosphere/orchestrator verify  # typecheck + all tests
# individual suites — copy the flags from the `test` script in apps/orchestrator/package.json;
# some need --env-file=.env (board, floor, echo, quiz, repetition, catchup, illustrate, mailer, library):
node --import tsx apps/orchestrator/scripts/floorMachine.test.ts   # single test file

# Web e2e (Playwright):
pnpm --filter @echosphere/web test:e2e         # real browser, both servers, fake mic
pnpm --filter @echosphere/web test:roundtrip   # LIVE agent, spends Agora minutes — the one that matters
pnpm --filter @echosphere/web test:board       # Excalidraw whiteboard
pnpm --filter @echosphere/web test:speech      # TTS/STT path
pnpm run doctor          # env/credential check — MUST be run from apps/web, it reads process.cwd()
```

Note the web package is named `@echosphere/web`, not `web`; README's `pnpm --filter web dev` does not match.

Every serious bug in this project passed typecheck/lint/unit tests and only surfaced in `test:roundtrip` — run it for any change touching the transcript, floor, or agent paths.

## Environment

Only Agora creds are required: `NEXT_PUBLIC_AGORA_APP_ID` + `NEXT_AGORA_APP_CERTIFICATE` in `apps/web/.env.local` and `apps/orchestrator/.env` (`config.ts` enforces exactly these two; ConvoAI runs in App Credentials mode — README's `AGORA_CUSTOMER_ID/SECRET` are NOT used by the code). `agora project env write .env.local` generates them. Orchestrator runs on **:8787**; point the web app at it with `NEXT_PUBLIC_ORCHESTRATOR_URL` (defaults to `http://localhost:8787`). `SARVAM_API_KEY` (Indian-language STT/TTS), `RESEND_API_KEY` (absent-student email dispatch), `DATABASE_URL` (Postgres), and vendor LLM keys are all graceful no-ops when unset.

`LLM_VENDOR` picks the in-call agent's model path (`config.ts:12`): `agora` (default, an Agora-resold model via `LLM_MODEL`) or `groq` (requires `GROQ_AGENT_API_KEY` — it is the one key here that hard-fails config load when selected but unset). It affects Athena's voice only; the out-of-call LLM layer ignores it.

**Two separate model paths that do not share a key:** Athena's in-call voice is Agora ConvoAI (everything billed through the Agora project; `LLM_MODEL` must be an Agora-resold model unless `LLM_VENDOR=groq`). Everything outside the call (catch-up chatbot, reports, translation) goes through `apps/orchestrator/src/llm/complete.ts`, which picks a provider by **first key present in fixed order: Gemini → OpenAI → Groq → Anthropic → DeepSeek → Sarvam** (`llm/complete.ts:54-127`). No provider setting — if a feature answers in an unexpected style, check which key is set.

## Architecture: the two channels

Everything is one of two flows, and they must never be merged:

- **Audio path** — Agora RTC (speech) + RTM (Athena's transcript/state), owned by Agora's cloud.
- **Control path** — orchestrator's own SSE (`GET /api/sessions/:id/events`) down to browsers + HTTP POSTs up. Owned by the orchestrator process.

RTM **cannot** carry control events: Agora's RTM SDK is browser-only, no server variant. This also forces the **transcript relay**: the teacher's browser tab is the only always-present place Athena's transcript can be observed, so it POSTs transcripts/agent-state to the orchestrator (`isRelay` in `ClassroomAudio.tsx`). Exactly one relay — two relays duplicate every student turn under two names.

**The orchestrator (`apps/orchestrator`) is one long-lived process, not serverless**: the floor state machine needs a single authoritative writer, and the `agora-agents` `AgentSession` handle must stay in memory for `interrupt()/think()/update()/getHistory()`. State is in-memory; flushed to Postgres once at session end.

**Browsers never compute state.** `useClassroom` only applies SSE events; the teacher's mute and the students' view can't disagree because derivation lives solely in the orchestrator.

Beyond the voice core, the feature surfaces (README has the full list) map to: `orchestrator/src/{board,whiteboard,workspace,support,catchup}` + `web/components/{workspace,support,meraki}` — whiteboard (Excalidraw, agent-writable), sticky-note workspace, absent-student packet dispatch (Resend/WhatsApp), 1:1 catch-up booking, targeted reading, and the teacher-only copilot chat.

## Turn-taking: two non-redundant layers

The core safety property — no code path lets Athena speak while muted:

1. **System prompt** (`agent/prompt.ts`) — advisory, shapes *what* she says.
2. **Floor machine + speak permit** (`floor/floorMachine.ts`, `classroomController.ts`) — binding, decides *whether* she may speak at all. `decideSpeak()` is pure and the only permission-granter; `requestFloor()` is its single caller — one door. Because ConvoAI answers on its own initiative, enforcement is a permit (TTL 15s) + after-the-fact `interruptAgent()` in `handleAgentState`; once authorized, `authorizedTurnInProgress` covers the turn to completion — only explicit revocation (mute, barge-in, floor close) ends it early. Never rely on prompt wording to keep Athena quiet.

## The control channel & quiz payloads

Athena appends one JSON object per spoken turn; MiniMax `skipPatterns:[5]` strips braces before TTS so it's never spoken. **The same stripping removes it from the relayed RTM transcript** — quiz payloads must be read from `agentSession.getHistory()` (raw LLM output) via `pollForPayloadTurn`, not the relay. `{to}`/`{gap}` on ordinary turns stay relay-based (best-effort).

Gotchas that cost real debugging time (details in SYSTEM-DESIGN.md §14): agent RTC uid is the constant `123456`; `agentSession.update()` overwrites `params` wholesale — always repeat `model`; run `next build && next start` for demos (`next dev` Fast Refresh desyncs the RTM client); wake-word matching accepts mis-hearings ("Xena", "Tina").

## Demo/hosting constraint

The web app deploys to Vercel, but the orchestrator **cannot** — it needs a long-lived process. Deploy it separately (see `Dockerfile.orchestrator`); point the web app at it with `NEXT_PUBLIC_ORCHESTRATOR_URL`.

## The quantum playground (PS 26140)

`orchestrator/src/quantum/` is self-contained and pure — no I/O, no Agora, no config. `simulator.ts` is a hand-rolled state-vector simulator (1–4 qubits, 14 gates); `lessons.ts` holds the Bell / Deutsch–Jozsa / Grover walkthroughs; `quantumSession.ts` is the only part that touches session state or the event bus.

Three things that will bite:

- **Qubit 0 is the most significant bit**, so its stride is 2^(n-1), not 1. Every gate function takes the qubit count for this reason. Get it wrong and probabilities still sum to 1 while the gate lands on the wrong wire — which is why the tests assert on named basis states, never just on normalization.
- **Lesson narration is a constant, and the tests assert the prose against the amplitudes.** "The bars have not moved" is a checkable claim. Editing a gate without its sentence fails `lessons.test.ts`, by design.
- **Grading compares the resulting state, not the gate list** (`isBellState`, `matches`). There is more than one correct circuit for any challenge.

Both directions of the Athena bridge live outside that folder: `agent/control.ts` reads the `circuit` payload (validate-or-drop-entirely — a half-read circuit is worse than none), and `quantumSession.describeForAgent()` hands her English prose rather than a state vector, so she is never improvising over raw amplitudes.

Run `node --import tsx scripts/quantum.test.ts` (and `lessons`/`quantumSession`) from `apps/orchestrator`; none of the three need `--env-file`.

## Known-broken: `next build`

`pnpm build` fails with `Module not found: Can't resolve <dynamic>`. The cause is in a dependency: `@met4citizen/talkinghead`'s lipsync loader does `import(moduleName)` with a runtime-built string, which Turbopack cannot resolve. It is not your diff — typecheck and lint both pass. To prove a change compiles, stub the `import { TalkingHead }` line in `apps/web/lib/athena-avatar.ts`, build, and restore.

## Git conventions (from apps/web/AGENTS.md, applies repo-wide)

Conventional commits (`feat:`/`fix:`/`chore:`/`test:`/`docs:`, lowercase, present tense, PR number appended). Branches `type/short-description`. **No AI tool names in commit messages, no `Co-Authored-By` trailers, no `--no-verify`, no git config changes.**

Note: `apps/web/AGENTS.md` warns this is Next.js 16 with breaking changes vs. training data — read `node_modules/next/dist/docs/` (from `apps/web/`) before writing web-app code.
