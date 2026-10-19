# Lesson 10: Clef Decision Routing with Auto Router

## Goal

Use Clef-flash to classify each request, then let AI Gateway Auto Router choose the final model from a route-specific open-weight pool.

```text
Prompt
  ↓
Clef-flash: simple | complex | tool
  ↓
Choose an allowed open-weight pool
  ↓
cloudflare/auto selects the final model
```

Clef does not select Streaming or Protected mode. Protection remains an explicit user and application policy.

## What you will learn

By the end of this lesson, you will be able to explain and implement:

1. The difference between Clef, Auto Router, and Dynamic Routing
2. Why Auto Router needs an explicit candidate pool in this project
3. How Clef returns typed choices, probabilities, and confidence
4. How to validate a model-produced routing decision
5. How to select different open-weight pools for different workloads
6. How session affinity keeps tool-call turns on one model
7. Why tools should be sent only when a route requires them
8. How Streaming and Protected modes use the same decision safely
9. How to expose routing telemetry without exposing prompts or responses
10. How to evaluate routing quality rather than trusting a few examples

## Prerequisites

Complete Lessons 1–9 first. The application should already have:

- A Workers AI binding
- `hello-ai-streaming` and `hello-ai-protected` gateways
- Durable Object conversation history
- Native calculator tool calling
- Streaming and non-streaming routes
- Request IDs and Gateway metadata

Run the baseline checks:

```bash
npm run typecheck
npm test -- --run
npm run build
```

## Three different routing systems

### Clef-flash

Clef is a decision model. It does not generate the answer shown to the user. It receives application state and typed questions, then returns structured decisions.

```text
Input:  prompt + recent messages + decision criteria
Output: choice + probability weights + confidence
```

The application owns the allowed answers: `simple`, `complex`, and `tool`.

### Auto Router

Auto Router is the final model selector:

```ts
const MODEL = "cloudflare/auto";
```

It considers only the models supplied through `cf-aig-allowed-models`, then selects an eligible model based on compatibility, health, expected quality, and cost.

### Dynamic Routing

Dynamic Routing is a versioned AI Gateway rule graph containing explicit conditions, budgets, limits, model nodes, and fallbacks. This lab does not use Dynamic Routing.

```text
This lesson: Clef → candidate pool → Auto Router
Not used:    dynamic/my-route
```

Clef provides learned application classification. Auto Router provides managed model selection inside the chosen pool.

## Step 1: Define the pools

```ts
const SIMPLE_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/openai/gpt-oss-20b",
];

const COMPLEX_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/moonshotai/kimi-k2.7-code",
	"@cf/qwen/qwen3.8-27b",
	"@cf/zai-org/glm-5.2",
];

const TOOL_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/moonshotai/kimi-k2.7-code",
];
```

The tool pool contains models verified for function calling. Auto Router still decides between eligible models inside the selected pool.

### Why use separate pools?

Sending one large pool for every request reduces predictability:

- Simple questions may use an unnecessarily capable model.
- Models without function calling may be selected for tool requests.
- Cost and latency become harder to reason about.

The pools express application policy while leaving final selection to Auto Router.

### Why restrict the pool?

Auto Router’s managed default pool includes third-party models that require Unified Billing credits. This project restricts routing to open-weight Workers AI models, so it can use standard Workers AI billing.

Using only:

```text
cf-aig-allowed-providers: workers-ai
```

did not produce an eligible tool-capable candidate in end-to-end testing. An explicit `cf-aig-allowed-models` list was reliable and auditable.

### Select the pool

```ts
export function modelsForDecision(decision: RouteDecision): string[] {
	if (decision.route === "simple") return SIMPLE_MODELS;
	if (decision.route === "tool") return TOOL_MODELS;
	return COMPLEX_MODELS;
}
```

Do not accept candidate model IDs from browser request JSON. Model policy belongs to trusted Worker code.

## Step 2: Ask Clef one typed question

Use Clef-flash for the request hot path:

```ts
const response = await env.AI.run(
	"@cf/cloudflare/clef-flash",
	{
		model: "clef-flash",
		state: {
			prompt,
			recentMessages: messages.slice(-4),
		},
		questions: {
			route: {
				type: "choice",
				instructions:
					"Choose the minimum capability needed to answer the latest user request.",
				criteria: {
					simple:
						"Basic factual, explanatory, or conversational response.",
					complex:
						"Substantial technical analysis or multi-step reasoning.",
					tool: "Exact arithmetic addition requiring addNumbers.",
				},
			},
		},
	},
);
```

Clef returns a choice, probabilities, and confidence rather than generated prose.

The real implementation sends the Clef request through the same gateway mode selected by the user:

```ts
function decisionGatewayOptions(
	gatewayId: string,
	requestId: string,
): AiOptions {
	return {
		gateway: {
			id: gatewayId,
			skipCache: true,
			collectLog: true,
			metadata: {
				requestId,
				feature: "durable_chat",
				phase: "clef_decision",
			},
		},
	};
}
```

This creates a separate `clef_decision` entry in AI Gateway logs. It uses the same request ID as the subsequent Auto Router inference.

### Why use Clef-flash?

Cloudflare provides:

| Model | Size | Intended use |
| --- | ---: | --- |
| `@cf/cloudflare/clef` | 27B | Highest-precision decisions |
| `@cf/cloudflare/clef-flash` | 9B | Latency-sensitive request paths |

Routing runs for every user turn, so this lab uses Clef-flash.

### Why include only recent history?

The state includes the latest prompt and four recent messages:

```ts
state: {
	prompt,
	recentMessages: recentMessages.slice(-4),
}
```

This gives Clef enough context to classify follow-up questions while limiting input size, latency, and cost.

## Step 3: Validate the decision

Treat the inference response as untrusted runtime data:

```ts
type RouteDecision = {
	route: "simple" | "complex" | "tool";
	confidence: number;
	weights: {
		simple: number;
		complex: number;
		tool: number;
	};
};
```

`parseRouteDecision()` validates the choice and confidence. Invalid or low-confidence responses fall back to:

```ts
{
	route: "complex",
	confidence,
	weights,
}
```

The lab’s initial confidence threshold is `0.65`. Evaluate this value against representative prompts before treating it as a production threshold.

### Probability weights versus confidence

These values are related but not identical:

```json
{
	"choice": "simple",
	"confidence": 0.728,
	"probabilities": {
		"simple": 0.9006,
		"complex": 0.0858,
		"tool": 0.0136
	}
}
```

- `choice` is the winning option.
- `probabilities` show relative weight for every allowed option.
- `confidence` is Clef’s confidence in its final answer.

The UI shows all three weights rather than displaying only the winning choice.

### Fail safely

Malformed responses and confidence below `0.65` route to `complex`. A decision-model failure must not route to the cheapest or least capable path.

The parser never casts an unknown response directly to `RouteDecision`.

## Step 4: Give Auto Router the selected pool

Pass the selected models through:

```ts
extraHeaders: {
	"cf-aig-session-id": requestId,
	"cf-aig-turn-id": requestId,
	"cf-aig-allowed-models": allowedModels.join(","),
}
```

Session and turn affinity keep the model stable across tool selection and final response generation.

The complete Gateway options builder is:

```ts
export function aiGatewayOptions(
	gatewayId: string,
	requestId: string,
	phase: string,
	allowedModels: string[] = COMPLEX_MODELS,
): AiOptions {
	return {
		gateway: {
			id: gatewayId,
			skipCache: true,
			collectLog: true,
			metadata: {
				requestId,
				feature: "durable_chat",
				phase,
			},
		},
		extraHeaders: {
			"cf-aig-session-id": requestId,
			"cf-aig-turn-id": requestId,
			"cf-aig-allowed-models": allowedModels.join(","),
		},
	};
}
```

### Session affinity

A calculator turn may require:

```text
tool_selection → execute addNumbers → tool_response
```

Without affinity, Auto Router could select different models for the two inference calls. `cf-aig-session-id` and `cf-aig-turn-id` pin calls in one turn to the same model.

The lab uses `requestId` for both values because each browser request represents one user turn.

### Cache behavior

`skipCache: true` is deliberate. Conversation requests contain private, user-specific history. Do not enable caching without a privacy-safe cache-key design.

### Gateway metadata

Metadata contains only:

```text
requestId
feature
phase
```

Never put prompt text, answers, secrets, email addresses, or personal data in Gateway metadata.

## Step 5: Include tools only when requested

For `simple` and `complex`, call Auto Router without calculator tools.

For `tool`:

1. Include `CALCULATOR_TOOL`.
2. Validate the requested function name.
3. Parse arguments as unknown.
4. Run `addNumbers`.
5. Return a matching `tool_call_id`.
6. Ask the pinned model for the final answer.

This prevents ordinary questions from appearing agentic merely because a calculator schema was attached.

### Simple and complex flow

```ts
if (decision.route !== "tool") {
	return env.AI.run(
		"cloudflare/auto",
		{
			messages,
			stream: true,
		},
		aiGatewayOptions(
			gatewayId,
			requestId,
			`${decision.route}_response`,
			modelsForDecision(decision),
		),
	);
}
```

No calculator schema is attached.

### Tool flow

The first Auto Router call receives:

```ts
{
	messages,
	tools: [CALCULATOR_TOOL],
	tool_choice: "auto",
	parallel_tool_calls: false,
}
```

The Worker then verifies:

- No more than two tool calls
- `type === "function"`
- `function.name === "addNumbers"`
- Arguments are valid JSON
- Runtime values are finite numbers within the allowed range

The model never chooses arbitrary Worker functions. The server owns the tool allowlist and executes only the known implementation.

## Step 6: Preserve protection policy

The same Clef decision can feed either route:

```text
Streaming mode
  Clef → pool → Auto Router → SSE

Protected mode
  Clef → pool → Auto Router → Guardrails + DLP → JSON
```

Clef cannot switch the user from Protected to Streaming mode.

The mode is selected before Clef runs:

```text
/chat/stream     → hello-ai-streaming
/chat/protected  → hello-ai-protected
```

### Streaming gateway

- Request-only financial DLP
- No Guardrails
- SSE token delivery
- `Cache-Control: no-cache, no-transform`
- `Content-Encoding: identity`

### Protected gateway

- Prompt and response Guardrails
- Request and response financial DLP
- Full response buffered before delivery
- JSON response

AI Gateway Guardrails do not support streaming. Response-side DLP also needs the complete response. Clef must never be allowed to change the route from Protected to Streaming based on a probabilistic decision.

Clef still controls model capability inside either route.

## Step 7: Add routing telemetry

Responses include:

```text
X-Route-Decision
X-Route-Confidence
X-Route-Weights
X-Routed-Model
X-Request-ID
X-Telemetry-Log-Ids
```

Protected JSON also includes:

```json
{
	"decision": {
		"route": "simple",
		"confidence": 0.91,
		"weights": {
			"simple": 0.91,
			"complex": 0.07,
			"tool": 0.02
		}
	},
	"model": "@cf/..."
}
```

The browser badge shows the Clef decision, confidence, gateway mode, and final routed model. A sanitized telemetry endpoint resolves Gateway log IDs into phase, token, latency, cost, cache, Guardrails, and DLP data without returning prompts or responses.

### Candidate-pool tooltip

Responses also include:

```text
X-Candidate-Models
```

The protected JSON body includes:

```json
{
	"candidateModels": [
		"@cf/google/gemma-4-26b-a4b-it",
		"@cf/openai/gpt-oss-20b"
	]
}
```

Hovering or focusing the model name displays every candidate that Auto Router was allowed to choose from.

### Streaming model discovery

For a direct streamed response, the final model may not be known when HTTP headers are created. The browser reads the `model` field from SSE events and updates the model badge when the first model event arrives.

### Sanitized telemetry

Gateway log IDs are returned to the same-origin frontend. The frontend requests:

```text
GET /telemetry?gateway=protected&logs=<log IDs>
```

The Worker returns only:

- Phase
- Provider and model
- Status and success
- Input/output tokens
- Duration
- Estimated cost
- Cache state
- Guardrails result
- DLP action and profile IDs

Prompts and model responses are never returned by this endpoint.

### Right-side learning inspector

The React interface visualizes:

1. Clef probability weights
2. Winning choice and confidence
3. Auto Router’s selected model
4. Gateway calls, tokens, duration, and estimated cost
5. Guardrails and DLP results
6. Per-phase execution trace

## Step 8: Evaluate routing quality

Create a test dataset with labeled prompts:

```text
What is Workers AI?                       → simple
Compare three distributed lock designs.  → complex
What is 123.45 plus 67.89?                → tool
```

Track:

- Expected route
- Clef route
- Confidence
- Auto Router model
- Latency
- Cost
- Answer quality

Do not tune the criteria or confidence threshold using only one or two examples.

The lab’s verified examples produced:

| Prompt | Clef route | Confidence | Auto Router model |
| --- | --- | ---: | --- |
| “What is Cloudflare Workers?” | simple | 87.79% | Gemma 4 |
| Distributed-lock design comparison | complex | 91.51% | GLM 5.2 |
| Exact addition | tool | 97.16% | Kimi K2.7 Code |

These examples prove the pipeline works; they do not prove that the routing policy is accurate for production traffic.

### Evaluation dataset

Store at least dozens of representative, labeled prompts. Include:

- Short factual questions
- Follow-up questions needing conversation context
- Long technical comparisons
- Exact arithmetic
- Arithmetic-looking prompts that do not require calculation
- Ambiguous requests
- Adversarial attempts to force a specific route

Measure a confusion matrix for `simple`, `complex`, and `tool`.

### Cost model

One normal chat turn currently uses:

```text
Clef decision + Auto Router response = 2 inference calls
```

A tool turn uses:

```text
Clef decision + tool selection + final response = 3 inference calls
```

The right inspector reports Gateway cost and token usage for each phase. Compare the added decision cost with savings from better model selection.

## Step 9: Verify

```bash
npm run typecheck
npm test -- --run
npm run build
npx wrangler deploy --dry-run
```

Test the streaming route:

```bash
curl -N -X POST \
	http://localhost:5173/conversations/11111111-1111-4111-8111-111111111111/chat/stream \
	-H 'Content-Type: application/json' \
	-d '{"prompt":"What is Workers AI? Answer in one sentence."}'
```

Test the protected route:

```bash
curl -X POST \
	http://localhost:5173/conversations/22222222-2222-4222-8222-222222222222/chat/protected \
	-H 'Content-Type: application/json' \
	-d '{"prompt":"Compare two distributed locking approaches."}'
```

Inspect these response headers:

```text
X-Request-ID
X-Route-Decision
X-Route-Confidence
X-Route-Weights
X-Candidate-Models
X-Routed-Model
X-Telemetry-Log-Ids
```

After a synthetic request, inspect AI Gateway logs using the shared request ID. You should see:

```text
clef_decision
simple_response | complex_response | tool_selection
tool_response, when a calculator call occurs
```

## Troubleshooting

### `2021: Insufficient unified billing credits`

Auto Router’s managed default pool contains third-party models that use Unified Billing. Use an explicit Workers AI candidate list, or fund Unified Billing intentionally.

### `7003: This model does not support any requested provider`

The requested provider restriction produced no eligible model for the request format. Use explicit compatible model IDs and verify tool support.

### A basic request selects a large model

Check:

- Clef’s route and probability weights
- Conversation history sent in `state`
- Whether tools were attached unnecessarily
- The candidate pool for the selected route
- Auto Router’s routing reason in Gateway logs

Clef controls the pool; Auto Router still makes the final decision.

### The model badge initially shows `cloudflare/auto`

For streaming responses, the actual model is discovered from SSE events after the stream begins. The badge updates when the model field arrives.

### Telemetry is temporarily empty

AI Gateway logs may not be queryable immediately. The React client retries sanitized telemetry lookup three times with a short delay.

### A Clef response is malformed or uncertain

The parser falls back to the complex pool. Do not use a malformed decision to choose the simple pool.

## Explain it in your own words

Before completing the lesson, explain:

1. Why Clef is not the final answer model
2. Why Auto Router still has meaningful work after Clef
3. Why `cf-aig-allowed-models` is application policy
4. Why session affinity matters for tool calls
5. Why low confidence falls back to complex
6. Why Clef cannot select protection mode
7. Why costs include more than the final answer inference

## Checkpoint

- [ ] Clef returns a validated typed decision.
- [ ] Low confidence falls back to the complex pool.
- [ ] Auto Router remains the final model selector.
- [ ] Calculator tools are sent only for tool decisions.
- [ ] Protection mode cannot be downgraded by Clef.
- [ ] The selected route and model appear in the UI and Gateway logs.
- [ ] The UI shows candidate pools, probability weights, token usage, cost, and protection outcomes.
- [ ] I tested routing against a labeled dataset rather than isolated examples.

References:

- [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
- [Clef launch and API](https://developers.cloudflare.com/changelog/post/2026-10-01-clef-workers-ai/)
- [AI Gateway Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/)

Continue to [Lesson 11](../lesson-11-react-chat-ui/README.md).
