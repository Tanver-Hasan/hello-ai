# Lesson 19: Custom RAG with Vectorize

## Goal

Add an optional `searchEdgewordNotes` tool to Agent Chat using Cloudflare Vectorize and Workers AI embeddings. The current Streaming and Protected modes remain unchanged.

## Use case

Vectorize is appropriate when Edgeword needs direct control over:

- Chunking
- Embedding model
- Vector IDs
- Metadata filters
- Similarity thresholds
- Retrieval ranking
- Source storage

Use this lesson for user-owned notes or a deliberately custom retrieval pipeline. Lesson 20 uses AI Search when managed ingestion and retrieval are preferable.

## Additive architecture

```text
Current chat — unchanged

Optional EdgewordChatAgent
  → searchEdgewordNotes tool
      → Workers AI embedding model
      → Vectorize similarity query
      → R2/D1 source records
  → existing Clef + Auto Router answer generation
```

Vectorize stores vectors and metadata. Keep authoritative document text in R2 or D1 rather than assuming the vector index is the source of truth.

## Cloudflare infrastructure used

- Cloudflare Agents SDK tool execution
- Vectorize
- Workers AI text embeddings
- R2 or D1 for source chunks
- Existing AI Gateway answer generation
- Access identity and Agent instance authorization

## Step 1: Design tenant boundaries

For private notes, every vector must include trusted ownership metadata:

```ts
type NoteMetadata = {
	owner: string;
	conversationId: string;
	sourceKey: string;
	lesson?: number;
};
```

Derive `owner` from Access identity. Never accept it from tool arguments.

## Step 2: Select and inspect an embedding model

The model dimension must exactly match the index dimension. Retrieve the current schema before creating the index:

```bash
npx wrangler ai models schema @cf/baai/bge-base-en-v1.5
```

The current Cloudflare Vectorize tutorial uses 768 dimensions with this model:

```bash
npx wrangler vectorize create edgeword-notes \
	--dimensions=768 \
	--metric=cosine
```

Do not change embedding models without creating and rebuilding a compatible index.

## Step 3: Add the binding

```jsonc
"vectorize": [
	{
		"binding": "EDGEWORD_VECTORS",
		"index_name": "edgeword-notes"
	}
]
```

Regenerate types:

```bash
npm run cf-typegen
```

This binding is additional. Do not remove `AI`, `CONVERSATIONS`, Agent bindings, Rate Limiting, or Static Assets.

## Step 4: Build a deterministic ingestion pipeline

For each source:

1. Normalize text.
2. Split it into bounded chunks.
3. Assign stable IDs.
4. Store source text in R2 or D1.
5. Generate embeddings with Workers AI.
6. Upsert vectors with ownership metadata.

```ts
const embeddings = await env.AI.run(
	"@cf/baai/bge-base-en-v1.5",
	{ text: chunks.map((chunk) => chunk.text) },
);

await env.EDGEWORD_VECTORS.upsert(
	chunks.map((chunk, index) => ({
		id: chunk.id,
		values: embeddings.data[index],
		metadata: {
			owner,
			conversationId,
			sourceKey: chunk.sourceKey,
		},
	})),
);
```

Use a Workflow or Queue for bulk ingestion. Do not embed a large corpus during a browser request.

## Step 5: Query with mandatory filters

```ts
const queryEmbedding = await env.AI.run(
	"@cf/baai/bge-base-en-v1.5",
	{ text: [query] },
);

const result = await env.EDGEWORD_VECTORS.query(
	queryEmbedding.data[0],
	{
		topK: 5,
		returnMetadata: "all",
		filter: {
			owner: { $eq: verifiedOwner },
			conversationId: { $eq: agentConversationId },
		},
	},
);
```

Authorization filters are not optional. Do not query globally and filter results afterward.

## Step 6: Resolve source text

Vector matches return IDs, scores, and requested metadata. Fetch the corresponding text from R2 or D1 and verify ownership again.

Discard:

- Results below the evaluated similarity threshold
- Missing source records
- Records owned by another tenant
- Oversized chunks

## Step 7: Expose an Agent tool

```ts
const searchEdgewordNotes = tool({
	description: "Search the current user's approved Edgeword notes.",
	inputSchema: z.object({
		query: z.string().min(1).max(500),
	}),
	execute: async ({ query }) => {
		return searchAuthorizedNotes({
			query,
			owner: verifiedOwner,
			conversationId: this.name,
		});
	},
});
```

Return bounded citation objects rather than concatenating an unlimited number of chunks.

## Step 8: Preserve Edgeword generation controls

Retrieved text is untrusted context. The Agent must still:

- Run Clef
- Use the selected open-weight Auto Router pool
- Pass through the selected AI Gateway
- Respect `$5` Gateway budgets
- Apply protected mode when a fully inspected answer is required
- Display sources separately from model prose

## Step 9: Add learning telemetry

Display:

- Embedding model
- Index name
- Query duration
- Top-K
- Similarity scores
- Metadata filter
- Selected citations
- Embedding and answer-generation costs separately

Never expose another tenant’s metadata in telemetry.

## Step 10: Test

Test:

- Stable chunk IDs
- Index/model dimension compatibility
- Same-tenant retrieval
- Cross-tenant retrieval rejection
- Empty result behavior
- Similarity threshold
- Deleted source handling
- Re-ingestion and idempotent upsert
- Prompt injection inside retrieved documents
- Existing Streaming and Protected modes remain unchanged

## Checkpoint

- [ ] Vectorize is an optional Agent tool.
- [ ] Source text remains in R2 or D1.
- [ ] Every query has a trusted ownership filter.
- [ ] Retrieval and generation costs are separate.
- [ ] Answers include verifiable citations.
- [ ] Current chat routes and storage are unchanged.

References:

- [Vectorize and Workers AI](https://developers.cloudflare.com/vectorize/get-started/embeddings/)
- [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/)
- [Vectorize best practices](https://developers.cloudflare.com/vectorize/best-practices/)

Continue to [Lesson 20](../lesson-20-ai-search-agent/README.md).
