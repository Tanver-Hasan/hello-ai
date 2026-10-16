# Lesson 13: Real-Time Edgeword State and RPC

## Use case

Extend `EdgewordAgent` so multiple tabs share conversation mode, routed-model telemetry, and learning-trace preferences in real time. Authorized owners can change settings; readonly observers can watch the trace.

Message generation continues to use the existing `/chat/stream` and `/chat/protected` routes. The Agent adds optional synchronized learning state; it does not take ownership of core chat messages.

## Cloudflare framework and infrastructure used

- `Agent<Env, State>`
- Agent state synchronization over WebSockets
- `@callable()` RPC
- Agent-local SQLite through `this.sql`
- Readonly Agent connections
- Cloudflare Access identity for owner/viewer authorization
- Current Gateway telemetry as sanitized Agent state

## Goal

Learn:

- Synchronized agent state
- Callable methods
- SQLite event history
- WebSocket broadcasts
- Readonly spectator connections
- Validation and authorization boundaries

## Step 1: Model one coordination atom

Use one Agent instance per existing conversation UUID:

```text
/agents/edgeword-agent/550e8400-e29b-41d4-a716-446655440000
/agents/edgeword-agent/6ba7b810-9dad-41d1-80b4-00c04fd430c8
```

Do not use one global Agent for every conversation; it creates a bottleneck and weakens tenant isolation.

## Step 2: Define synchronized state

```ts
type RoutingSnapshot = {
	requestId: string;
	decision: "simple" | "complex" | "tool";
	confidence: number;
	model: string;
	cost: number;
};

type ConversationAgentState = {
	mode: "stream" | "protected";
	traceVisible: boolean;
	lastRouting?: RoutingSnapshot;
	version: number;
};
```

Keep synchronized state compact. Store large audit history in the agent’s SQLite database rather than broadcasting it with every state update.

## Step 3: Validate state transitions

```ts
export class EdgewordAgent extends Agent<Env, ConversationAgentState> {
	initialState: ConversationAgentState = {
		mode: "stream",
		traceVisible: true,
		version: 0,
	};

	validateStateChange(next: ConversationAgentState) {
		if (next.mode !== "stream" && next.mode !== "protected") {
			throw new Error("Invalid mode");
		}
		if (!Number.isInteger(next.version) || next.version < 0) {
			throw new Error("Invalid version");
		}
	}
}
```

Client-provided state is untrusted. Validation belongs on the Agent.

## Step 4: Expose narrow RPC methods

```ts
@callable()
setPreferences(
	mode: "stream" | "protected",
	traceVisible: boolean,
	expectedVersion: number,
) {
	if (expectedVersion !== this.state.version) {
		throw new Error("State changed; reload and retry");
	}
	this.setState({
		...this.state,
		mode,
		traceVisible,
		version: this.state.version + 1,
	});
	return this.state;
}
```

Prefer intent-based methods such as `setPreferences()` over allowing clients to replace complete Agent state.

## Step 5: Store an audit trail in SQLite

```ts
this.sql`
	CREATE TABLE IF NOT EXISTS routing_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		request_id TEXT NOT NULL UNIQUE,
		decision TEXT NOT NULL,
		confidence REAL NOT NULL,
		model TEXT NOT NULL,
		cost REAL NOT NULL,
		created_at INTEGER NOT NULL
	)
`;
```

After a successful state transition:

```ts
this.sql`
	INSERT INTO routing_events (
		request_id, decision, confidence, model, cost, created_at
	) VALUES (
		${snapshot.requestId},
		${snapshot.decision},
		${snapshot.confidence},
		${snapshot.model},
		${snapshot.cost},
		${Date.now()}
	)
`;
```

Persist only sanitized telemetry—never prompts, answers, Access tokens, or Gateway credentials. Use the request ID already shown in the current learning trace.

## Step 6: Add readonly spectators

```ts
shouldConnectionBeReadonly(connection: Connection) {
	return verifiedRole(connection) === "viewer";
}
```

Readonly connections can observe state but cannot call mutating callable methods or push state. Derive the role from the Cloudflare Access identity already protecting the deployed lab.

## Step 7: Connect multiple React clients

```tsx
const agent = useAgent<EdgewordAgent, ConversationAgentState>({
	agent: "EdgewordAgent",
	name: conversationId,
});
```

Open the same conversation in two tabs. Changing mode or trace visibility in one tab should update the other through Agent state synchronization.

## Step 8: Handle conflicts

Keep the `expectedVersion` check in `setPreferences()`. An Agent serializes operations within one instance, but clients may still submit commands based on stale UI state.

## Step 9: Test

Test:

- State synchronization across clients
- Conversation isolation
- Stale-version rejection
- Spectator mutation rejection
- Routing events written once per request ID
- Prompt and answer text absent from audit rows
- WebSocket reconnection

## Checkpoint

- [ ] State is small and synchronized.
- [ ] Existing Clef, Auto Router, and Gateway telemetry feed Agent state.
- [ ] Sanitized routing history is stored separately.
- [ ] RPC methods represent intent.
- [ ] Spectators are readonly.
- [ ] Authorization is derived from trusted identity.
- [ ] Stale client commands are rejected.

References:

- [Agent state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/)
- [Callable methods](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/)
- [Readonly connections](https://developers.cloudflare.com/agents/runtime/communication/readonly-connections/)

Continue to [Lesson 14](../lesson-14-ai-chat-agent/README.md).
