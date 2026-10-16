# Lesson 20: Managed RAG with AI Search

## Goal

Add an optional Agent tool that searches the Edgeword lesson corpus through Cloudflare AI Search. AI Search manages ingestion, chunking, indexing, and retrieval; the current chat remains unchanged.

## AI Search versus Vectorize

| Requirement | Choose |
| --- | --- |
| Managed document ingestion and synchronization | AI Search |
| Managed hybrid retrieval and reranking | AI Search |
| Direct vector/index control | Vectorize |
| Custom embedding and chunk pipeline | Vectorize |
| Per-user experimental notes | Vectorize |
| Shared maintained lesson corpus | AI Search |

Do not index the same corpus in both products without an explicit experiment and deletion plan.

## Additive architecture

```text
R2 lesson documents
  → AI Search managed indexing

Optional EdgewordChatAgent
  → searchLessons tool
      → AI Search binding
  → existing Clef + Auto Router synthesis

Current Streaming and Protected modes — unchanged
```

## Cloudflare infrastructure used

- Cloudflare AI Search
- R2 data source
- Agents SDK tool
- Workers binding without API tokens
- Existing Workers AI and AI Gateway generation
- Current React learning trace

## Step 1: Prepare a clean corpus

Export Lessons 1–22 as stable documents with:

- Lesson number
- Title
- Canonical source path
- Last-updated time
- Section headings
- Plain Markdown content

Exclude secrets, generated build output, `.dev.vars`, local chat history, and Gateway logs.

## Step 2: Create the AI Search instance

Create an instance in the Cloudflare dashboard and connect its source to the lesson corpus in R2.

Configure:

- Chunk size
- Retrieval type
- Embedding model
- Reranker
- Query rewriting
- Synchronization schedule

Record these choices in the lesson because they affect answer quality and cost.

## Step 3: Add an instance binding

```jsonc
"ai_search": [
	{
		"binding": "EDGEWORD_SEARCH",
		"instance_name": "edgeword-lessons",
		"remote": true
	}
]
```

The binding is available as:

```ts
env.EDGEWORD_SEARCH
```

Run:

```bash
npm run cf-typegen
```

## Step 4: Search without generating

Start with retrieval-only search:

```ts
const results = await env.EDGEWORD_SEARCH.search({
	messages: [
		{
			role: "user",
			content: query,
		},
	],
});
```

Retrieval-only mode lets Edgeword retain its existing Clef, Auto Router, Gateway, model-pool, spend-limit, and telemetry behavior for final generation.

## Step 5: Expose an Agent tool

```ts
const searchLessons = tool({
	description:
		"Search the official Edgeword learning-path lessons and return sources.",
	inputSchema: z.object({
		query: z.string().min(1).max(500),
	}),
	execute: ({ query }) =>
		env.EDGEWORD_SEARCH.search({
			messages: [{ role: "user", content: query }],
		}),
});
```

Cloudflare’s Agents SDK can access AI Search directly through the Workers binding. No account API token belongs in the Agent or browser.

## Step 6: Ground the final answer

Pass a bounded set of retrieved chunks to the existing answer pipeline:

```text
AI Search retrieval
  → validate and bound chunks
  → Clef decision
  → Auto Router candidate pool
  → selected Gateway
  → answer with citations
```

Treat indexed text as untrusted input. Retrieved instructions cannot override the system prompt, tool policy, or authorization policy.

## Step 7: Decide whether to use `chatCompletions()`

AI Search can generate an answer with `chatCompletions()`, including streaming. For this lab, begin with `search()` so the existing Gateway controls remain visible and consistent.

Use AI Search generation only after verifying:

- Model selection
- AI Gateway routing
- Spend accounting
- Guardrails and DLP
- Citation format
- Learning Trace telemetry

## Step 8: Show retrieval telemetry

Add a separate retrieval section:

- AI Search instance
- Retrieval mode
- Query rewrite state
- Vector score
- Keyword/BM25 score
- Reranking score
- Source key
- Chunk count

Do not merge retrieval scores with Clef probability weights; they represent different decisions.

## Step 9: Test

Test:

- Exact lesson lookup
- Semantic question
- Keyword-heavy question
- Query rewriting enabled/disabled
- Stale source refresh
- Deleted R2 object
- Citation accuracy
- Prompt injection inside indexed Markdown
- Empty retrieval
- Existing core chat regression

## Checkpoint

- [ ] AI Search manages the shared lesson corpus.
- [ ] Agent Chat calls it through a binding.
- [ ] Retrieval-only mode preserves current generation controls.
- [ ] Answers cite indexed sources.
- [ ] Retrieval telemetry is distinct from model-routing telemetry.
- [ ] Streaming and Protected modes remain unchanged.

References:

- [AI Search Workers binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/)
- [AI Search with Agents SDK](https://developers.cloudflare.com/ai-search/agent-sdks/agents-sdk/)
- [AI Search getting started](https://developers.cloudflare.com/ai-search/get-started/)

Continue to [Lesson 21](../lesson-21-sandbox-code-agent/README.md).
