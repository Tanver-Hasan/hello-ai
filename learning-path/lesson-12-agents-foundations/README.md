# Lesson 12: Cloudflare Agents Foundations

## Goal

Add the Cloudflare Agents SDK to the existing Edgeword Worker and introduce an `EdgewordAgent` beside the current `Conversation` Durable Object. This lesson introduces agent identity, SQLite-backed state, routing, callable RPC methods, WebSockets, and the React client without removing a working route.

## Starting architecture

```text
React UI
  ├── /conversations/:id/* → Conversation Durable Object
  ├── Clef-flash → route decision
  ├── cloudflare/auto → open-weight answer model
  ├── hello-ai-streaming → SSE + request DLP
  └── hello-ai-protected → Guardrails + request/response DLP
```

## Target after this lesson

```text
React UI
  ├── existing HTTP chat routes remain unchanged
  └── /agents/edgeword-agent/:conversationId
        └── synchronized mode and routing metadata
```

This is a permanent sidecar architecture. The existing chat is the primary lab and is never replaced by the Agents track.

## Cloudflare framework and infrastructure used

- `agents` package and `Agent` base class
- Agents Vite plugin for TC39 decorators
- Workers + Static Assets
- SQLite-backed Durable Object Agent instances
- Agent WebSocket transport and RPC
- React `useAgent`
- Existing Workers AI, AI Gateway, Access, and Rate Limiting bindings

## When to use an Agent

Use an Agent when one logical entity needs several of these capabilities together:

- Persistent state
- Real-time WebSocket clients
- Callable RPC methods
- Scheduling or queues
- AI tools and chat
- Workflow progress

A plain Worker remains better for stateless request/response APIs. A plain Durable Object remains appropriate when you need only coordination and storage without the higher-level agent lifecycle.

## Step 1: Work in an isolated branch

Lessons 12–18 extend the existing application architecture. Before implementation:

```bash
git status
git switch -c learn/agents-foundations
```

Keep unfinished Agent enhancements isolated from the deployed core chat until their separate routes pass.

## Step 2: Inspect and install the SDK

Check whether the package is already installed:

```bash
npm ls agents
```

When implementing this lesson, retrieve the current package release date and install a stable version published at least seven days earlier:

```bash
npm install agents
```

The Agents SDK uses SQLite-backed Durable Objects internally.

## Step 3: Configure decorators correctly

Agents callable methods use TC39 decorators—not TypeScript legacy decorators.

Add the Agents Vite plugin before React and Cloudflare:

```ts
import agents from "agents/vite";

export default defineConfig({
	plugins: [
		agents(),
		react(),
		cloudflare({ viteEnvironment: { name: "worker" } }),
	],
});
```

Use the Agents TypeScript configuration or set the Worker target to ES2021:

```json
{
	"extends": "agents/tsconfig"
}
```

Do not enable:

```json
{
	"experimentalDecorators": true
}
```

That flag enables incompatible legacy decorator behavior.

## Step 4: Configure the agent binding

Add Node.js compatibility:

```jsonc
"compatibility_flags": ["nodejs_compat"]
```

Add an Agent Durable Object binding without removing `CONVERSATIONS`:

```jsonc
"durable_objects": {
	"bindings": [
		{
			"name": "EdgewordAgent",
			"class_name": "EdgewordAgent"
		}
	]
}
```

New projects in the Agents documentation use a SQLite migration:

```jsonc
"migrations": [
	{
		"tag": "agents-v1",
		"new_sqlite_classes": ["EdgewordAgent"]
	}
]
```

This repository already uses declarative Durable Object exports. Before implementing, choose one lifecycle-management approach supported by the installed Wrangler schema; do not declare the same class through conflicting mechanisms.

Route agent traffic to the Worker before static assets:

```jsonc
"run_worker_first": [
	"/agents/*",
	"/chat/*",
	"/conversations/*"
]
```

Regenerate types:

```bash
npm run cf-typegen
```

## Step 5: Create the Edgeword Agent shell

Create `src/agents/edgeword.ts`:

```ts
import { Agent, callable, type Connection } from "agents";

export type EdgewordState = {
	mode: "stream" | "protected";
	turnCount: number;
	lastDecision?: "simple" | "complex" | "tool";
	lastModel?: string;
};

export class EdgewordAgent extends Agent<Env, EdgewordState> {
	initialState: EdgewordState = {
		mode: "stream",
		turnCount: 0,
	};

	override validateStateChange(
		nextState: EdgewordState,
		_source: Connection | "server",
	) {
		if (nextState.mode !== "stream" && nextState.mode !== "protected") {
			throw new Error("Invalid mode");
		}
		if (!Number.isInteger(nextState.turnCount) || nextState.turnCount < 0) {
			throw new Error("Invalid turn count");
		}
	}

	@callable()
	setMode(mode: "stream" | "protected") {
		this.setState({
			...this.state,
			mode,
		});
		return this.state;
	}

	recordRouting(
		decision: EdgewordState["lastDecision"],
		model: string,
	) {
		this.setState({
			...this.state,
			turnCount: this.state.turnCount + 1,
			lastDecision: decision,
			lastModel: model,
		});
	}
}
```

`initialState` initializes one Agent per conversation. `setState()` persists routing metadata and broadcasts it to connected clients. Keep `recordRouting()` server-controlled rather than exposing it with `@callable()`.

## Step 6: Export and route the agent

The class must be exported from the Worker entry point:

```ts
import { routeAgentRequest } from "agents";
export { EdgewordAgent } from "./agents/edgeword";
```

Route Agent traffic after deriving the trusted client key and applying the existing chat rate limiter:

```ts
if (url.pathname.startsWith("/agents/")) {
	const rateLimit = await enforceRateLimit(
		env.CHAT_RATE_LIMITER,
		`agent:${actor}`,
	);
	if (rateLimit) return rateLimit;

	const agentResponse = await routeAgentRequest(request, env);
	if (agentResponse) return agentResponse;
}
```

This limits connection attempts. Later lessons add per-message and mutating-RPC quotas inside the Agent.

Agent URLs follow:

```text
/agents/{agent-class}/{instance-name}
```

For `EdgewordAgent` and the current conversation UUID:

```text
/agents/edgeword-agent/550e8400-e29b-41d4-a716-446655440000
```

Use the same validated conversation UUID as the Agent instance name. This preserves the current one-conversation-per-stateful-entity model.

## Step 7: Connect from React

```tsx
import { useAgent } from "agents/react";
import type { EdgewordState } from "../src/agents/types";

function AgentStatus({ conversationId }: { conversationId: string }) {
	const agent = useAgent<EdgewordState>({
		agent: "EdgewordAgent",
		name: conversationId,
	});

	const selectMode = (mode: EdgewordState["mode"]) => {
		void agent.call<EdgewordState>("setMode", [mode]);
	};

	return (
		<div>
			<p>Mode: {agent.state?.mode ?? "stream"}</p>
			<p>Turns: {agent.state?.turnCount ?? 0}</p>
			<button onClick={() => selectMode("stream")}>
				Streaming
			</button>
			<button onClick={() => selectMode("protected")}>
				Protected
			</button>
		</div>
	);
}
```

`useAgent` automatically converts the class name to the route’s kebab-case format and reconnects WebSockets with backoff.

In Edgeword, place this information in the existing Learning Trace as an `Agent sidecar` section. Keep the HTTP mode selection functional even if Agent synchronization is unavailable.

## Step 8: Test

Cover:

- Initial mode is streaming
- Mode changes persist
- Invalid modes are rejected
- Server routing metadata increments `turnCount`
- Invalid client state is rejected
- Two conversation UUIDs have isolated Agent state
- Reconnection restores the latest state

Run:

```bash
npm run typecheck
npm test -- --run
npm run build
```

## Checkpoint

- [ ] I can explain the difference between Worker, Durable Object, and Agent.
- [ ] The agent class is exported and bound.
- [ ] The existing HTTP chat still works while the Agent is introduced.
- [ ] Mode and routing metadata persist after refresh.
- [ ] Two agent names have isolated state.
- [ ] Callable methods work over RPC.
- [ ] TC39 decorators are configured without `experimentalDecorators`.

References:

- [Add Agents to an existing project](https://developers.cloudflare.com/agents/getting-started/add-to-existing-project/)
- [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/)

Continue to [Lesson 13](../lesson-13-realtime-state-rpc-agent/README.md).
