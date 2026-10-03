import { describe, expect, it } from 'vitest';
import { createSessionStore, memoryStorage } from '../../src';
import { fromUIMessages, syncUIMessages, toToolApprovalResponse, type UIMessage } from '../../src/adapters/ai-sdk';

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('fromUIMessages', () => {
  it('converts text messages and is idempotent', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const msgs: UIMessage[] = [
      user('u1', 'hi'),
      { id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Hello there', state: 'done' }] },
    ];
    const first = syncUIMessages(store, msgs);
    expect(first.map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
    ]);
    expect(store.getState().messages.map((m) => [m.id, m.role, m.content, m.complete])).toEqual([
      ['u1', 'user', 'hi', true],
      ['a1', 'assistant', 'Hello there', true],
    ]);
    expect(syncUIMessages(store, msgs)).toEqual([]);
    expect(fromUIMessages(msgs, store.getState())).toEqual([]);
  });

  it('streams deltas as text grows, ends once', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const at = (text: string, state: 'streaming' | 'done'): UIMessage[] => [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text, state }] }];
    expect(syncUIMessages(store, at('He', 'streaming')).map((e) => e.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT']);
    expect(syncUIMessages(store, at('Hello', 'streaming')).map((e) => e.type)).toEqual(['TEXT_MESSAGE_CONTENT']);
    expect(syncUIMessages(store, at('Hello', 'done')).map((e) => e.type)).toEqual(['TEXT_MESSAGE_END']);
    expect(syncUIMessages(store, at('Hello', 'done'))).toEqual([]);
    expect(store.getState().messages[0]!.content).toBe('Hello');
  });

  it('handles reasoning parts', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    syncUIMessages(store, [{ id: 'a', role: 'assistant', parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'ok' }] }]);
    expect(store.getState().messages[0]).toMatchObject({ reasoning: 'hmm', content: 'ok' });
  });

  it('falls back to MESSAGES_SNAPSHOT when a message is rewritten', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    syncUIMessages(store, [user('u1', 'hi'), { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first draft' }] }]);
    const evs = syncUIMessages(store, [user('u1', 'hi'), { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'regenerated' }] }]);
    expect(evs.map((e) => e.type)).toEqual(['MESSAGES_SNAPSHOT']);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['hi', 'regenerated']);
    expect(syncUIMessages(store, [user('u1', 'hi'), { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'regenerated' }] }])).toEqual([]);
  });

  it('maps tool parts through their lifecycle', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const tool = (state: string, extra: object = {}): UIMessage[] => [
      { id: 'a', role: 'assistant', parts: [{ type: 'tool-getWeather', toolCallId: 'c1', state: state as never, ...extra }] },
    ];
    expect(syncUIMessages(store, tool('input-streaming', { input: { ci: 'S' } })).map((e) => e.type)).toEqual(['TOOL_CALL_START']);
    expect(store.getState().toolCalls.c1).toMatchObject({ name: 'getWeather', status: 'streaming', parentMessageId: 'a' });
    expect(syncUIMessages(store, tool('input-available', { input: { city: 'SF' } })).map((e) => e.type)).toEqual(['TOOL_CALL_ARGS', 'TOOL_CALL_END']);
    expect(store.getState().toolCalls.c1).toMatchObject({ status: 'ready', args: { city: 'SF' } });
    expect(syncUIMessages(store, tool('input-available', { input: { city: 'SF' } }))).toEqual([]);
    expect(syncUIMessages(store, tool('output-available', { input: { city: 'SF' }, output: { temp: 20 } })).map((e) => e.type)).toEqual(['TOOL_CALL_RESULT']);
    expect(store.getState().toolCalls.c1).toMatchObject({ status: 'done', result: { temp: 20 } });
    expect(syncUIMessages(store, tool('output-available', { input: { city: 'SF' }, output: { temp: 20 } }))).toEqual([]);
  });

  it('maps output-error and dynamic-tool', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    syncUIMessages(store, [
      { id: 'a', role: 'assistant', parts: [{ type: 'dynamic-tool', toolName: 'mcp_thing', toolCallId: 'c', state: 'output-error', input: {}, errorText: 'kaboom' }] },
    ]);
    expect(store.getState().toolCalls.c).toMatchObject({ name: 'mcp_thing', status: 'error', result: 'kaboom', isError: true });
  });

  it('maps approval-requested / approval-responded to approvals', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const req: UIMessage[] = [
      { id: 'a', role: 'assistant', parts: [{ type: 'tool-sendEmail', toolCallId: 'c1', state: 'approval-requested', input: { to: 'x' }, approval: { id: 'apr-1' } }] },
    ];
    const evs = syncUIMessages(store, req);
    expect(evs.map((e) => e.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'APPROVAL_REQUESTED']);
    expect(store.getState().pendingApprovals[0]).toMatchObject({ approvalId: 'apr-1', toolCallId: 'c1', kind: 'tool', title: 'Approve sendEmail?', payload: { to: 'x' } });
    expect(store.getState().status).toBe('awaiting_approval');
    expect(syncUIMessages(store, req)).toEqual([]);

    const resp: UIMessage[] = [
      { id: 'a', role: 'assistant', parts: [{ type: 'tool-sendEmail', toolCallId: 'c1', state: 'approval-responded', input: { to: 'x' }, approval: { id: 'apr-1', approved: false, reason: 'no' } }] },
    ];
    expect(syncUIMessages(store, resp).map((e) => e.type)).toEqual(['APPROVAL_RESOLVED']);
    expect(store.getState().resolvedApprovals['apr-1']).toMatchObject({ decision: 'reject', payload: { reason: 'no' } });
    expect(store.getState().pendingApprovals).toHaveLength(0);
    expect(syncUIMessages(store, resp)).toEqual([]);
  });

  it('records request + resolution when first seen already responded (server history)', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    const evs = syncUIMessages(store, [
      { id: 'a', role: 'assistant', parts: [{ type: 'tool-x', toolCallId: 'c', state: 'approval-responded', input: {}, approval: { id: 'p', approved: true } }] },
    ]);
    expect(evs.filter((e) => e.type.startsWith('APPROVAL')).map((e) => e.type)).toEqual(['APPROVAL_REQUESTED', 'APPROVAL_RESOLVED']);
    expect(store.getState().resolvedApprovals.p!.decision).toBe('approve');
    expect(store.getState().pendingApprovals).toHaveLength(0);
  });

  it('uses toolCallId as approvalId when no approval.id, and supports custom titles', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    syncUIMessages(
      store,
      [{ id: 'a', role: 'assistant', parts: [{ type: 'tool-rm', toolCallId: 'c9', state: 'approval-requested', input: { path: '/' } }] }],
      { approvalTitle: (p) => `Really run ${p.toolName ?? p.type}?` },
    );
    expect(store.getState().pendingApprovals[0]).toMatchObject({ approvalId: 'c9', title: 'Really run tool-rm?' });
  });
});

describe('toToolApprovalResponse', () => {
  it('maps decisions to { id, approved, reason }', () => {
    expect(toToolApprovalResponse({ approvalId: 'a', decision: 'approve' })).toEqual({ id: 'a', approved: true, reason: undefined });
    expect(toToolApprovalResponse({ approvalId: 'a', decision: 'reject', payload: { reason: 'nah' } })).toEqual({ id: 'a', approved: false, reason: 'nah' });
    expect(toToolApprovalResponse({ approvalId: 'a', decision: 'timeout' }).approved).toBe(false);
    expect(toToolApprovalResponse({ approvalId: 'a', decision: 'edit', payload: { x: 1 } }).approved).toBe(true);
  });
});
