# Cloudflare AI and Agents Learning Path

This curriculum starts with one Workers AI application, then extends the same architecture into stateful, real-time, scheduled, tool-using Cloudflare Agents.

## How to use the lessons

1. Complete lessons in order.
2. Read the lesson before editing code.
3. Make only the changes described by the current lesson.
4. Run every checkpoint.
5. Do not continue while a checkpoint is failing.

Workers AI calls use a remote Cloudflare resource, including during local development. They may consume your account allocation or incur charges. Prefer deterministic validation and route tests when model inference is not what you are testing.

## Curriculum

| Lesson | Build | Main concepts | Status |
| --- | --- | --- | --- |
| [01 — Streaming chat](lesson-01-streaming-chat/README.md) | The application currently in the project root | Bindings, routing, validation, SSE, static assets | Built |
| [02 — Multi-turn chat](lesson-02-multi-turn-chat/README.md) | A conversation that remembers earlier messages in the browser | Message roles, context, client state | Guide ready |
| [03 — Testing](lesson-03-testing/README.md) | Deterministic tests that do not spend AI usage | Unit boundaries, route tests, mocks | Guide ready |
| [04 — Durable memory](lesson-04-durable-memory/README.md) | Conversations that survive refresh and restart | Durable Objects, RPC, SQLite storage | Guide ready |
| [05 — Tool calling](lesson-05-tool-calling/README.md) | A model that can call a safe calculator tool | Schemas, validation, tool execution | Guide ready |
| [06 — AI Gateway and production](lesson-06-production/README.md) | Gateway analytics, correlated inference, and a deployable application | AI Gateway, logs, traces, limits, deployment | Guide ready |
| [07 — Gateway authentication and privacy](lesson-07-gateway-auth-privacy/README.md) | An authenticated gateway with an explicit log-retention policy | Authentication, payload privacy, metadata | Guide ready |
| [08 — Gateway rate and spend limits](lesson-08-gateway-rate-spend-limits/README.md) | Traffic and budget controls for model inference | Rate limits, spend limits, `429` handling | Guide ready |
| [09 — Gateway Guardrails and DLP](lesson-09-gateway-guardrails-dlp/README.md) | Streaming-safe prompt protection and a high-protection route design | Guardrails, DLP, streaming trade-offs | Guide ready |
| [10 — Clef decision routing](lesson-10-clef-decision-routing/README.md) | Typed request classification before open-weight Auto Router selection | Clef-flash, candidate pools, confidence, telemetry | Built |
| [11 — React chat interface](lesson-11-react-chat-ui/README.md) | A polished, maintainable chat application | React, Vite, responsive UI, Markdown, SSE | Built |
| [12 — Agents foundations](lesson-12-agents-foundations/README.md) | Add an Edgeword Agent shell beside the current chat routes | Agent identity, routing, state, RPC, React | Guide ready |
| [13 — Real-time state and RPC](lesson-13-realtime-state-rpc-agent/README.md) | Synchronize Edgeword mode and learning-trace telemetry | State sync, SQLite audit, readonly clients, conflicts | Guide ready |
| [14 — AI chat Agent](lesson-14-ai-chat-agent/README.md) | Add a separate resumable Agent Chat mode | AIChatAgent, Clef, Auto Router, tools, protected coexistence | Guide ready |
| [15 — Scheduled reliable Agent](lesson-15-scheduled-reliable-agent/README.md) | Add protected conversation follow-ups and summaries | Schedules, queues, retries, idempotency | Guide ready |
| [16 — Workflow approval Agent](lesson-16-workflow-approval-agent/README.md) | Add durable, approved Edgeword research reports | AgentWorkflow, progress, approval, protected synthesis | Guide ready |
| [17 — MCP Agent](lesson-17-mcp-agent/README.md) | Add authenticated MCP versions of Edgeword tools | MCP v2, OAuth, allowlists, tool security | Guide ready |
| [18 — Production Agents](lesson-18-agent-production/README.md) | Secure and observe the additive Edgeword Agent architecture | Access, quotas, diagnostics, schema evolution, recovery | Guide ready |
| [19 — Vectorize RAG Agent](lesson-19-vectorize-rag-agent/README.md) | Add custom, tenant-filtered retrieval for Agent notes | Vectorize, embeddings, R2/D1, citations | Guide ready |
| [20 — AI Search Agent](lesson-20-ai-search-agent/README.md) | Add managed search over the Edgeword lesson corpus | AI Search, R2 ingestion, hybrid retrieval, Agent tools | Guide ready |
| [21 — Sandbox code Agent](lesson-21-sandbox-code-agent/README.md) | Add approved isolated code execution to Agent mode | Sandbox SDK 1.0, Containers, isolation, quotas | Guide ready |
| [22 — Agent Workspace capstone](lesson-22-agent-capstone/README.md) | Combine retrieval, MCP, Sandbox, and Workflows safely | Capability routing, approvals, telemetry, failure isolation | Guide ready |

## Agents enhancement track

Lessons 12–22 are cumulative, optional enhancements—not a replacement or migration of the current chat:

```text
Lesson 11: Working Edgeword React + Worker application
    ├── Current chat remains unchanged
    │     ├── /chat/stream
    │     ├── /chat/protected
    │     └── Conversation Durable Object
    │
    └── Optional Agents SDK capabilities
          ├── Lesson 12: EdgewordAgent sidecar
          ├── Lesson 13: Agent state/RPC learning panel
          ├── Lesson 14: Separate Agent Chat mode
          ├── Lesson 15: Agent schedules/queues/retries
          ├── Lesson 16: Research Workflows and approval
          ├── Lesson 17: Authenticated MCP tools
          ├── Lesson 18: Agent security and observability
          ├── Lesson 19: Custom RAG with Vectorize
          ├── Lesson 20: Managed RAG with AI Search
          ├── Lesson 21: Approved Sandbox execution
          └── Lesson 22: Combined Agent Workspace
```

The original chat remains available throughout and after every Agents lesson. Agent features use separate bindings, routes, UI controls, and storage. They must preserve Clef, Auto Router, the open-weight pools, calculator validation, streaming/protected Gateway separation, Guardrails/DLP, telemetry, Access, rate limits, spend limits, and bounded storage.

## Project commands

```bash
npm run dev
npm run cf-typegen
npx tsc --noEmit
npm test -- --run
npx wrangler deploy --dry-run
```

Run `npm run cf-typegen` after changing bindings in `wrangler.jsonc`.

## Definition of done

Every lesson ends with:

- A behavior you can demonstrate
- A TypeScript check
- Relevant automated or manual tests
- A short explanation you can give in your own words

## Current starting point

The root application is the completed Lesson 1. Begin by reviewing its lesson notes, then continue with Lesson 2.
