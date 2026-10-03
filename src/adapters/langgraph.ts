import type { ApprovalKind, ApprovalRequestedEvent, EventInput } from '../core/events';
import type { Resolution } from '../core/state';

/**
 * Structural shape of a LangGraph interrupt as surfaced by `useStream().interrupt`
 * or the `__interrupt__` key in a run result.
 */
export interface LangGraphInterrupt {
  value: unknown;
  /** Present in LangGraph ≥ 0.4 as `id`; older versions expose `ns: string[]`. */
  id?: string;
  ns?: string[];
  resumable?: boolean;
  when?: string;
}

export interface FromInterruptOptions {
  runId?: string;
  threadId?: string;
  /** Default: `interrupt.id` ?? `ns.join('/')` ?? `${threadId}:interrupt`. */
  approvalId?: string;
  kind?: ApprovalKind;
  /** Default: `value.title` / `value.question` / `value.action_request.action` / 'Input required'. */
  title?: string;
  options?: string[];
}

/** Map a LangGraph interrupt into an APPROVAL_REQUESTED event input. */
export function fromInterrupt(
  interrupt: LangGraphInterrupt,
  options: FromInterruptOptions = {},
): EventInput<ApprovalRequestedEvent> {
  const v = (typeof interrupt.value === 'object' && interrupt.value !== null ? interrupt.value : {}) as Record<string, unknown>;
  const actionRequest = (v.action_request ?? v.actionRequest) as Record<string, unknown> | undefined;
  const approvalId =
    options.approvalId ??
    interrupt.id ??
    (interrupt.ns && interrupt.ns.length ? interrupt.ns.join('/') : undefined) ??
    `${options.threadId ?? 'thread'}:interrupt`;
  const title =
    options.title ??
    pickString(v.title) ??
    pickString(v.question) ??
    pickString(v.description) ??
    pickString(actionRequest?.action) ??
    (typeof interrupt.value === 'string' ? interrupt.value : 'Input required');
  const kind: ApprovalKind = options.kind ?? (actionRequest ? 'tool' : pickString(v.question) ? 'question' : 'custom');
  let opts = options.options;
  if (!opts && Array.isArray(v.options)) opts = (v.options as unknown[]).filter((o): o is string => typeof o === 'string');
  // LangGraph HumanInterrupt: config = { allow_accept, allow_edit, allow_respond, allow_ignore }
  const cfg = v.config as Record<string, boolean> | undefined;
  if (!opts && cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    opts = [];
    if (cfg.allow_accept) opts.push('approve');
    if (cfg.allow_edit) opts.push('edit');
    if (cfg.allow_respond) opts.push('answer');
    if (cfg.allow_ignore) opts.push('reject');
    if (!opts.length) opts = undefined;
  }
  return {
    type: 'APPROVAL_REQUESTED',
    approvalId,
    kind,
    title,
    payload: interrupt.value,
    options: opts,
    runId: options.runId,
    threadId: options.threadId,
  };
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

export interface LangGraphResumeCommand {
  resume: unknown;
}

/**
 * Convert a resolution into the `Command({ resume })` payload for
 * `useStream().submit(undefined, { command: toResumeCommand(resolution) })`.
 *
 * Shape of `resume`:
 * - `approve` → `payload` if provided, else `{ type: 'accept' }`
 * - `reject`  → `payload` if provided, else `{ type: 'ignore' }`
 * - `edit`    → `{ type: 'edit', args: payload }`
 * - `answer`  → `{ type: 'response', args: payload }`
 * - `timeout` → `{ type: 'ignore' }`
 */
export function toResumeCommand(resolution: Pick<Resolution, 'decision' | 'payload'>): LangGraphResumeCommand {
  switch (resolution.decision) {
    case 'approve':
      return { resume: resolution.payload ?? { type: 'accept' } };
    case 'reject':
      return { resume: resolution.payload ?? { type: 'ignore' } };
    case 'edit':
      return { resume: { type: 'edit', args: resolution.payload } };
    case 'answer':
      return { resume: { type: 'response', args: resolution.payload } };
    case 'timeout':
      return { resume: { type: 'ignore' } };
  }
}
