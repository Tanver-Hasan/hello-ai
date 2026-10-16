# Lesson 22: Edgeword Agent Workspace Capstone

## Goal

Combine the optional Agent enhancements into one controlled workspace while preserving the original chat as a simple, reliable baseline.

## Final architecture

```text
Cloudflare Access
  → Worker Rate Limiting
  → Edgeword Worker + React
      │
      ├── Core chat — unchanged
      │     ├── Streaming Gateway
      │     ├── Protected Gateway
      │     └── Conversation Durable Object
      │
      └── Optional Agent Workspace
            ├── EdgewordChatAgent
            ├── Clef typed decisions
            ├── Auto Router open-weight models
            ├── AI Search shared lesson corpus
            ├── Vectorize private/custom notes
            ├── MCP tools
            ├── Sandbox code interpreter
            ├── schedules and queues
            └── AgentWorkflow research reports
```

## Step 1: Define product boundaries

The UI has three independent modes:

```text
Streaming
Protected
Agent Workspace
```

Agent Workspace failure must not prevent Streaming or Protected mode from functioning.

## Step 2: Extend Clef decisions

Keep the existing route question:

```text
simple | complex | tool
```

Add separate typed questions instead of overloading it:

```text
knowledge:
  none | lessons | private_notes

execution:
  none | sandbox

durability:
  immediate | workflow
```

Clef supports multiple typed questions in one request. Each answer needs independent validation and conservative fallback.

Example policy:

| Decision | Action |
| --- | --- |
| `knowledge=lessons` | AI Search |
| `knowledge=private_notes` | Vectorize with tenant filter |
| `execution=sandbox` | Approval, then Sandbox |
| `durability=workflow` | AgentWorkflow |
| Invalid/uncertain | No tool; ask for clarification |

## Step 3: Build a capability registry

```ts
type Capability =
	| "ai_search"
	| "vectorize"
	| "mcp"
	| "sandbox"
	| "workflow";

type CapabilityPolicy = {
	enabled: boolean;
	requiresApproval: boolean;
	allowedRoles: string[];
	maxCallsPerTurn: number;
};
```

The registry is trusted server configuration. The model cannot enable a disabled capability.

## Step 4: Choose one retrieval source

Do not query every source automatically.

```text
Official shared lessons → AI Search
Private/custom notes    → Vectorize
No knowledge needed     → neither
```

Return citations with source type so the UI can distinguish managed and custom retrieval.

## Step 5: Gate Sandbox execution

Sandbox requires:

1. Verified user
2. Allowed role
3. Clef execution decision
4. Validated execution plan
5. Explicit approval
6. Available Sandbox quota
7. Timeout/output/file/egress limits

The model receives the bounded result, not direct container access.

## Step 6: Escalate long work to Workflows

Use immediate Agent tools for short retrieval and calculations. Use `AgentWorkflow` for:

- Multi-source research
- Long data analysis
- Approval waits
- Retriable ingestion
- Reports that survive disconnects

Report progress through Agent state without putting large intermediate results in synchronized state.

## Step 7: Preserve Gateway policy

All final model responses still use:

- Clef classification
- Explicit open-weight candidate pools
- Auto Router session affinity
- Streaming or protected Gateway policy
- `$5` per-Gateway fixed 30-day budget
- Sanitized request correlation

Sandbox, Vectorize, AI Search, R2, Containers, and Workflows have separate costs. Add independent alerts and quotas.

## Step 8: Extend the learning trace

Show an ordered execution graph:

```text
Clef
  → AI Search: 4 chunks
  → MCP: readLesson
  → approval
  → Sandbox: Python, 1.4s
  → Auto Router: Nemotron
  → Protected Gateway
```

For each node show:

- Product
- Input/output size
- Duration
- Cost when available
- Policy decision
- Retry count
- Citation/result identifier

Never show secrets, full prompts, raw tokens, or cross-tenant metadata.

## Step 9: Design failure behavior

| Failure | Behavior |
| --- | --- |
| AI Search unavailable | Explain retrieval unavailable; do not invent citations |
| Vectorize returns no match | Continue without private context |
| MCP unavailable | Use native calculator when applicable |
| Sandbox quota reached | Return bounded error; do not run code elsewhere |
| Workflow delayed | Keep progress and allow later resume |
| Agent unavailable | Core Streaming and Protected modes remain usable |
| Gateway budget exhausted | Return stable `429` |

## Step 10: End-to-end tests

Test:

- Core chat regression
- Agent mode isolation
- AI Search citations
- Vectorize tenant filters
- Retrieval prompt injection
- MCP OAuth and allowlist
- Sandbox breakout attempts
- Sandbox quota/cost exhaustion
- Workflow resume and approval
- Gateway spend exhaustion
- Access identity expiration
- Authorized deletion of Agent, Sandbox, and source data

## Final checkpoint

- [ ] Current chat remains unchanged.
- [ ] Agent Workspace is optional and independently deployable.
- [ ] AI Search and Vectorize have distinct responsibilities.
- [ ] Sandbox access is approved and bounded.
- [ ] Long work uses Workflows.
- [ ] Final generation keeps existing Gateway policies.
- [ ] Every product has cost, quota, deletion, and observability plans.
- [ ] Failure in an enhancement degrades safely to the core application.

References:

- [Cloudflare Agents](https://developers.cloudflare.com/agents/)
- [AI Search](https://developers.cloudflare.com/ai-search/)
- [Vectorize](https://developers.cloudflare.com/vectorize/)
- [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
