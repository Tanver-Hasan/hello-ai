# Lesson 1: Streaming Chat

**Status:** Completed

## Goal

Build a Worker that accepts a prompt, sends it to Workers AI, streams the answer as server-sent events, and provides a small browser chat interface.

Complete each step in order. Run its checkpoint before moving to the next one.

## Step 1: Run the Hello World starter

Install dependencies:

```bash
npm install
```

Start Wrangler:

```bash
npm run dev
```

Open the URL printed by Wrangler, normally `http://localhost:8787`.

At this point, `src/index.ts` returns a plain Hello World response. The exported `fetch()` function is the HTTP entry point for the Worker.

### Checkpoint

- The development server starts.
- The browser displays the starter response.
- You can identify `request`, `env`, and `ctx` in the handler.

Stop Wrangler with `Ctrl+C`.

## Step 2: Add the Workers AI binding

Add this top-level property to `wrangler.jsonc`:

```jsonc
"ai": {
	"binding": "AI"
}
```

Make sure neighboring top-level properties are separated with commas.

The binding name becomes a property on the Worker environment:

```ts
env.AI
```

Generate types from the Wrangler configuration:

```bash
npm run cf-typegen
```

Near the beginning of `worker-configuration.d.ts`, confirm that the generated environment contains:

```ts
interface __BaseEnv_Env {
	AI: Ai;
}
```

Use the generated global `Env` type rather than maintaining a duplicate interface by hand.

### Checkpoint

```bash
npx tsc --noEmit
```

finishes without errors.

## Step 3: Make the first model request

Add the model name near the top of `src/index.ts`:

```ts
const MODEL = "@cf/google/gemma-4-26b-a4b-it";
```

Replace the Hello World response with:

```ts
const response = await env.AI.run(MODEL, {
	messages: [
		{ role: "system", content: "You are a helpful assistant." },
		{
			role: "user",
			content: "What is the origin of the phrase Hello, World?",
		},
	],
	chat_template_kwargs: {
		enable_thinking: false,
	},
});

return Response.json(response);
```

The messages have different jobs:

- `system` defines application-level model behavior.
- `user` contains the question.

Start the Worker:

```bash
npm run dev
```

Workers AI bindings access a remote resource even during local development. The request may consume your account allocation or incur charges.

### Checkpoint

- The browser receives a JSON model response.
- The response has an `application/json` content type.
- You can explain why no AI API key appears in the source.

## Step 4: Create a dynamic `POST /chat` endpoint

Parse the URL at the start of `fetch()`:

```ts
const url = new URL(request.url);
```

Allow the chat routes and reject unknown paths:

```ts
if (url.pathname !== "/chat" && url.pathname !== "/chat/stream") {
	return Response.json({ error: "Not found" }, { status: 404 });
}
```

Require `POST`:

```ts
if (request.method !== "POST") {
	return Response.json(
		{ error: "Method not allowed" },
		{
			status: 405,
			headers: { Allow: "POST" },
		},
	);
}
```

Parse the JSON body as untrusted data:

```ts
const body: unknown = await request.json().catch(() => null);
const prompt =
	typeof body === "object" &&
	body !== null &&
	"prompt" in body &&
	typeof body.prompt === "string"
		? body.prompt.trim()
		: "";
```

Reject an empty prompt:

```ts
if (!prompt) {
	return Response.json(
		{ error: "prompt must be a non-empty string" },
		{ status: 400 },
	);
}
```

Limit its length before paying for inference:

```ts
if (prompt.length > 4_000) {
	return Response.json(
		{ error: "prompt must contain at most 4,000 characters" },
		{ status: 400 },
	);
}
```

Use the validated prompt in the user message:

```ts
{ role: "user", content: prompt }
```

Test it:

```bash
curl -X POST http://localhost:8787/chat \
	-H 'Content-Type: application/json' \
	-d '{"prompt":"Explain Cloudflare Workers in three sentences."}'
```

Test invalid input:

```bash
curl -i -X POST http://localhost:8787/chat \
	-H 'Content-Type: application/json' \
	-d '{}'
```

### Checkpoint

- A valid prompt returns `200`.
- An empty prompt returns `400`.
- `GET /chat` returns `405`.
- An unknown API route returns `404`.

## Step 5: Handle inference failures

Wrap only the model call and its successful response in `try/catch`:

```ts
try {
	const response = await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: "You are a helpful assistant." },
			{ role: "user", content: prompt },
		],
		chat_template_kwargs: {
			enable_thinking: false,
		},
	});

	return Response.json(response);
} catch (error) {
	console.error(
		JSON.stringify({
			event: "ai_inference_failed",
			message: error instanceof Error ? error.message : "Unknown error",
		}),
	);

	return Response.json(
		{ error: "Failed to generate response" },
		{ status: 502 },
	);
}
```

The client gets a stable public error. Internal details remain in structured Worker logs.

### Checkpoint

- Request validation still returns `400`, not `502`.
- An inference failure does not expose the raw exception to the client.

## Step 6: Add `POST /chat/stream`

The route guard from Step 4 must explicitly allow `/chat/stream`. Route matching is exact: `/chat-stream` and `/chat/stream` are different paths.

Add the streaming branch:

```ts
if (url.pathname === "/chat/stream") {
	try {
		const stream = await env.AI.run(MODEL, {
			messages: [
				{ role: "system", content: "You are a helpful assistant." },
				{ role: "user", content: prompt },
			],
			stream: true,
			chat_template_kwargs: {
				enable_thinking: false,
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
			},
		});
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "ai_inference_failed",
				message: error instanceof Error ? error.message : "Unknown error",
			}),
		);

		return Response.json(
			{ error: "Failed to generate response" },
			{ status: 502 },
		);
	}
}
```

Test with curl buffering disabled:

```bash
curl -N -X POST http://localhost:8787/chat/stream \
	-H 'Content-Type: application/json' \
	-d '{"prompt":"Write a short poem about edge computing."}'
```

`-N` lets events appear as they arrive.

### Checkpoint

- The first text arrives before generation completes.
- The response content type is `text/event-stream`.
- `/chat/stream` returns `200`, not `404`.
- You can explain why the Worker returns the stream instead of reading it into one string.

## Step 7: Configure static assets

Create the assets directory:

```bash
mkdir public
```

Create `public/index.html`.

Add this top-level configuration to `wrangler.jsonc`:

```jsonc
"assets": {
	"directory": "./public",
	"binding": "ASSETS",
	"run_worker_first": [
		"/chat",
		"/chat/*"
	]
}
```

`run_worker_first` ensures that `/chat` and `/chat/stream` reach Worker code. Other matching requests, including `/`, can be served from `public`.

Regenerate types:

```bash
npm run cf-typegen
```

Confirm the generated environment now contains both bindings:

```ts
AI: Ai;
ASSETS: Fetcher;
```

### Checkpoint

```bash
npx tsc --noEmit
npx wrangler deploy --dry-run
```

Both commands pass, and the dry run reports the `AI` and `ASSETS` bindings.

## Step 8: Build the browser chat interface

Add these elements to `public/index.html`:

```html
<div id="output" aria-live="polite"></div>

<form id="prompt-form">
	<textarea
		id="prompt"
		maxlength="4000"
		placeholder="Message Gemma"
		required
	></textarea>
	<button id="send-button" type="submit">Send</button>
	<button id="stop-button" type="button">Stop</button>
</form>
```

Keep the composer outside the scrolling response element. Use a fixed-height application shell and let only the response area scroll. This prevents the Send button from moving down as output grows.

Submit the prompt:

```js
const response = await fetch("/chat/stream", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ prompt }),
	signal: controller.signal,
});
```

Read the stream incrementally:

```js
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
	const { value, done } = await reader.read();
	buffer += decoder.decode(value, { stream: !done });
	buffer = buffer.replace(/\r\n/g, "\n");

	let boundary = buffer.indexOf("\n\n");
	while (boundary !== -1) {
		const event = buffer.slice(0, boundary);
		buffer = buffer.slice(boundary + 2);

		// Read data: lines, parse the JSON, and append event.response.
		boundary = buffer.indexOf("\n\n");
	}

	if (done) break;
}
```

The finished implementation in `public/index.html` also adds:

- SSE `[DONE]` handling
- Request and model errors
- `AbortController` for Stop
- Command/Ctrl + Enter
- Character counting
- Automatic response-area scrolling
- Mobile and keyboard-accessible styles

Append model text with `textContent` or text nodes, not `innerHTML`.

### Checkpoint

- The interface loads at `/`.
- Submit calls `/chat/stream`.
- Tokens appear incrementally.
- Stop aborts the browser request.
- The composer remains visible while the response scrolls.
- Model output is inserted as text rather than executable HTML.

## Step 9: Run final verification

Run:

```bash
npm run cf-typegen
npx tsc --noEmit
npx wrangler deploy --dry-run
npm run dev
```

Open the URL printed by Wrangler. If `8787` is occupied, Wrangler may select another port. Run only one Wrangler development server for this project at a time; multiple instances can contend for local SQLite state.

## Request flow

```text
Browser
  │
  │ POST /chat/stream {"prompt":"..."}
  ▼
Worker validates the request
  │
  │ env.AI.run(..., { stream: true })
  ▼
Workers AI
  │
  │ text/event-stream
  ▼
Browser reads and renders each SSE event
```

## Lesson checkpoint

- [ ] The browser interface loads.
- [ ] The composer remains at the bottom while the response grows.
- [ ] Tokens appear before generation is complete.
- [ ] Stop cancels an in-progress browser request.
- [ ] An empty prompt is rejected.
- [ ] `npx tsc --noEmit` passes.
- [ ] I can explain the difference between `/chat` and `/chat/stream`.

## Explain it in your own words

Before continuing, explain:

1. How `wrangler.jsonc` makes Workers AI available on `env`
2. Why request JSON is typed as `unknown`
3. Why the system prompt stays on the server
4. How SSE differs from a complete JSON response
5. Why the client keeps an incomplete chunk buffer
6. Why only the response area should scroll
7. Why local Workers AI calls can still consume remote usage

Continue to [Lesson 2](../lesson-02-multi-turn-chat/README.md).
