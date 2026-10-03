// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmitter, createSessionStore, memoryStorage, type SessionStore } from '../../src';
import { useAgentSession, usePendingApprovals, useSubagentTree, useToolCalls, useUsage, useMessages, useResumeCursor } from '../../src/react';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(cleanup);

function Approvals({ store }: { store: SessionStore }) {
  const { hydrated, status, resolveApproval } = useAgentSession(store);
  const pending = usePendingApprovals(store);
  return (
    <div>
      <span data-testid="hydrated">{String(hydrated)}</span>
      <span data-testid="status">{status}</span>
      <ul>
        {pending.map((a) => (
          <li key={a.approvalId}>
            {a.title}
            <button onClick={() => resolveApproval(a.approvalId, 'approve')}>approve {a.approvalId}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

describe('react hooks', () => {
  it('renders pending approvals after hydration and updates on resolve, with no act() warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = memoryStorage();
    const prev = createSessionStore({ sessionId: 's', storage });
    createEmitter(prev).requestApproval({ approvalId: 'ap1', title: 'Send email?' });
    await prev.flush();

    const store = createSessionStore({ sessionId: 's', storage });
    render(<Approvals store={store} />);
    expect(screen.getByTestId('hydrated').textContent).toBe('false');
    await waitFor(() => expect(screen.getByTestId('hydrated').textContent).toBe('true'));
    expect(screen.getByText('Send email?')).toBeTruthy();
    expect(screen.getByTestId('status').textContent).toBe('awaiting_approval');

    act(() => {
      screen.getByText('approve ap1').click();
    });
    expect(screen.queryByText('Send email?')).toBeNull();
    expect(screen.getByTestId('status').textContent).toBe('idle');
    expect(store.getState().outbox).toHaveLength(1);
    await store.flush();

    const actWarnings = errorSpy.mock.calls.filter((c) => String(c[0]).includes('act('));
    expect(actWarnings).toEqual([]);
    errorSpy.mockRestore();
  });

  it('selector hooks re-render only when their slice changes', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    await store.hydrate();
    const renders = { usage: 0, tools: 0, tree: 0, msgs: 0, cursor: 0 };
    function Usage() {
      renders.usage++;
      const u = useUsage(store);
      return <span data-testid="cost">{u.totals.costUsd}</span>;
    }
    function Tools() {
      renders.tools++;
      const t = useToolCalls(store);
      return <span data-testid="tools">{t.map((x) => x.name).join(',')}</span>;
    }
    function Tree() {
      renders.tree++;
      const roots = useSubagentTree(store);
      return <span data-testid="tree">{roots.map((r) => `${r.name}(${r.children.length})`).join(',')}</span>;
    }
    function Msgs() {
      renders.msgs++;
      const m = useMessages(store);
      return <span data-testid="msgs">{m.map((x) => x.content).join('|')}</span>;
    }
    function CursorView() {
      renders.cursor++;
      const c = useResumeCursor(store);
      return <span data-testid="cursor">{c.lastSeq}</span>;
    }
    render(
      <>
        <Usage />
        <Tools />
        <Tree />
        <Msgs />
        <CursorView />
      </>,
    );
    const base = { ...renders };
    const emit = createEmitter(store);
    act(() => {
      emit.usage({ model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
    });
    expect(screen.getByTestId('cost').textContent).toBe('0.25');
    expect(renders.usage).toBe(base.usage + 1);
    expect(renders.tools).toBe(base.tools); // unchanged slice → no re-render
    expect(renders.msgs).toBe(base.msgs);
    expect(renders.cursor).toBe(base.cursor + 1); // cursor changes on every event

    act(() => {
      emit.toolCall({ toolCallId: 't', name: 'search', args: { q: 1 } });
      const root = emit.subagentStarted({ subagentId: 'root', name: 'planner' });
      emit.subagentStarted({ subagentId: 'kid', name: 'worker', parentId: root });
      emit.text('m1', 'hello');
    });
    expect(screen.getByTestId('tools').textContent).toBe('search');
    expect(screen.getByTestId('tree').textContent).toBe('planner(1)');
    expect(screen.getByTestId('msgs').textContent).toBe('hello');
    expect(renders.usage).toBe(base.usage + 1);
    await store.flush();
  });

  it('useToolCalls accepts a filter', async () => {
    const store = createSessionStore({ sessionId: 's', storage: memoryStorage() });
    await store.hydrate();
    const emit = createEmitter(store);
    emit.toolCall({ toolCallId: 'a', name: 'read' });
    emit.toolCall({ toolCallId: 'b', name: 'write', result: 'ok' });
    const filter = (tc: { status: string }) => tc.status === 'done';
    function C() {
      const done = useToolCalls(store, filter);
      return <span data-testid="done">{done.map((t) => t.id).join(',')}</span>;
    }
    render(<C />);
    expect(screen.getByTestId('done').textContent).toBe('b');
    await store.flush();
  });
});
