# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-03

### Added

- Core: `SessionEvent` union (AG-UI names + `APPROVAL_*`, `USAGE`, `CHECKPOINT`, `STREAM_CURSOR`),
  pure `reduce`/`replay`, RFC 6902 `applyPatch`, `createSessionStore` with hydrate / compact /
  outbox / quota fallback, BYO pricing, `createEmitter`.
- Storage adapters: `memoryStorage`, `localStorageStorage` (chunked, quota-aware),
  `indexedDbStorage` (raw IDB), `httpStorage` + `createHttpStorageHandler` reference server.
- Adapters: AG-UI (`parseAgUiEvent`, `createSseParser`, `connectAgUi` with Last-Event-ID resume,
  backoff, visibility/online reconnect), AI SDK (`fromUIMessages`, `syncUIMessages`,
  `toToolApprovalResponse`), LangGraph (`fromInterrupt`, `toResumeCommand`).
- React: `useAgentSession`, `usePendingApprovals`, `useSubagentTree`, `useUsage`, `useToolCalls`,
  `useMessages`, `useResumeCursor`, `useSessionStatus`, `useOutbox`, `useSessionSelector`.
- Dual ESM/CJS build via tsup, per-entry `exports`, size budget check.
