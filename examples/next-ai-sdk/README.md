# Example: Next.js + AI SDK `useChat` + `@djig/agent-session-state`

Illustrative code only — this directory is **not built or tested** as part of the
package. It shows the shape of the integration:

- `app/page.tsx` — `useChat` mirrored into a `localStorageStorage`-backed store; approvals
  survive a page reload and are delivered back to the AI SDK via `addToolApprovalResponse`.
- `app/api/chat/route.ts` — an AI SDK route with a tool that needs approval.

Drop these into a fresh `create-next-app` with `ai`, `@ai-sdk/react`, an AI SDK provider
package, and `@djig/agent-session-state` installed. Adjust imports for your AI SDK version;
the approval API (`needsApproval`, `addToolApprovalResponse`, `approval-requested` parts)
is AI SDK ≥ 5.1 / 6.
