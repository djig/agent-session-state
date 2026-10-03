import { describe, expect, it } from 'vitest';
import { createEmptyState, reduce, replay, subagentTree, children } from '../../src';
import { randomEvents, stamp } from '../helpers';

describe('reducer: determinism', () => {
  it('replaying the same random log twice yields deep-equal state', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const events = randomEvents(seed, 120);
      const a = replay('s', events);
      const b = replay('s', events);
      expect(a).toEqual(b);
      expect(a.cursor.lastSeq).toBe(120);
    }
  });

  it('never mutates its input state', () => {
    const events = randomEvents(7, 60);
    const empty = createEmptyState('s');
    const frozen = JSON.stringify(empty);
    let s = empty;
    for (const e of events) {
      const before = JSON.stringify(s);
      const next = reduce(s, e);
      expect(JSON.stringify(s)).toBe(before);
      s = next;
    }
    expect(JSON.stringify(empty)).toBe(frozen);
  });

  it('returns a new reference when state changed and the same reference is never mutated', () => {
    const s0 = createEmptyState('s');
    const [e] = stamp([{ type: 'RUN_STARTED', runId: 'r' }]);
    const s1 = reduce(s0, e!);
    expect(s1).not.toBe(s0);
    expect(s0.runs).toEqual({});
  });
});

describe('reducer: text', () => {
  it('accumulates text per message and tracks completion', () => {
    const s = replay(
      's',
      stamp([
        { type: 'RUN_STARTED', runId: 'r1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'World' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      ]),
    );
    expect(s.messages.map((m) => [m.id, m.content, m.complete])).toEqual([
      ['m1', 'Hello', true],
      ['m2', 'World', false],
    ]);
    expect(s.messages[0]!.parts).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(s.messages[0]!.runId).toBe('r1');
  });

  it('tolerates content before start', () => {
    const s = replay('s', stamp([{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'x' }]));
    expect(s.messages[0]!.content).toBe('x');
    expect(s.messages[0]!.role).toBe('assistant');
  });

  it('accumulates reasoning separately', () => {
    const s = replay(
      's',
      stamp([
        { type: 'REASONING_START', messageId: 'm' },
        { type: 'REASONING_CONTENT', messageId: 'm', delta: 'think' },
        { type: 'REASONING_CONTENT', messageId: 'm', delta: 'ing' },
        { type: 'REASONING_END', messageId: 'm' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'answer' },
      ]),
    );
    expect(s.messages[0]!.reasoning).toBe('thinking');
    expect(s.messages[0]!.content).toBe('answer');
    expect(s.messages[0]!.parts).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
    ]);
  });
});

describe('reducer: tool calls', () => {
  it('assembles args across deltas and parses JSON on END', () => {
    const s = replay(
      's',
      stamp([
        { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'search', parentMessageId: 'm1' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"q":"we' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: 'ather","n":2}' },
        { type: 'TOOL_CALL_END', toolCallId: 't1' },
      ]),
    );
    const tc = s.toolCalls.t1!;
    expect(tc.argsText).toBe('{"q":"weather","n":2}');
    expect(tc.args).toEqual({ q: 'weather', n: 2 });
    expect(tc.status).toBe('ready');
    expect(s.messages[0]!.parts).toEqual([{ type: 'tool-call', toolCallId: 't1' }]);
  });

  it('records results and errors', () => {
    const s = replay(
      's',
      stamp([
        { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'a' },
        { type: 'TOOL_CALL_END', toolCallId: 't1' },
        { type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: { temp: 20 } },
        { type: 'TOOL_CALL_START', toolCallId: 't2', toolCallName: 'b' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 't2', delta: 'not json' },
        { type: 'TOOL_CALL_END', toolCallId: 't2' },
        { type: 'TOOL_CALL_RESULT', toolCallId: 't2', content: 'boom', isError: true },
      ]),
    );
    expect(s.toolCalls.t1).toMatchObject({ status: 'done', result: { temp: 20 }, args: {} });
    expect(s.toolCalls.t2).toMatchObject({ status: 'error', isError: true, args: undefined });
  });

  it('attaches parentSubagentId', () => {
    const s = replay(
      's',
      stamp([
        { type: 'SUBAGENT_STARTED', subagentId: 's1', name: 'researcher' },
        { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'a', parentSubagentId: 's1' },
      ]),
    );
    expect(s.toolCalls.t1!.parentSubagentId).toBe('s1');
  });
});

describe('reducer: subagents', () => {
  it('builds a nested tree', () => {
    const s = replay(
      's',
      stamp([
        { type: 'SUBAGENT_STARTED', subagentId: 'root', name: 'planner' },
        { type: 'SUBAGENT_STARTED', subagentId: 'c1', name: 'a', parentId: 'root' },
        { type: 'SUBAGENT_STARTED', subagentId: 'c2', name: 'b', parentId: 'root' },
        { type: 'SUBAGENT_STARTED', subagentId: 'g1', name: 'c', parentId: 'c1' },
        { type: 'SUBAGENT_FINISHED', subagentId: 'g1', output: 42 },
        { type: 'SUBAGENT_ERROR', subagentId: 'c2', message: 'nope' },
      ]),
    );
    const tree = subagentTree(s.subagents);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('root');
    expect(tree[0]!.children.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(tree[0]!.children[0]!.children[0]).toMatchObject({ id: 'g1', status: 'finished', output: 42 });
    expect(tree[0]!.children[1]).toMatchObject({ status: 'error', error: 'nope' });
    expect(children(s.subagents, 'root').map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(children(s.subagents, undefined).map((c) => c.id)).toEqual(['root']);
  });

  it('treats a child with an unknown parent as a root', () => {
    const s = replay('s', stamp([{ type: 'SUBAGENT_STARTED', subagentId: 'x', name: 'x', parentId: 'ghost' }]));
    expect(subagentTree(s.subagents).map((n) => n.id)).toEqual(['x']);
  });
});

describe('reducer: usage', () => {
  it('sums totals and per-model, including cost', () => {
    const s = replay(
      's',
      stamp([
        { type: 'USAGE', model: 'a', inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
        { type: 'USAGE', model: 'b', inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, costUsd: 0.002 },
        { type: 'USAGE', model: 'a', inputTokens: 1, outputTokens: 1 },
      ]),
    );
    expect(s.usage.totals).toEqual({ inputTokens: 111, outputTokens: 56, cachedInputTokens: 4, costUsd: 0.012, calls: 3 });
    expect(s.usage.byModel.a).toEqual({ inputTokens: 101, outputTokens: 51, cachedInputTokens: 0, costUsd: 0.01, calls: 2 });
    expect(s.usage.byModel.b!.calls).toBe(1);
  });
});

describe('reducer: status transitions', () => {
  it('idle → running → awaiting_approval → running → finished', () => {
    const [e1, e2, e3, e4] = stamp([
      { type: 'RUN_STARTED', runId: 'r' },
      { type: 'APPROVAL_REQUESTED', approvalId: 'a', kind: 'tool', title: 't' },
      { type: 'APPROVAL_RESOLVED', approvalId: 'a', decision: 'approve', resolvedBy: 'user' },
      { type: 'RUN_FINISHED', runId: 'r' },
    ]);
    let s = createEmptyState('s');
    expect(s.status).toBe('idle');
    s = reduce(s, e1!);
    expect(s.status).toBe('running');
    expect(s.cursor.runId).toBe('r');
    s = reduce(s, e2!);
    expect(s.status).toBe('awaiting_approval');
    s = reduce(s, e3!);
    expect(s.status).toBe('running');
    s = reduce(s, e4!);
    expect(s.status).toBe('finished');
    expect(s.cursor.runId).toBeUndefined();
  });

  it('RUN_ERROR → error, and a new run clears it', () => {
    let s = replay('s', stamp([{ type: 'RUN_STARTED', runId: 'r' }, { type: 'RUN_ERROR', message: 'bad', code: 'E1' }]));
    expect(s.status).toBe('error');
    expect(s.runs.r).toMatchObject({ status: 'error', error: { message: 'bad', code: 'E1' } });
    expect(s.lastError).toEqual({ message: 'bad', code: 'E1', runId: 'r' });
    s = reduce(s, { type: 'RUN_STARTED', runId: 'r2', seq: 3, ts: 3 });
    expect(s.status).toBe('running');
    expect(s.lastError).toBeUndefined();
  });

  it('steps open and close on the current run', () => {
    const s = replay(
      's',
      stamp([
        { type: 'RUN_STARTED', runId: 'r' },
        { type: 'STEP_STARTED', stepName: 'plan' },
        { type: 'STEP_STARTED', stepName: 'act' },
        { type: 'STEP_FINISHED', stepName: 'plan' },
      ]),
    );
    expect(s.runs.r!.steps).toEqual(['act']);
  });
});

describe('reducer: approvals & outbox', () => {
  it('moves approvals pending → resolved → outbox → delivered', () => {
    const [req, res, del] = stamp([
      { type: 'APPROVAL_REQUESTED', approvalId: 'a', kind: 'plan', title: 'Go?', options: ['yes', 'no'] },
      { type: 'APPROVAL_RESOLVED', approvalId: 'a', decision: 'answer', payload: 'yes', resolvedBy: 'user' },
      { type: 'APPROVAL_DELIVERED', approvalId: 'a' },
    ]);
    let s = reduce(createEmptyState('s'), req!);
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.pendingApprovals[0]).toMatchObject({ kind: 'plan', options: ['yes', 'no'] });
    s = reduce(s, res!);
    expect(s.pendingApprovals).toHaveLength(0);
    expect(s.resolvedApprovals.a).toMatchObject({ decision: 'answer', payload: 'yes' });
    expect(s.outbox).toHaveLength(1);
    s = reduce(s, del!);
    expect(s.outbox).toHaveLength(0);
  });

  it('ignores duplicate requests and late re-requests of resolved approvals', () => {
    const s = replay(
      's',
      stamp([
        { type: 'APPROVAL_REQUESTED', approvalId: 'a', kind: 'tool', title: 't' },
        { type: 'APPROVAL_REQUESTED', approvalId: 'a', kind: 'tool', title: 't' },
        { type: 'APPROVAL_RESOLVED', approvalId: 'a', decision: 'reject', resolvedBy: 'user' },
        { type: 'APPROVAL_REQUESTED', approvalId: 'a', kind: 'tool', title: 't' },
      ]),
    );
    expect(s.pendingApprovals).toHaveLength(0);
    expect(Object.keys(s.resolvedApprovals)).toEqual(['a']);
  });
});

describe('reducer: shared state, snapshots, cursor', () => {
  it('applies STATE_SNAPSHOT and STATE_DELTA, keeping last good state on a bad patch', () => {
    const s = replay(
      's',
      stamp([
        { type: 'STATE_SNAPSHOT', snapshot: { items: [], n: 1 } },
        { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/items/-', value: 'a' }, { op: 'replace', path: '/n', value: 2 }] },
        { type: 'STATE_DELTA', delta: [{ op: 'test', path: '/n', value: 999 }, { op: 'replace', path: '/n', value: 3 }] },
      ]),
    );
    expect(s.sharedState).toEqual({ items: ['a'], n: 2 });
  });

  it('MESSAGES_SNAPSHOT replaces messages and registers tool calls', () => {
    const s = replay(
      's',
      stamp([
        { type: 'TEXT_MESSAGE_START', messageId: 'old', role: 'assistant' },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [
            { id: 'u1', role: 'user', content: 'hi' },
            { id: 'a1', role: 'assistant', content: 'hello', toolCalls: [{ id: 'tc', name: 'f', args: { x: 1 } }] },
          ],
        },
      ]),
    );
    expect(s.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(s.messages[1]!.complete).toBe(true);
    expect(s.toolCalls.tc).toMatchObject({ name: 'f', args: { x: 1 }, status: 'ready', parentMessageId: 'a1' });
  });

  it('tracks STREAM_CURSOR, CHECKPOINT, ACTIVITY', () => {
    const s = replay(
      's',
      stamp([
        { type: 'STREAM_CURSOR', cursor: 'evt-42' },
        { type: 'CHECKPOINT', label: 'after-plan', state: { plan: true } },
        { type: 'ACTIVITY_SNAPSHOT', snapshot: { step: 1 } },
        { type: 'ACTIVITY_DELTA', delta: [{ op: 'replace', path: '/step', value: 2 }] },
        { type: 'CUSTOM', name: 'x', value: 1 },
        { type: 'RAW', event: { whatever: true } },
      ]),
    );
    expect(s.cursor).toEqual({ lastSeq: 6, streamCursor: 'evt-42' });
    expect(s.checkpoints).toEqual([{ label: 'after-plan', seq: 2, ts: 1001 }]);
    expect(s.sharedState).toEqual({ plan: true });
    expect(s.activity).toEqual({ step: 2 });
    expect(s.lastEventAt).toBe(1005);
  });
});
