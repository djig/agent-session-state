# @djig/agent-session-state

**Durable, runtime-agnostic agent session state for React: pending approvals that survive reload, resumable stream cursors, subagent trees, and token/cost accounting — one event log, any transport.**

Headless. No UI components. Works with Vercel AI SDK `useChat` message parts, AG-UI event streams, LangGraph-style interrupts, or a hand-rolled SSE feed. It sits *under* assistant-ui / AI Elements / CopilotKit components, not instead of them.

```
npm i @djig/agent-session-state
```

- Core: **~6.3 KB gzipped**, zero dependencies, ESM + CJS, strict TypeScript.
- React entry: ~1 KB on top (`useSyncExternalStore`, React ≥ 18).
- Storage: memory, localStorage, IndexedDB, or HTTP to your backend (reference handler included).

---

## Why

Every agent UI library owns one slice of session state; none of them owns the whole session and hydrates it on cold start. The approval the user was looking at before the tab reloaded is the first casualty:

- CopilotKit: "Interrupt state can't be resumed after page reload" — https://github.com/CopilotKit/CopilotKit/issues/2418 (closed stale, folded into https://github.com/CopilotKit/CopilotKit/issues/3553: "connect path doesn't hydrate… nothing pending comes back on cold start").
- assistant-ui: "pending tool approval is lost on reload" — https://github.com/assistant-ui/assistant-ui/issues/8560 (Sep 29 2026).
- LangGraph's frontend HITL docs ship no approval component; you render `stream.interrupt` yourself and own its persistence — https://docs.langchain.com/oss/python/langchain/frontend/human-in-the-loop
- AI SDK resumable streams require Redis + `resumable-stream` + two endpoints + a stop endpoint you write — https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams — and https://github.com/vercel/ai/issues/11865 reports resume failing when the tab is backgrounded.
- Ably's write-up on the same gap (https://ably.com/vercel/vercel-why-ai-chat-history-disappears-between-sessions): "when the component unmounts… the history is gone".

This library is the missing layer: an append-only event log with a pure reducer, persisted through a pluggable adapter, that replays into a complete `SessionState` on load. Approvals are **state in the log**, not component state. So are stream cursors, subagent trees, token usage, and the "I resolved this approval but the network was down" outbox.

## Mental model

```
   transport (AI SDK parts / AG-UI SSE / LangGraph interrupt / your SSE)
        │  adapter → SessionEvent[]
        ▼
   store.append(events)  ──►  storage.appendEvents()      (memory / localStorage / IDB / HTTP)
        │
        ▼
   reduce(state, event)  ──►  SessionState               (pure, deterministic)
        │
        ▼
   React: useSyncExternalStore selectors
```

- **One append-only log.** Every event gets a monotonically increasing `seq` and a `ts`.
- **One pure reducer.** `replay(log)` from empty always reproduces the same state. Snapshots are an optimisation, never the source of truth.
- **Storage replays it.** `hydrate()` = `loadSnapshot` + `loadEventsAfter(lastSeq)` + reduce. Compaction writes a snapshot and trims the tail.
- **Approvals are first-class.** `APPROVAL_REQUESTED` puts an item in `pendingApprovals`; `APPROVAL_RESOLVED` moves it to `resolvedApprovals` **and** the `outbox`; `APPROVAL_DELIVERED` clears the outbox once your backend has acknowledged it. All three survive reload.

## 5-minute quickstart: AI SDK `useChat` + localStorage

```tsx
'use client';
import { useChat } from '@ai-sdk/react';
import { useEffect, useMemo } from 'react';
import { createSessionStore } from '@djig/agent-session-state';
import { localStorageStorage } from '@djig/agent-session-state/storage/local-storage';
import { syncUIMessages, toToolApprovalResponse } from '@djig/agent-session-state/adapters/ai-sdk';
import { useAgentSession, usePendingApprovals } from '@djig/agent-session-state/react';

export function Chat({ chatId }: { chatId: string }) {
  const store = useMemo(
    () => createSessionStore({ sessionId: chatId, storage: localStorageStorage() }),
    [chatId],
  );
  const { hydrated, status, resolveApproval } = useAgentSession(store); // hydrate() runs in an effect
  const pending = usePendingApprovals(store);

  const chat = useChat({ id: chatId });

  // Mirror whatever useChat knows into the log. Idempotent: same messages → zero events.
  useEffect(() => {
    if (hydrated) syncUIMessages(store, chat.messages);
  }, [hydrated, chat.messages, store]);

  // Push resolutions back to the AI SDK. Anything undelivered sits in store.getState().outbox.
  useEffect(() => {
    for (const r of store.getState().outbox) {
      chat.addToolApprovalResponse(toToolApprovalResponse(r));
      store.markDelivered(r.approvalId);
    }
  }, [store.getState().outbox.length]);

  return (
    <>
      <p>status: {status}</p>
      {pending.map((a) => (
        <div key={a.approvalId}>
          <b>{a.title}</b> <pre>{JSON.stringify(a.payload, null, 2)}</pre>
          <button onClick={() => resolveApproval(a.approvalId, 'approve')}>Approve</button>
          <button onClick={() => resolveApproval(a.approvalId, 'reject', { reason: 'no' })}>Reject</button>
        </div>
      ))}
      {/* render chat.messages with your favourite components */}
    </>
  );
}
```

**Reload the page while an approval is pending.** `useChat` comes back empty; `usePendingApprovals` comes back with the approval, its tool call args, and the run it belonged to, because `hydrate()` replayed the log from localStorage. Approve it, and the resolution is handed to `addToolApprovalResponse` as soon as `useChat` is ready.

## AG-UI quickstart: `connectAgUi` + resume

```ts
import { createSessionStore } from '@djig/agent-session-state';
import { indexedDbStorage } from '@djig/agent-session-state/storage/indexeddb';
import { connectAgUi } from '@djig/agent-session-state/adapters/ag-ui';

const store = createSessionStore({ sessionId: threadId, storage: indexedDbStorage() });
await store.hydrate();

const conn = connectAgUi({
  url: '/api/agent',
  store,
  body: (cursor) => ({ threadId, runId: cursor.runId, messages: [] }), // AG-UI RunAgentInput
  reconnect: { maxRetries: 5, baseDelayMs: 500 },
  resumeOnVisible: true, // reconnect on visibilitychange→visible and `online`
});
// Every SSE `id:` becomes a STREAM_CURSOR event. On reconnect we send `Last-Event-ID`
// so a compliant server replays only what you missed. If the user closes the tab mid-run,
// the next connectAgUi() call starts from store.getResumeCursor().
await conn.done;
```

Server-side approvals in AG-UI: emit `{ type: 'APPROVAL_REQUESTED', approvalId, toolCallId, kind: 'tool', title, payload }` as a custom event in your stream (or a `CUSTOM` event you map in `onEvent`). Deliver resolutions with `onDeliver`:

```ts
createSessionStore({
  sessionId, storage,
  onDeliver: async (r) => {
    await fetch('/api/agent/approve', { method: 'POST', body: JSON.stringify(r) });
  }, // resolves → APPROVAL_DELIVERED appended; throws → stays in outbox; call store.deliverOutbox() later
});
```

## Next.js route handler for `httpStorage`

```ts
// app/api/agent-sessions/[...path]/route.ts
import { createHttpStorageHandler } from '@djig/agent-session-state/server';
import { memoryStorage } from '@djig/agent-session-state'; // swap for your own StorageAdapter (Postgres, Redis, KV…)

const handler = createHttpStorageHandler(memoryStorage(), {
  authorize: async (req, sessionId) => {
    const user = await getUser(req);
    if (!user || !(await userOwnsSession(user, sessionId))) return new Response('Unauthorized', { status: 401 });
  },
});
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
```

```ts
// client
import { httpStorage } from '@djig/agent-session-state/storage/http';
const storage = httpStorage({ baseUrl: '/api/agent-sessions', headers: () => ({ authorization: `Bearer ${token}` }) });
```

Wire contract (JSON):

| Method | Path | Body / Response |
| --- | --- | --- |
| GET | `/sessions/:id/snapshot` | → `Snapshot` or 204 |
| PUT | `/sessions/:id/snapshot` | ← `Snapshot` |
| GET | `/sessions/:id/events?after=N` | → `SessionEvent[]` (seq > N, ascending) |
| POST | `/sessions/:id/events` | ← `SessionEvent[]` (idempotent on `seq`) |
| DELETE | `/sessions/:id/events?upTo=N` | trims seq ≤ N (optional) |
| DELETE | `/sessions/:id` | wipes the session (optional) |
| GET | `/sessions` | → `string[]` (optional) |

## SSR

Storage adapters that touch `window`/`indexedDB` are no-ops on the server (`typeof window === 'undefined'`) and read as empty. The store starts empty on both server and client, and `hydrate()` runs in an effect, so there is no hydration mismatch. Appends made before `hydrate()` finishes are applied optimistically and rebased onto the persisted log once it loads.

---

## API reference

### `@djig/agent-session-state` (core, zero deps)

**`createSessionStore(options): SessionStore`**

| option | |
| --- | --- |
| `sessionId: string` | |
| `storage: StorageAdapter` | `memoryStorage()` or one of the adapters below |
| `pricing?: Record<model, { inputPerMTok, outputPerMTok, cachedInputPerMTok? }>` | USD per 1M tokens. `USAGE` events without `costUsd` get it computed |
| `clock?: () => number` | default `Date.now` |
| `snapshotEvery?: number` | compact every N events |
| `maxEvents?: number` | compact when the tail exceeds N |
| `onDeliver?: (resolution, state) => Promise<void>` | push resolutions to your backend; success marks delivered |
| `onError?: (err, ctx) => void` | persistence/delivery errors (default `console.warn`) |

Store methods: `getState()`, `subscribe(listener)`, `append(event | event[])`, `hydrate()`, `hydrated`, `resolveApproval(id, decision, payload?)`, `markDelivered(id)`, `deliverOutbox()`, `getResumeCursor()`, `compact()`, `flush()`, `clear()`, `degraded`.

**Quota handling.** When `appendEvents` throws a quota error, the store compacts (snapshot + trim) and retries once. If that fails too, it sets `degraded = true`, keeps state in memory, and recovers on the next successful write.

**`reduce(state, event)`, `replay(sessionId, events)`, `createEmptyState(sessionId)`** — the pure core.

**`applyPatch(doc, ops)`** — RFC 6902 (add/remove/replace/move/copy/test), immutable, throws `JsonPatchError`.

**`subagentTree(subagents)`, `children(subagents, parentId)`** — tree helpers.

**`createEmitter(store)`** — helpers for hand-rolled transports: `startRun`, `finishRun`, `errorRun`, `step`, `startMessage`, `text`, `endMessage`, `toolCall`, `toolResult`, `requestApproval`, `usage`, `subagentStarted/Finished/Error`, `stateSnapshot`, `checkpoint`, `cursor`, `custom`.

**`StorageAdapter`**

```ts
interface StorageAdapter {
  loadSnapshot(sessionId): Promise<Snapshot | null> | Snapshot | null;
  saveSnapshot(sessionId, { state, lastSeq }): Promise<void> | void;
  appendEvents(sessionId, events): Promise<void> | void;      // idempotent on seq
  loadEventsAfter(sessionId, seq): Promise<SessionEvent[]> | SessionEvent[];
  trimEvents?(sessionId, upToSeq): Promise<void> | void;
  clear(sessionId): Promise<void> | void;
  listSessions?(): Promise<string[]> | string[];
}
```

Example pricing table (illustrative numbers — this package ships **no** real prices because they go stale):

```ts
const pricing = {
  'example-large': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  'example-small': { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};
```

### `SessionState`

```ts
{
  sessionId, status: 'idle' | 'running' | 'awaiting_approval' | 'error' | 'finished',
  runs: Record<runId, { status, startedAt, finishedAt?, error?, result?, steps[] }>,
  messages: Array<{ id, role, content, parts[], reasoning?, complete, runId? }>,
  toolCalls: Record<id, { name, argsText, args?, result?, status, parentMessageId?, parentSubagentId? }>,
  pendingApprovals: Approval[],                 // ordered, oldest first
  resolvedApprovals: Record<id, Resolution>,
  outbox: Resolution[],                          // resolved but not yet APPROVAL_DELIVERED
  subagents: Record<id, { name, parentId?, status, startedAt, finishedAt?, error? }>,
  sharedState: unknown, activity: unknown,       // STATE_* / ACTIVITY_* snapshots + deltas
  usage: { totals, byModel },                    // tokens + costUsd + calls
  cursor: { lastSeq, streamCursor?, runId? },
  lastEventAt?, lastError?, checkpoints[]
}
```

### `@djig/agent-session-state/react`

`useAgentSession(store)` → `{ state, status, hydrated, resolveApproval, append, store }`; `usePendingApprovals`, `useSubagentTree` (nested roots), `useUsage`, `useToolCalls(store, filter?)`, `useMessages`, `useResumeCursor`, `useSessionStatus`, `useOutbox`, and the generic `useSessionSelector(store, selector, isEqual?)`. Every hook calls `hydrate()` once per store in an effect.

### `@djig/agent-session-state/adapters/ai-sdk`

`fromUIMessages(messages, state, options?)` → `EventInput[]` diff; `syncUIMessages(store, messages, options?)` → diff + append; `toToolApprovalResponse(resolution)` → `{ id, approved, reason }` for `addToolApprovalResponse`. UIMessage types are defined structurally (no dependency on `ai`). Tool parts in `approval-requested` → `APPROVAL_REQUESTED`; `approval-responded` → `APPROVAL_RESOLVED`.

### `@djig/agent-session-state/adapters/ag-ui`

`parseAgUiEvent(obj)`, `createSseParser()`, `connectAgUi({ url, store, fetch?, headers?, body?, cursor?, reconnect?, resumeOnVisible?, onEvent?, onError?, signal? })` → `{ abort(), done }`.

### `@djig/agent-session-state/adapters/langgraph`

`fromInterrupt(interrupt, { runId?, threadId? })` → `APPROVAL_REQUESTED` (understands `HumanInterrupt` `action_request`/`config`, plain `question`/`options`, or a string); `toResumeCommand(resolution)` → `{ resume }` for `submit(undefined, { command })`.

### Storage entries

`storage/local-storage` → `localStorageStorage({ prefix?, maxBytes?, chunkSize?, storage? })`; `storage/indexeddb` → `indexedDbStorage({ dbName?, indexedDB? })`; `storage/http` → `httpStorage({ baseUrl, fetch?, headers? })`; `server` → `createHttpStorageHandler(storage, { basePath?, authorize? })`.

## Event table

| Event | Key fields | Effect |
| --- | --- | --- |
| `RUN_STARTED` | `runId, threadId?, parentRunId?` | run → running; `cursor.runId` |
| `RUN_FINISHED` / `RUN_ERROR` | `runId, result?` / `message, code?` | run → finished / error |
| `STEP_STARTED` / `STEP_FINISHED` | `stepName` | `runs[id].steps` |
| `TEXT_MESSAGE_START/CONTENT/END` | `messageId, role` / `delta` | message text accumulates; `complete` |
| `REASONING_START/CONTENT/END` | `messageId` / `delta` | `message.reasoning` |
| `TOOL_CALL_START/ARGS/END/RESULT` | `toolCallId, toolCallName, parentMessageId?, parentSubagentId?` / `delta` / `content, isError?` | args assembled, JSON-parsed on END; status streaming → ready → done/error |
| `STATE_SNAPSHOT` / `STATE_DELTA` | `snapshot` / `delta: JsonPatchOp[]` | `sharedState` |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | same | `activity` |
| `MESSAGES_SNAPSHOT` | `messages[]` | replaces `messages`, registers tool calls |
| `SUBAGENT_STARTED/FINISHED/ERROR` | `subagentId, name, parentId?` | `subagents` tree |
| `APPROVAL_REQUESTED` | `approvalId, toolCallId?, kind, title, payload?, options?, expiresAt?` | → `pendingApprovals`; status `awaiting_approval` |
| `APPROVAL_RESOLVED` | `approvalId, decision, payload?, resolvedBy` | → `resolvedApprovals` + `outbox` |
| `APPROVAL_DELIVERED` | `approvalId` | removes from `outbox` |
| `USAGE` | `model, inputTokens, outputTokens, cachedInputTokens?, costUsd?` | `usage.totals`, `usage.byModel` |
| `CHECKPOINT` | `label, state?` | `checkpoints[]`, optionally replaces `sharedState` |
| `STREAM_CURSOR` | `cursor` | `cursor.streamCursor` |
| `CUSTOM` / `RAW` | `name, value` / `event, source?` | logged, no state change |

## Works with

| Library | How it plugs in | Status |
| --- | --- | --- |
| **Vercel AI SDK `useChat`** | `syncUIMessages(store, messages)` in an effect; `toToolApprovalResponse` → `addToolApprovalResponse` | Adapter unit-tested against the documented `UIMessage` part shapes (v5/v6). Not tested against a live `ai` install. |
| **assistant-ui** | Keep assistant-ui as the rendering layer; feed its message list (or its `useChat` runtime's messages) through `fromUIMessages`; render `usePendingApprovals` with your own approval UI or theirs | Untested integration; shapes should match since assistant-ui's AI SDK runtime passes `UIMessage` through. |
| **AI Elements** | Pure components; render `useMessages`/`useToolCalls` into `<Message>`, `<Tool>`, etc. | Untested; no adapter needed. |
| **CopilotKit** | Point `connectAgUi` at your CopilotKit runtime's AG-UI endpoint, or map `useCoAgent` state changes through `createEmitter`. Approvals via `renderAndWaitForResponse` can be mirrored with `requestApproval`/`resolveApproval` | Untested; AG-UI event parsing is tested against the protocol's documented event names. |
| **LangGraph `useStream`** | `store.append(fromInterrupt(stream.interrupt, { threadId }))` when an interrupt appears; `stream.submit(undefined, { command: toResumeCommand(res) })` on resolve | Adapter unit-tested; not run against a LangGraph server. |
| **Hand-rolled SSE / WebSockets** | `createEmitter(store)` | Tested. |

## Limitations

- **No server-side stream buffering.** This library remembers *where* you were (`STREAM_CURSOR`) and *what* you had; the server has to be able to replay from `Last-Event-ID` for a resume to pick up missed tokens. Pair it with your backend's resumable stream (AI SDK `resumable-stream`, AG-UI server replay, etc.).
- **Multi-tab: last-write-wins.** Two tabs on the same `sessionId` will both append with their own `seq` and the storage dedupes by `seq`, which means the *first* writer of a given `seq` wins. BroadcastChannel sync is on the roadmap.
- **Pricing is BYO.** No model prices are shipped.
- **`fromUIMessages` works on text, reasoning and tool parts.** `file`, `source-*` and `data-*` parts are ignored for now (they don't change session status).
- **Snapshots embed the full state.** Very long sessions with huge `sharedState` will produce large snapshots; compact less often or trim `messages` in your own adapter.

## Roadmap

- `BroadcastChannel` multi-tab sync with vector-clock merge.
- OTLP export of the event log (spans per run / tool call / subagent).
- AgentPrism trace adapter.
- Yjs storage adapter (CRDT log for collaborative sessions).
- `expiresAt` → automatic `APPROVAL_RESOLVED { decision: 'timeout' }`.

## Development

```
npm install
npm run typecheck
npm run build
npm test            # vitest (99 tests)
npm run size        # per-entry gzipped sizes; fails if core > 8 KB
```

## License

MIT © 2026 Jignesh — https://djig.github.io
