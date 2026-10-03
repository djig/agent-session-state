import type { EventInput, SessionEvent } from '../src/core/events';

let seq = 0;
export function resetSeq() {
  seq = 0;
}

/** Stamp seq/ts onto an event input (for direct reducer tests). */
export function ev<E extends SessionEvent>(input: EventInput<E>, ts = 1_000 + seq): E {
  seq += 1;
  return { ...(input as object), seq, ts } as unknown as E;
}

export function stamp(inputs: EventInput[]): SessionEvent[] {
  resetSeq();
  return inputs.map((i) => ev(i));
}

/** Tiny deterministic PRNG for property-style tests. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export function randomEvents(seed: number, n: number): SessionEvent[] {
  const r = rng(seed);
  const pick = <T>(arr: T[]): T => arr[Math.floor(r() * arr.length)]!;
  const inputs: EventInput[] = [];
  const runIds = ['r1', 'r2'];
  const msgIds = ['m1', 'm2', 'm3'];
  const toolIds = ['t1', 't2'];
  const subIds = ['s1', 's2', 's3'];
  const aprIds = ['a1', 'a2'];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(r() * 16);
    switch (k) {
      case 0:
        inputs.push({ type: 'RUN_STARTED', runId: pick(runIds) });
        break;
      case 1:
        inputs.push({ type: 'RUN_FINISHED', runId: pick(runIds) });
        break;
      case 2:
        inputs.push({ type: 'TEXT_MESSAGE_START', messageId: pick(msgIds), role: 'assistant' });
        break;
      case 3:
        inputs.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: pick(msgIds), delta: `x${i} ` });
        break;
      case 4:
        inputs.push({ type: 'TEXT_MESSAGE_END', messageId: pick(msgIds) });
        break;
      case 5:
        inputs.push({ type: 'TOOL_CALL_START', toolCallId: pick(toolIds), toolCallName: 'search' });
        break;
      case 6:
        inputs.push({ type: 'TOOL_CALL_ARGS', toolCallId: pick(toolIds), delta: '{"q":1}' });
        break;
      case 7:
        inputs.push({ type: 'TOOL_CALL_END', toolCallId: pick(toolIds) });
        break;
      case 8:
        inputs.push({ type: 'TOOL_CALL_RESULT', toolCallId: pick(toolIds), content: { ok: i } });
        break;
      case 9:
        inputs.push({ type: 'SUBAGENT_STARTED', subagentId: pick(subIds), name: 'sub', parentId: r() > 0.5 ? pick(subIds) : undefined });
        break;
      case 10:
        inputs.push({ type: 'SUBAGENT_FINISHED', subagentId: pick(subIds) });
        break;
      case 11:
        inputs.push({ type: 'APPROVAL_REQUESTED', approvalId: pick(aprIds), kind: 'tool', title: 'ok?' });
        break;
      case 12:
        inputs.push({ type: 'APPROVAL_RESOLVED', approvalId: pick(aprIds), decision: 'approve', resolvedBy: 'user' });
        break;
      case 13:
        inputs.push({ type: 'USAGE', model: 'm', inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
        break;
      case 14:
        inputs.push({ type: 'STATE_SNAPSHOT', snapshot: { count: i, items: [] } });
        break;
      default:
        inputs.push({ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/items/-', value: i }] });
        break;
    }
  }
  return stamp(inputs);
}
