# Health assistant backends

The assistant is not tied to one provider. `core/agents/` owns a small interface,
a registry that discovers what is installed, and one file per backend.

Shipped backends:

| Backend | Binary | Authentication |
| --- | --- | --- |
| Codex | `codex` (Codex Desktop) | Reuses the local Codex login |
| Claude Code | `claude` | Reuses the local Claude Code login |

Neither stores an API key. Both are given the same developer instructions and
run with no tools, so the assistant reasons over the health context it is handed
and nothing else.

## Selection

The registry lists every backend with a live availability check and selects the
first available one in declared order — Codex, then Claude Code — so machines
that already had Codex keep the behavior they had.

The choice persists in the encrypted config as `config.agentId`. If the selected
backend's binary later disappears, the registry falls back to the next available
one and rewrites the stored preference rather than failing a turn. The picker in
the assistant header appears once more than one backend is registered.

Override binary discovery with `CODEX_BINARY` or `CLAUDE_BINARY` (absolute path,
or a name to look up on `PATH`).

## The interface

```js
// core/agents/<name>.cjs
module.exports = {
  id: 'claude-code',
  label: 'Claude Code',
  resolveBinary(env),          // → absolute path | null   (must not spawn)
  create(options),             // → AgentSession
}
```

```js
// AgentSession
getStatus()   // → { id, label, available, connected, authenticated, busy, error? }
startTurn({ text, healthContext, onDelta })   // → Promise<{ text }>
cancelTurn()  // → Promise<void>
reset()       // → Promise<void>   discard conversation state
dispose()     // → Promise<void>
```

`create` is called lazily — listing backends never spawns a process, so the
picker is cheap to render.

`core/agents/agent-common.cjs` holds what every backend must share:

- `HEALTH_ASSISTANT_DEVELOPER_INSTRUCTIONS` — the system prompt, including the
  `openfit:navigate` directive contract the renderer parses
- `sanitizeMessage` — strips control characters and redacts bearer tokens and
  API keys before any error text reaches a client
- `serializeHealthContext` — enforces the 500,000-character cap
- `resolveBinary` — `PATH` and `PATHEXT` lookup with an environment override

## Adding a backend

1. Create `core/agents/<name>.cjs` exporting the module shape above.
2. Use the shared instructions verbatim. The renderer parses the navigation
   directive out of the reply, so a backend with a different prompt will look
   subtly broken rather than obviously broken.
3. Run `sanitizeMessage` over anything that can reach `getStatus().error` or a
   rejected `startTurn`. Backend stderr routinely contains credentials.
4. Deny every tool the backend offers. The assistant must not read files, run
   commands, or reach the network.
5. Register it in the `AGENTS` array in `core/agents/index.cjs`. Order is the
   default-selection order.
6. Add tests alongside `claude-code.test.ts`: injected `spawn`, protocol parsing
   including split chunks and oversized input, cancellation, and a redaction
   assertion.

Nothing else changes. The HTTP routes, the picker, and the persisted preference
are all driven by the registry.

### Example: an Anthropic Messages API backend

Not shipped, but the seam exists. Such a backend would differ in three ways:
`resolveBinary` becomes a key check rather than a `PATH` lookup; the key belongs
in the encrypted credential store, never in an environment variable read at
request time; and `startTurn` streams from the SDK instead of parsing a
subprocess's stdout. The interface itself is unchanged.

## Testing against the real CLI

Unit tests use a fake child process. To check a real backend end to end:

```bash
npm run serve   # requires .env; see docs/SELF_HOSTING.md
TOKEN="$(cat ~/.local/share/openfit/server-token)"
curl -s -H "Authorization: Bearer $TOKEN" localhost:7788/api/assistant/agents
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST localhost:7788/api/assistant/turn \
  -d '{"requestId":"probe-0001","message":"How many steps?","healthContext":"{\"steps\":11542}"}'
```

Replies stream over `GET /api/events` as `assistant` events, not in the POST
response.

The bearer token reaches `/api/*` only and names no account. If more than one
Google account has signed in to the instance, add
`-H 'X-OpenFit-Account: you@example.com'` or the request is refused with `409`.
