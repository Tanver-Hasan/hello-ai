# Lesson 14: Resumable AI Chat Agent

## Use case

Add a separate **Agent Chat** mode powered by `AIChatAgent`. It demonstrates automatic persistence, resumable streams, and Agent tools while the existing Streaming and Protected modes remain unchanged and available.

## Additive route design

```text
Streaming mode → existing /chat/stream
Protected mode → existing /chat/protected
Agent mode     → /agents/edgeword-chat-agent/:conversationId
```

Agent Chat uses a separate Durable Object class and message store. It must not read, rewrite, migrate, or delete the current `Conversation` storage.

## What Agent Chat reuses

| Existing capability | Agents implementation |
| --- | --- |
| Conversation UUID | Optional Agent instance name |
| Existing history | Remains in `Conversation`; Agent has separate history |
| Existing streaming SSE | Remains unchanged |
| Agent streaming | Separate resumable Agent stream |
| Clef decision | Run before answer generation |
| Auto Router pools | Preserve `cf-aig-allowed-models` |
| Session affinity | Use Agent name and request ID |
| Calculator | AI SDK server tool |
| Learning trace | Agent state/data parts + Gateway logs |
| Protected mode | Keep `/chat/protected` non-streaming |
| Spend/rate limits | Keep existing Gateway and Worker controls |

## Cloudflare framework and infrastructure used

- `AIChatAgent` and `useAgentChat`
- Agents SDK routing and Agent Durable Objects
- SQLite message persistence and resumable streams
- Workers AI binding
- AI Gateway streaming/protected gateways
- Clef-flash and Auto Router
- React WebSocket client

## Step 1: Install the chat stack

Retrieve compatible stable versions before implementation:

```bash
npm install @cloudflare/ai-chat agents ai @ai-sdk/react workers-ai-provider
```

`AIChatAgent` extends the lower-level `Agent` class.

## Step 2: Create the server agent

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class EdgewordChatAgent extends AIChatAgent<Env> {
	async onChatMessage() {
		const workersai = createWorkersAI({
			binding: this.env.AI,
		});

		const result = streamText({
			model: workersai("@cf/zai-org/glm-4.7-flash"),
			system: "You are the Edgeword learning assistant.",
			messages: await convertToModelMessages(this.messages),
		});

		return result.toUIMessageStreamResponse();
	}
}
```

The SDK automatically persists Agent Chat messages in its own SQLite-backed Agent instance and synchronizes them with connected clients. This first smoke test uses a fixed model; Step 6 adds the current Clef and Auto Router behavior to the optional mode.

## Step 3: Bind and route

Add the `EdgewordChatAgent` Durable Object binding and SQLite class declaration, export the class, and let `routeAgentRequest()` handle `/agents/*`. Keep `CONVERSATIONS`, `Conversation`, and every `/conversations/*` route permanently.

Run:

```bash
npm run cf-typegen
```

## Step 4: Connect React

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

const agent = useAgent({
	agent: "EdgewordChatAgent",
	name: `agent-${conversationId}`,
});

const {
	messages,
	sendMessage,
	clearHistory,
	stop,
	status,
	isServerStreaming,
	isRecovering,
} = useAgentChat({ agent });
```

Use a separately namespaced Agent instance name such as `agent-${conversationId}`, and authorize ownership with Cloudflare Access identity. This avoids accidental storage coupling. A UUID is routing information, not authorization.

## Step 5: Understand resumable streaming

By default:

1. Stream chunks are buffered in SQLite.
2. Server generation continues after a browser disconnect.
3. A reconnect receives buffered chunks and resumes live streaming.
4. Calling `stop()` explicitly cancels the server turn.

Set:

```ts
useAgentChat({
	agent,
	cancelOnClientAbort: true,
});
```

only when browser aborts should also cancel server work and model cost.

## Step 6: Add Clef and Auto Router to Agent mode

Extract these existing functions into shared modules so both the core chat and Agent mode call the same implementation:

```text
decideRoute()
parseRouteDecision()
modelsForDecision()
aiGatewayOptions()
sanitizeGatewayLog()
```

Inside `onChatMessage()`:

1. Read the latest user message from `this.messages`.
2. Run Clef-flash through the selected Gateway.
3. Apply the `0.65` confidence fallback.
4. Choose the simple, complex, or tool pool.
5. Call `cloudflare/auto` with the current session, turn, and allowed-model headers.
6. Publish decision weights, candidate pool, routed model, usage, and cost to the learning trace.

Verify the installed `workers-ai-provider` option schema before mapping Gateway options. Do not silently drop:

```text
cf-aig-session-id
cf-aig-turn-id
cf-aig-allowed-models
skipCache
collectLog
request metadata
```

If the provider cannot preserve those options, keep the existing `env.AI.run()` orchestration inside the Agent rather than weakening routing controls.

## Step 7: Add the existing calculator as a server tool

Use the AI SDK unified tool pattern:

```ts
import { tool } from "ai";
import { z } from "zod";

const addNumbers = tool({
	description: "Add two finite numbers",
	inputSchema: z.object({
		a: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
		b: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
	}),
	execute: async ({ a, b }) => ({ result: a + b }),
});
```

Reuse the validation contract from Lesson 5. The server owns tool definitions and validates arguments.

## Step 8: Bound persistence and context separately

Persistence and model context are separate:

- `maxPersistedMessages` controls SQLite history.
- `pruneMessages()` controls what the model sees.
- Automatic compaction protects the SQLite row-size limit.

Do not send every historical tool result to the model indefinitely.

Configure a separate bounded Agent history. The existing 40-message `Conversation` policy remains unchanged.

## Step 9: Preserve protected mode

`AIChatAgent` resumable streaming is appropriate for optional Agent mode. It does not remove the platform constraint that response Guardrails and response DLP require a complete response.

Keep:

```text
Streaming → existing streaming route
Protected → existing non-streaming protected route
Agent     → EdgewordChatAgent
```

The modes intentionally coexist.

## Step 10: Add approval for side effects

Read-only tools may run automatically. Tools that send email, spend money, modify records, or deploy code should request user approval.

Display the proposed action and validated arguments before submitting the approval result.

## Step 11: Test

Test:

- Message persistence after refresh
- Stream resume after disconnect
- Explicit stop behavior
- Tool argument validation
- Approval and rejection
- Message pruning
- Concurrent tabs
- Agent instance isolation
- Clef probabilities and selected pool match the current implementation
- Auto Router session affinity survives tool continuation
- Protected mode remains buffered and protected
- Gateway spend-limit `429` still reaches the UI

## Checkpoint

- [ ] Messages persist automatically.
- [ ] Streams resume after reconnect.
- [ ] Explicit stop cancels generation.
- [ ] Tools are server-owned and validated.
- [ ] Side effects require approval.
- [ ] Storage and LLM context have separate bounds.
- [ ] Clef, Auto Router, Gateway metadata, and spend controls are preserved.
- [ ] Protected mode has not been accidentally converted to streaming.
- [ ] Core Streaming and Protected modes behave exactly as before.
- [ ] Agent Chat has a separate route, binding, and message store.

References:

- [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/)
- [Autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/)

Continue to [Lesson 15](../lesson-15-scheduled-reliable-agent/README.md).
