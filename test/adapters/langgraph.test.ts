import { describe, expect, it } from 'vitest';
import { createSessionStore, memoryStorage } from '../../src';
import { fromInterrupt, toResumeCommand } from '../../src/adapters/langgraph';

describe('langgraph adapter', () => {
  it('maps a HumanInterrupt-style interrupt to APPROVAL_REQUESTED', () => {
    const ev = fromInterrupt(
      {
        id: 'int-1',
        value: {
          action_request: { action: 'send_email', args: { to: 'a@b.c' } },
          config: { allow_accept: true, allow_edit: true, allow_respond: false, allow_ignore: true },
          description: 'Send this email?',
        },
      },
      { runId: 'run-1', threadId: 'thread-1' },
    );
    expect(ev).toEqual({
      type: 'APPROVAL_REQUESTED',
      approvalId: 'int-1',
      kind: 'tool',
      title: 'Send this email?',
      payload: expect.objectContaining({ action_request: expect.anything() }),
      options: ['approve', 'edit', 'reject'],
      runId: 'run-1',
      threadId: 'thread-1',
    });
  });

  it('derives ids/titles from ns, question, or plain strings', () => {
    expect(fromInterrupt({ value: { question: 'Which city?', options: ['SF', 'NYC'] }, ns: ['agent:1', 'ask'] }, { threadId: 't' })).toMatchObject({
      approvalId: 'agent:1/ask',
      kind: 'question',
      title: 'Which city?',
      options: ['SF', 'NYC'],
    });
    expect(fromInterrupt({ value: 'Continue?' }, { threadId: 't' })).toMatchObject({ approvalId: 't:interrupt', kind: 'custom', title: 'Continue?' });
    expect(fromInterrupt({ value: { weird: true } })).toMatchObject({ approvalId: 'thread:interrupt', title: 'Input required' });
  });

  it('round-trips: interrupt → store → resolve → resume command', () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    store.append(fromInterrupt({ id: 'i', value: { question: 'Proceed?' } }, { threadId: 't' }));
    expect(store.getState().status).toBe('awaiting_approval');
    const res = store.resolveApproval('i', 'answer', 'yes please')!;
    expect(toResumeCommand(res)).toEqual({ resume: { type: 'response', args: 'yes please' } });
    expect(store.getState().status).toBe('idle');
  });

  it('maps every decision', () => {
    expect(toResumeCommand({ decision: 'approve' })).toEqual({ resume: { type: 'accept' } });
    expect(toResumeCommand({ decision: 'approve', payload: { custom: 1 } })).toEqual({ resume: { custom: 1 } });
    expect(toResumeCommand({ decision: 'reject' })).toEqual({ resume: { type: 'ignore' } });
    expect(toResumeCommand({ decision: 'edit', payload: { to: 'z' } })).toEqual({ resume: { type: 'edit', args: { to: 'z' } } });
    expect(toResumeCommand({ decision: 'timeout' })).toEqual({ resume: { type: 'ignore' } });
  });
});
