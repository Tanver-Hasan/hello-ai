# Lesson 18: Production Agent Security and Observability

## Goal

Prepare an Agent application for real users without relying on unguessable instance names as authorization.

## Production architecture from this lab

```text
Cloudflare Access
  → Worker Rate Limiting
  → Worker
      ├── Current chat (unchanged)
      │     ├── /chat/stream
      │     ├── /chat/protected
      │     └── Conversation Durable Object
      │
      └── routeAgentRequest
            └── Optional EdgewordChatAgent
                  ├── separate SQLite + WebSockets + RPC
                  ├── Clef + Auto Router + AI Gateway
                  ├── schedules/queues
                  ├── AgentWorkflow
                  └── approved MCP tools
```

## Cloudflare framework and infrastructure used

- Agents SDK lifecycle, state, RPC, schedules, queues, and Workflows
- Agent diagnostics channels and Tail Workers
- Cloudflare Access for HTTP and WebSocket identity
- Worker Rate Limiting
- SQLite-backed Agent Durable Objects
- Workers AI and AI Gateway controls
- Worker Previews for isolated rollout

## Step 0: Preserve existing controls

The Agent enhancement is incomplete if it weakens any current guarantee:

| Current lab control | Additional Agent requirement |
| --- | --- |
| Access application | Authenticate HTTP and WebSocket upgrades |
| Conversation UUID | Agent instance routing only |
| 10 chat turns/minute | Rate limit Agent messages and mutating RPC |
| 16 KiB body limit | Apply equivalent message/RPC limits |
| 40 stored messages | Configure bounded Agent chat persistence |
| `$5` per Gateway/30 days | Include Agent, schedule, and Workflow inference |
| Request-only streaming DLP | Preserve on streaming Agent turns |
| Full protected Guardrails/DLP | Keep buffered protected execution |
| Sanitized telemetry | Emit Agent and Gateway events without prompts |
| `storage.deleteAll()` | Add authorized Agent data deletion |

## Step 1: Define tenant identity

Every request and WebSocket connection must derive identity from a verified source:

- Cloudflare Access identity
- Application session
- Signed service token
- mTLS identity

Do not trust:

- Browser-provided user IDs
- Agent instance names
- Query-string roles
- Random UUIDs as authorization

## Step 2: Authorize agent instances

Map the authenticated Access identity to allowed Edgeword Agent names. Before routing:

```text
authenticated user → authorized agent instance → routeAgentRequest
```

Reject cross-tenant reads, RPC calls, schedules, workflow approvals, and MCP tools.

The current UUID-only conversation ownership gap must be closed here. Store an immutable owner subject on first authorized creation and verify it before every Agent connection or HTTP/RPC call.

## Step 3: Use readonly connections

For dashboards and spectators:

```ts
shouldConnectionBeReadonly(connection: Connection) {
	return verifiedRole(connection) === "viewer";
}
```

Readonly mode blocks client state writes and mutating callable methods. It does not replace authentication.

## Step 4: Limit cost and abuse

Layer controls:

1. Worker rate limits per authenticated actor
2. Maximum WebSocket connections per actor
3. Message and RPC payload limits
4. Tool-step limits
5. Schedule and queue quotas
6. Workflow concurrency limits
7. AI Gateway rate and spend limits
8. Bounded SQLite rows and message history

Agents can schedule future cost. Validate and authorize schedule creation. A scheduled or Workflow inference must still pass through one of the two budgeted AI Gateways.

## Step 5: Protect callable methods

Classify methods:

- Readonly
- Mutating
- Privileged
- Side-effecting

Validate every argument at the Agent boundary. Never expose a callable wrapper around arbitrary method names.

## Step 6: Add structured observability

Agents publish diagnostics-channel events for:

- Lifecycle
- State
- RPC
- Schedules
- Queues
- Workflows
- MCP

Subscribe locally:

```ts
import { subscribe } from "agents/observability";

const unsubscribe = subscribe("rpc", (event) => {
	if (event.type === "rpc:error") {
		console.error(event.payload.method, event.payload.error);
	}
});
```

In production, diagnostics events are automatically available to Tail Workers through `diagnosticsChannelEvents`.

Do not log:

- Prompts by default
- Tool secrets
- Authorization headers
- MCP OAuth tokens
- Full personal records

## Step 7: Monitor stateful resources

Track:

- Active agent instances
- SQLite storage and row growth
- WebSocket connections
- Schedule backlog
- Queue age and retries
- Workflow failures and approvals
- Tool errors
- Tokens and inference cost

Set alerts for unusual instance creation and schedule growth.

## Step 8: Plan schema evolution

Agent and Durable Object storage is not rolled back with Worker code.

Before deployment:

1. Make schema changes additive.
2. Keep old readers compatible.
3. Test upgrades with existing state.
4. Test code rollback against upgraded storage.
5. Back up critical external data.

Never edit an already-deployed Durable Object migration.

## Step 9: Test failure recovery

Exercise:

- WebSocket disconnect and reconnect
- Agent eviction
- Worker deployment during work
- Schedule retry
- Queue callback failure
- Workflow restart
- MCP server outage
- Identity expiration
- Rate and spend limit exhaustion

## Step 10: Deploy progressively

Use an isolated environment or Worker Preview with isolated Agent/Durable Object state. Restrict initial access to Access test users.

Validate:

- Authorized browser client
- Unauthorized browser client
- Readonly client
- Service token client
- Cross-tenant attack
- Rate-limit behavior
- Logs contain no secrets

## Checkpoint

- [ ] Identity and authorization are separate.
- [ ] Agent names are not treated as credentials.
- [ ] Readonly clients cannot mutate.
- [ ] Schedules, queues, tools, and Workflows have quotas.
- [ ] Diagnostics events reach observability.
- [ ] Schema upgrade and rollback are tested.
- [ ] Failure recovery is exercised before production rollout.
- [ ] Every feature from Lessons 1–11 remains available and unchanged.
- [ ] Agent and `Conversation` storage have independent deletion paths.
- [ ] Existing conversation data requires no Agent migration.

References:

- [Agents observability](https://developers.cloudflare.com/agents/runtime/operations/observability/)
- [Diagnostics channels](https://developers.cloudflare.com/agents/runtime/operations/observability/diagnostics-channels/)
- [Cross-domain authentication](https://developers.cloudflare.com/agents/runtime/operations/cross-domain-authentication/)
- [Readonly connections](https://developers.cloudflare.com/agents/runtime/communication/readonly-connections/)

Continue to [Lesson 19](../lesson-19-vectorize-rag-agent/README.md).
