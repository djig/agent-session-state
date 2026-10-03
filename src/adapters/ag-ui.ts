import type { EventInput, JsonPatchOp, MessageSnapshot, Role, SessionEvent } from '../core/events';
import { isSessionEventType } from '../core/events';
import type { SessionStore } from '../core/store';
import type { Cursor } from '../core/state';

/**
 * Parse one AG-UI protocol event (as decoded from the wire) into a
 * `SessionEvent` input. Unknown or malformed events become `RAW` so nothing is
 * silently dropped from the log. Returns `null` only when `obj` is not an object.
 */
export function parseAgUiEvent(obj: unknown): EventInput | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const type = o.type;
  const common = {
    runId: str(o.runId),
    threadId: str(o.threadId),
    ts: num(o.timestamp),
  };
  const raw = (): EventInput => ({ type: 'RAW', event: obj, source: 'ag-ui', ...common });
  if (!isSessionEventType(type)) return raw();

  switch (type) {
    case 'RUN_STARTED':
      if (!str(o.runId)) return raw();
      return { type, ...common, runId: str(o.runId)!, parentRunId: str(o.parentRunId) };
    case 'RUN_FINISHED':
      if (!str(o.runId)) return raw();
      return { type, ...common, runId: str(o.runId)!, result: o.result };
    case 'RUN_ERROR':
      return { type, ...common, message: str(o.message) ?? 'run error', code: str(o.code) };
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      return { type, ...common, stepName: str(o.stepName) ?? '' };
    case 'TEXT_MESSAGE_START':
      if (!str(o.messageId)) return raw();
      return { type, ...common, messageId: str(o.messageId)!, role: (str(o.role) as Role) ?? 'assistant' };
    case 'TEXT_MESSAGE_CONTENT':
      if (!str(o.messageId)) return raw();
      return { type, ...common, messageId: str(o.messageId)!, delta: str(o.delta) ?? '' };
    case 'TEXT_MESSAGE_END':
    case 'REASONING_START':
    case 'REASONING_END':
      if (!str(o.messageId)) return raw();
      return { type, ...common, messageId: str(o.messageId)! };
    case 'REASONING_CONTENT':
      if (!str(o.messageId)) return raw();
      return { type, ...common, messageId: str(o.messageId)!, delta: str(o.delta) ?? '' };
    case 'TOOL_CALL_START':
      if (!str(o.toolCallId)) return raw();
      return {
        type,
        ...common,
        toolCallId: str(o.toolCallId)!,
        toolCallName: str(o.toolCallName) ?? '',
        parentMessageId: str(o.parentMessageId),
        parentSubagentId: str(o.parentSubagentId),
      };
    case 'TOOL_CALL_ARGS':
      if (!str(o.toolCallId)) return raw();
      return { type, ...common, toolCallId: str(o.toolCallId)!, delta: str(o.delta) ?? '' };
    case 'TOOL_CALL_END':
      if (!str(o.toolCallId)) return raw();
      return { type, ...common, toolCallId: str(o.toolCallId)! };
    case 'TOOL_CALL_RESULT':
      if (!str(o.toolCallId)) return raw();
      return {
        type,
        ...common,
        toolCallId: str(o.toolCallId)!,
        messageId: str(o.messageId),
        content: o.content,
        role: 'tool',
        isError: typeof o.isError === 'boolean' ? o.isError : undefined,
      };
    case 'STATE_SNAPSHOT':
    case 'ACTIVITY_SNAPSHOT':
      return { type, ...common, snapshot: o.snapshot };
    case 'STATE_DELTA':
    case 'ACTIVITY_DELTA':
      if (!Array.isArray(o.delta)) return raw();
      return { type, ...common, delta: o.delta as JsonPatchOp[] };
    case 'MESSAGES_SNAPSHOT':
      if (!Array.isArray(o.messages)) return raw();
      return { type, ...common, messages: (o.messages as unknown[]).map(toMessageSnapshot).filter(Boolean) as MessageSnapshot[] };
    case 'SUBAGENT_STARTED':
      if (!str(o.subagentId)) return raw();
      return { type, ...common, subagentId: str(o.subagentId)!, name: str(o.name) ?? str(o.subagentId)!, parentId: str(o.parentId), input: o.input };
    case 'SUBAGENT_FINISHED':
      if (!str(o.subagentId)) return raw();
      return { type, ...common, subagentId: str(o.subagentId)!, output: o.output };
    case 'SUBAGENT_ERROR':
      if (!str(o.subagentId)) return raw();
      return { type, ...common, subagentId: str(o.subagentId)!, message: str(o.message) ?? 'subagent error' };
    case 'CUSTOM':
      return { type, ...common, name: str(o.name) ?? 'custom', value: o.value };
    case 'RAW':
      return { type, ...common, event: o.event ?? obj, source: str(o.source) };
    case 'APPROVAL_REQUESTED':
      if (!str(o.approvalId) || !str(o.title)) return raw();
      return {
        type,
        ...common,
        approvalId: str(o.approvalId)!,
        toolCallId: str(o.toolCallId),
        kind: (str(o.kind) as 'tool' | 'plan' | 'question' | 'custom') ?? 'custom',
        title: str(o.title)!,
        payload: o.payload,
        options: Array.isArray(o.options) ? (o.options as string[]) : undefined,
        expiresAt: num(o.expiresAt),
      };
    case 'APPROVAL_RESOLVED':
      if (!str(o.approvalId) || !str(o.decision)) return raw();
      return {
        type,
        ...common,
        approvalId: str(o.approvalId)!,
        decision: str(o.decision) as 'approve' | 'reject' | 'edit' | 'answer' | 'timeout',
        payload: o.payload,
        resolvedBy: (str(o.resolvedBy) as 'user' | 'system') ?? 'system',
      };
    case 'APPROVAL_DELIVERED':
      if (!str(o.approvalId)) return raw();
      return { type, ...common, approvalId: str(o.approvalId)! };
    case 'USAGE':
      if (!str(o.model)) return raw();
      return {
        type,
        ...common,
        model: str(o.model)!,
        inputTokens: num(o.inputTokens) ?? 0,
        outputTokens: num(o.outputTokens) ?? 0,
        cachedInputTokens: num(o.cachedInputTokens),
        costUsd: num(o.costUsd),
      };
    case 'CHECKPOINT':
      return { type, ...common, label: str(o.label) ?? 'checkpoint', state: o.state };
    case 'STREAM_CURSOR':
      if (!str(o.cursor)) return raw();
      return { type, ...common, cursor: str(o.cursor)! };
    default:
      return raw();
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function toMessageSnapshot(m: unknown): MessageSnapshot | null {
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    role: (str(o.role) as Role) ?? 'assistant',
    content: str(o.content),
    toolCalls: Array.isArray(o.toolCalls)
      ? (o.toolCalls as Array<Record<string, unknown>>).map((c) => {
          const fn = (c.function ?? {}) as Record<string, unknown>;
          let args: unknown = undefined;
          const argStr = str(fn.arguments);
          if (argStr !== undefined) {
            try {
              args = JSON.parse(argStr);
            } catch {
              args = argStr;
            }
          }
          return { id: str(c.id) ?? '', name: str(fn.name) ?? str(c.name) ?? '', args };
        })
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/**
 * Incremental `text/event-stream` parser. Feed it chunks; it yields complete
 * messages. Handles multi-line `data:`, `id:`, `event:`, `retry:`, comments
 * (`:`), CRLF, and messages split across chunks.
 */
export function createSseParser(): { feed(chunk: string): SseMessage[]; flush(): SseMessage[] } {
  let buffer = '';
  let data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;

  function dispatch(out: SseMessage[]) {
    if (data.length === 0) {
      id = undefined;
      event = undefined;
      return;
    }
    const msg: SseMessage = { data: data.join('\n') };
    if (id !== undefined) msg.id = id;
    if (event !== undefined) msg.event = event;
    if (retry !== undefined) msg.retry = retry;
    out.push(msg);
    data = [];
    event = undefined;
  }

  function line(l: string, out: SseMessage[]) {
    if (l === '') return dispatch(out);
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) id = value;
        break;
      case 'event':
        event = value;
        break;
      case 'retry': {
        const n = Number(value);
        if (Number.isInteger(n)) retry = n;
        break;
      }
      default:
        break;
    }
  }

  return {
    feed(chunk) {
      buffer += chunk;
      const out: SseMessage[] = [];
      let idx: number;
      while ((idx = buffer.search(/\r\n|\n|\r/)) >= 0) {
        const l = buffer.slice(0, idx);
        const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1;
        buffer = buffer.slice(idx + sepLen);
        line(l, out);
      }
      return out;
    },
    flush() {
      const out: SseMessage[] = [];
      if (buffer) {
        line(buffer, out);
        buffer = '';
      }
      dispatch(out);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// connectAgUi
// ---------------------------------------------------------------------------

export interface ConnectAgUiOptions {
  url: string;
  store: SessionStore;
  fetch?: typeof fetch;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON body for POST (AG-UI `RunAgentInput`). Function form is re-evaluated per (re)connect. */
  body?: unknown | ((cursor: Cursor) => unknown);
  /** Starting cursor. Defaults to `store.getResumeCursor()`. */
  cursor?: Partial<Cursor>;
  reconnect?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } | false;
  /** Reconnect when the tab becomes visible / the browser comes back online. Default true. */
  resumeOnVisible?: boolean;
  /** Called for every parsed event before it is appended. Return false to skip. */
  onEvent?: (event: EventInput, sse: SseMessage) => boolean | void;
  onError?: (error: unknown, attempt: number) => void;
  /** External abort signal (e.g. from a React effect cleanup). */
  signal?: AbortSignal;
}

export interface AgUiConnection {
  abort(): void;
  /** Resolves when the stream finished (RUN_FINISHED / RUN_ERROR / retries exhausted / aborted). */
  done: Promise<void>;
}

/**
 * Consume an AG-UI SSE stream into a store with resume + auto-reconnect.
 *
 * - Sends `Last-Event-ID` from `cursor.streamCursor` (updated from SSE `id:` lines)
 *   so a compliant server can replay from where you left off.
 * - Appends every event to the store; `STREAM_CURSOR` events are appended when
 *   the SSE id changes.
 * - Reconnects with exponential backoff on network errors, and on
 *   `visibilitychange` → visible / `online` while the run is still open.
 */
export function connectAgUi(options: ConnectAgUiOptions): AgUiConnection {
  const { store } = options;
  const f = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const reconnect = options.reconnect === false ? null : { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 15_000, ...options.reconnect };
  const resumeOnVisible = options.resumeOnVisible ?? true;

  let cursor: Cursor = { ...store.getResumeCursor(), ...options.cursor };
  let aborted = false;
  let finished = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;

  const onExternalAbort = () => abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  function abort() {
    if (aborted) return;
    aborted = true;
    controller?.abort();
    wake?.();
  }

  function setCursor(id: string) {
    if (cursor.streamCursor === id) return;
    cursor = { ...cursor, streamCursor: id };
    store.append({ type: 'STREAM_CURSOR', cursor: id, runId: cursor.runId });
  }

  async function streamOnce(): Promise<'finished' | 'ended' | 'error'> {
    controller = new AbortController();
    const headers: Record<string, string> = { accept: 'text/event-stream', ...options.headers };
    if (cursor.streamCursor) headers['last-event-id'] = cursor.streamCursor;
    const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
    let body: string | undefined;
    if (method === 'POST') {
      const b = typeof options.body === 'function' ? (options.body as (c: Cursor) => unknown)(cursor) : options.body;
      body = JSON.stringify(b ?? {});
      headers['content-type'] = 'application/json';
    }
    const res = await f(options.url, { method, headers, body, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`connectAgUi: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    const handle = (msgs: SseMessage[]) => {
      for (const m of msgs) {
        if (m.id !== undefined) setCursor(m.id);
        if (!m.data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(m.data);
        } catch {
          parsed = { type: 'RAW', event: m.data };
        }
        const ev = parseAgUiEvent(parsed);
        if (!ev) continue;
        if (options.onEvent && options.onEvent(ev, m) === false) continue;
        store.append(ev);
        if (ev.type === 'RUN_STARTED') cursor = { ...cursor, runId: ev.runId };
        if (ev.type === 'RUN_FINISHED' || ev.type === 'RUN_ERROR') finished = true;
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      handle(parser.feed(decoder.decode(value, { stream: true })));
      if (finished) break;
    }
    handle(parser.flush());
    cursor = { ...cursor, lastSeq: store.getState().cursor.lastSeq };
    return finished ? 'finished' : 'ended';
  }

  function waitForWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onVis = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(t);
        wake = null;
        if (resumeOnVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
        if (resumeOnVisible && typeof window !== 'undefined') window.removeEventListener('online', onVis);
      };
      wake = () => {
        cleanup();
        resolve();
      };
      if (resumeOnVisible && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
      if (resumeOnVisible && typeof window !== 'undefined') window.addEventListener('online', onVis);
    });
  }

  const done = (async () => {
    try {
      while (!aborted && !finished) {
        try {
          const outcome = await streamOnce();
          if (outcome === 'finished' || aborted) break;
          // Stream ended without RUN_FINISHED: server closed early. Try to resume.
        } catch (err) {
          if (aborted) break;
          options.onError?.(err, attempt);
        }
        if (!reconnect || attempt >= reconnect.maxRetries) break;
        const delay = Math.min(reconnect.maxDelayMs, reconnect.baseDelayMs * 2 ** attempt);
        attempt += 1;
        await waitForWake(delay);
      }
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  })();

  return { abort, done };
}
