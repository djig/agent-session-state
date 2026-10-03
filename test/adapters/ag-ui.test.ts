import { describe, expect, it } from 'vitest';
import { createSessionStore, memoryStorage } from '../../src';
import { connectAgUi, createSseParser, parseAgUiEvent } from '../../src/adapters/ag-ui';

describe('parseAgUiEvent', () => {
  it('maps known AG-UI events', () => {
    expect(parseAgUiEvent({ type: 'RUN_STARTED', runId: 'r', threadId: 't', timestamp: 5 })).toEqual({
      type: 'RUN_STARTED',
      runId: 'r',
      threadId: 't',
      ts: 5,
      parentRunId: undefined,
    });
    expect(parseAgUiEvent({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hi' })).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT', delta: 'hi' });
    expect(parseAgUiEvent({ type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'f', parentMessageId: 'm' })).toMatchObject({ toolCallName: 'f', parentMessageId: 'm' });
    expect(parseAgUiEvent({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/a', value: 1 }] })).toMatchObject({ type: 'STATE_DELTA' });
    expect(
      parseAgUiEvent({
        type: 'MESSAGES_SNAPSHOT',
        messages: [{ id: 'a', role: 'assistant', content: 'x', toolCalls: [{ id: 'c', function: { name: 'f', arguments: '{"q":1}' } }] }],
      }),
    ).toMatchObject({ messages: [{ id: 'a', toolCalls: [{ id: 'c', name: 'f', args: { q: 1 } }] }] });
    expect(parseAgUiEvent({ type: 'APPROVAL_REQUESTED', approvalId: 'a', title: 'ok?', kind: 'tool' })).toMatchObject({ approvalId: 'a', kind: 'tool' });
    expect(parseAgUiEvent({ type: 'USAGE', model: 'm', inputTokens: 1, outputTokens: 2 })).toMatchObject({ model: 'm', inputTokens: 1 });
  });

  it('wraps unknown or malformed events as RAW and rejects non-objects', () => {
    expect(parseAgUiEvent({ type: 'SOMETHING_NEW', x: 1 })).toMatchObject({ type: 'RAW', source: 'ag-ui', event: { type: 'SOMETHING_NEW', x: 1 } });
    expect(parseAgUiEvent({ type: 'TEXT_MESSAGE_START' })).toMatchObject({ type: 'RAW' }); // missing messageId
    expect(parseAgUiEvent({ type: 'STATE_DELTA', delta: 'nope' })).toMatchObject({ type: 'RAW' });
    expect(parseAgUiEvent('string')).toBeNull();
    expect(parseAgUiEvent(null)).toBeNull();
  });
});

describe('createSseParser', () => {
  it('parses data, id, event, retry, comments, CRLF', () => {
    const p = createSseParser();
    const out = p.feed(': comment\r\nid: 1\r\nevent: tick\r\nretry: 3000\r\ndata: {"a":1}\r\n\r\n');
    expect(out).toEqual([{ id: '1', event: 'tick', retry: 3000, data: '{"a":1}' }]);
  });

  it('joins multi-line data with \\n and strips one leading space', () => {
    const p = createSseParser();
    expect(p.feed('data: line1\ndata:line2\ndata:  spaced\n\n')).toEqual([{ data: 'line1\nline2\n spaced' }]);
  });

  it('handles messages split across chunks and flushes a trailing message', () => {
    const p = createSseParser();
    expect(p.feed('id: a\nda')).toEqual([]);
    expect(p.feed('ta: {"x":')).toEqual([]);
    expect(p.feed('1}\n\nid: b\ndata: tail')).toEqual([{ id: 'a', data: '{"x":1}' }]);
    expect(p.flush()).toEqual([{ id: 'b', data: 'tail' }]);
  });

  it('keeps the last id across messages without an id, and ignores id with NUL', () => {
    const p = createSseParser();
    const out = p.feed('id: 7\ndata: a\n\ndata: b\n\nid: bad\u0000\ndata: c\n\n');
    expect(out.map((m) => m.id)).toEqual(['7', '7', '7']);
  });

  it('a blank line with no data dispatches nothing', () => {
    const p = createSseParser();
    expect(p.feed('\n\n\n')).toEqual([]);
    expect(p.feed('event: x\n\n')).toEqual([]);
  });
});

function sseResponse(frames: string[], opts: { status?: number } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const f of frames) {
        controller.enqueue(enc.encode(f));
        await new Promise((r) => setTimeout(r, 0));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
}

const frame = (id: string | undefined, ev: object) => `${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(ev)}\n\n`;

describe('connectAgUi', () => {
  it('consumes a stream into the store and records STREAM_CURSOR from ids', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return sseResponse([
        frame('1', { type: 'RUN_STARTED', runId: 'r1', threadId: 't1' }),
        frame('2', { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }) + frame('3', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hel' }),
        'id: 4\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m","del', // split mid-JSON across reads
        'ta":"lo"}\n\n',
        frame('5', { type: 'TEXT_MESSAGE_END', messageId: 'm' }),
        frame('6', { type: 'RUN_FINISHED', runId: 'r1' }),
      ]);
    };
    const conn = connectAgUi({ url: 'http://agent/run', store, fetch: fetchImpl, body: { threadId: 't1' } });
    await conn.done;
    const s = store.getState();
    expect(s.messages[0]).toMatchObject({ content: 'Hello', complete: true });
    expect(s.status).toBe('finished');
    expect(s.cursor.streamCursor).toBe('6');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['last-event-id']).toBeUndefined();
    const types = (await store.storage.loadEventsAfter('s', 0)).map((e) => e.type);
    expect(types.filter((t) => t === 'STREAM_CURSOR')).toHaveLength(6);
  });

  it('reconnects with Last-Event-ID when the stream ends before RUN_FINISHED', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const headersSeen: Array<Record<string, string>> = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      headersSeen.push(init!.headers as Record<string, string>);
      n++;
      if (n === 1) {
        return sseResponse([
          frame('ev-1', { type: 'RUN_STARTED', runId: 'r' }),
          frame('ev-2', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'part1 ' }),
          // connection drops here
        ]);
      }
      return sseResponse([frame('ev-3', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'part2' }), frame('ev-4', { type: 'RUN_FINISHED', runId: 'r' })]);
    };
    const conn = connectAgUi({ url: 'http://agent/run', store, fetch: fetchImpl, reconnect: { baseDelayMs: 1, maxRetries: 3 }, resumeOnVisible: false });
    await conn.done;
    expect(n).toBe(2);
    expect(headersSeen[0]!['last-event-id']).toBeUndefined();
    expect(headersSeen[1]!['last-event-id']).toBe('ev-2');
    expect(store.getState().messages[0]!.content).toBe('part1 part2');
    expect(store.getState().status).toBe('finished');
  });

  it('retries on HTTP/network errors with backoff and reports via onError, then gives up', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const errors: unknown[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n++;
      if (n === 1) throw new TypeError('network down');
      return new Response('nope', { status: 503 });
    };
    const conn = connectAgUi({ url: 'http://x', store, fetch: fetchImpl, reconnect: { baseDelayMs: 1, maxRetries: 2 }, resumeOnVisible: false, onError: (e) => errors.push(e) });
    await conn.done;
    expect(n).toBe(3);
    expect(errors).toHaveLength(3);
    expect(String(errors[1])).toMatch(/503/);
  });

  it('resumes from a stored cursor on the first request and can be aborted', async () => {
    const storage = memoryStorage();
    const prev = createSessionStore({ sessionId: 's', storage });
    prev.append([{ type: 'RUN_STARTED', runId: 'r' }, { type: 'STREAM_CURSOR', cursor: 'ev-9' }]);
    await prev.flush();

    const store = createSessionStore({ sessionId: 's', storage });
    await store.hydrate();
    let lastEventId: string | undefined;
    let aborted = false;
    const fetchImpl: typeof fetch = async (_u, init) => {
      lastEventId = (init!.headers as Record<string, string>)['last-event-id'];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init!.signal!.addEventListener('abort', () => {
            aborted = true;
            controller.error(new Error('aborted'));
          });
        },
      });
      return new Response(stream, { status: 200 });
    };
    const conn = connectAgUi({ url: 'http://x', store, fetch: fetchImpl, reconnect: false });
    await new Promise((r) => setTimeout(r, 5));
    expect(lastEventId).toBe('ev-9');
    conn.abort();
    await conn.done;
    expect(aborted).toBe(true);
  });

  it('onEvent can filter events', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const fetchImpl: typeof fetch = async () =>
      sseResponse([frame(undefined, { type: 'RUN_STARTED', runId: 'r' }), frame(undefined, { type: 'CUSTOM', name: 'noise', value: 1 }), frame(undefined, { type: 'RUN_FINISHED', runId: 'r' })]);
    await connectAgUi({ url: 'http://x', store, fetch: fetchImpl, onEvent: (e) => e.type !== 'CUSTOM' }).done;
    const types = (await store.storage.loadEventsAfter('s', 0)).map((e) => e.type);
    expect(types).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });
});
