'use client';

// Illustrative only — not compiled as part of this repo. See ../README.md.

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useState } from 'react';
import { createSessionStore } from '@djig/agent-session-state';
import { localStorageStorage } from '@djig/agent-session-state/storage/local-storage';
import { syncUIMessages, toToolApprovalResponse } from '@djig/agent-session-state/adapters/ai-sdk';
import { useAgentSession, useOutbox, usePendingApprovals, useUsage } from '@djig/agent-session-state/react';

const CHAT_ID = 'demo-chat'; // in a real app: route param / server-issued id

export default function Page() {
  const store = useMemo(
    () => createSessionStore({ sessionId: CHAT_ID, storage: localStorageStorage({ prefix: 'demo:' }) }),
    [],
  );
  const { hydrated, status, resolveApproval } = useAgentSession(store);
  const pending = usePendingApprovals(store);
  const outbox = useOutbox(store);
  const usage = useUsage(store);

  const chat = useChat({
    id: CHAT_ID,
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  const [input, setInput] = useState('');

  // 1. Mirror useChat's messages into the durable log (idempotent).
  useEffect(() => {
    if (hydrated) syncUIMessages(store, chat.messages);
  }, [hydrated, chat.messages, store]);

  // 2. Deliver any resolution the user made (possibly before a reload) back to the AI SDK.
  useEffect(() => {
    if (!hydrated) return;
    for (const r of outbox) {
      chat.addToolApprovalResponse(toToolApprovalResponse(r));
      store.markDelivered(r.approvalId);
    }
  }, [hydrated, outbox, chat, store]);

  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <p>
        status: <b>{status}</b> · hydrated: {String(hydrated)} · tokens in/out: {usage.totals.inputTokens}/
        {usage.totals.outputTokens}
      </p>

      {pending.map((a) => (
        <div key={a.approvalId} style={{ border: '1px solid #c90', padding: 12, marginBottom: 12 }}>
          <b>{a.title}</b>
          <pre>{JSON.stringify(a.payload, null, 2)}</pre>
          <button onClick={() => resolveApproval(a.approvalId, 'approve')}>Approve</button>{' '}
          <button onClick={() => resolveApproval(a.approvalId, 'reject', { reason: 'User declined' })}>Reject</button>
          <p style={{ fontSize: 12, opacity: 0.7 }}>Reload the page: this card is still here.</p>
        </div>
      ))}

      {chat.messages.map((m) => (
        <div key={m.id}>
          <b>{m.role}:</b>{' '}
          {m.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text}</span> : null))}
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          chat.sendMessage({ text: input });
          setInput('');
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask me to send an email…" />
      </form>
    </main>
  );
}
