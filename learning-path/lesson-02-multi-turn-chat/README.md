# Lesson 2: Multi-turn Chat

## Goal

Turn the single prompt into a conversation. The browser will send earlier user and assistant messages with each request so the model can answer in context.

This lesson keeps history in browser memory. Refreshing the page clears it. Persistent history is introduced in Lesson 4.

## Concepts

- A model does not automatically remember previous HTTP requests.
- Context must be included in the next inference request.
- `system`, `user`, and `assistant` messages have different roles.
- Conversation history is untrusted input and must be validated.
- Long histories increase token use, latency, and cost.

## Step 1: Define the request shape

Replace the single-prompt request with:

```json
{
	"messages": [
		{ "role": "user", "content": "What is a Worker?" },
		{ "role": "assistant", "content": "A Worker is..." },
		{ "role": "user", "content": "Where does it run?" }
	]
}
```

Allow only client roles:

```ts
type ClientMessage = {
	role: "user" | "assistant";
	content: string;
};
```

Keep the system message on the server. A client must not be able to replace application-level instructions.

## Step 2: Validate every message

Add a function that rejects the request unless:

- `messages` is an array
- The array has between 1 and 20 entries
- Every item is a non-null object
- Every role is exactly `user` or `assistant`
- Every content value is a non-empty string
- Every content value is at most 4,000 characters
- The final message has role `user`

Return `400` with a useful JSON error when validation fails.

Add this parser above the Worker export in `src/index.ts`:

```ts
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4_000;

function parseMessages(body: unknown): ClientMessage[] | string {
	if (
		typeof body !== "object" ||
		body === null ||
		!("messages" in body) ||
		!Array.isArray(body.messages)
	) {
		return "messages must be an array";
	}

	if (body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
		return `messages must contain between 1 and ${MAX_MESSAGES} entries`;
	}

	const messages: ClientMessage[] = [];

	for (const item of body.messages) {
		if (typeof item !== "object" || item === null) {
			return "each message must be an object";
		}

		if (
			!("role" in item) ||
			(item.role !== "user" && item.role !== "assistant")
		) {
			return "message role must be user or assistant";
		}

		if (!("content" in item) || typeof item.content !== "string") {
			return "message content must be a string";
		}

		const content = item.content.trim();
		if (!content || content.length > MAX_MESSAGE_LENGTH) {
			return `message content must contain between 1 and ${MAX_MESSAGE_LENGTH} characters`;
		}

		messages.push({ role: item.role, content });
	}

	if (messages.at(-1)?.role !== "user") {
		return "the final message must have role user";
	}

	return messages;
}
```

Parse the body once inside `fetch()`:

```ts
const body: unknown = await request.json().catch(() => null);
const parsed = parseMessages(body);

if (typeof parsed === "string") {
	return Response.json({ error: parsed }, { status: 400 });
}

const messages = parsed;
```

## Step 3: Send history to Workers AI

Build the model input without trusting a client-provided system role:

```ts
messages: [
	{ role: "system", content: "You are a helpful assistant." },
	...messages,
]
```

Use the same validated message list for `/chat` and `/chat/stream`.

Create the input once:

```ts
const input = {
	messages: [
		{ role: "system" as const, content: "You are a helpful assistant." },
		...messages,
	],
	chat_template_kwargs: {
		enable_thinking: false,
	},
};
```

Use it for the complete response:

```ts
if (url.pathname === "/chat") {
	try {
		const response = await env.AI.run(MODEL, input);
		return Response.json(response);
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "ai_inference_failed",
				message: error instanceof Error ? error.message : "Unknown error",
			}),
		);
		return Response.json({ error: "AI inference failed" }, { status: 502 });
	}
}
```

For the stream, add `stream: true`:

```ts
if (url.pathname === "/chat/stream") {
	try {
		const stream = await env.AI.run(MODEL, {
			...input,
			stream: true,
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
		return Response.json({ error: "AI inference failed" }, { status: 502 });
	}
}
```

Check the API before changing the browser:

```bash
curl -N -X POST http://localhost:8787/chat/stream \
	-H 'Content-Type: application/json' \
	-d '{"messages":[{"role":"user","content":"My favorite color is blue."},{"role":"assistant","content":"Noted."},{"role":"user","content":"What is my favorite color?"}]}'
```

## Step 4: Track history in the browser

Create a module-level browser variable:

```js
const messages = [];
```

When the user submits:

1. Append `{ role: "user", content: prompt }`.
2. Render the user message.
3. Send the complete `messages` array.
4. Accumulate streamed response text.
5. Append `{ role: "assistant", content: completedText }` only after streaming completes.

Do not add a partial assistant message to history when the request fails.

Change the request body in `public/index.html`:

```js
body: JSON.stringify({ messages }),
```

Add a safe renderer:

```js
const messagesElement = document.querySelector("#messages");
const messages = [];

const renderMessage = (role, content = "") => {
	const article = document.createElement("article");
	article.className = `message ${role}`;

	const label = document.createElement("strong");
	label.textContent = role === "user" ? "You" : "Assistant";

	const text = document.createElement("div");
	text.className = "message-content";
	text.textContent = content;

	article.append(label, text);
	messagesElement.append(article);
	messagesElement.scrollTop = messagesElement.scrollHeight;
	return text;
};
```

At submission time:

```js
const userMessage = { role: "user", content: prompt };
messages.push(userMessage);
renderMessage(userMessage.role, userMessage.content);

const assistantElement = renderMessage("assistant");
let assistantText = "";
```

When the existing SSE parser produces a token:

```js
assistantText += token;
assistantElement.append(document.createTextNode(token));
messagesElement.scrollTop = messagesElement.scrollHeight;
```

After `[DONE]` or a clean end of stream:

```js
if (assistantText.trim()) {
	messages.push({ role: "assistant", content: assistantText });
}
```

In the error path, remove the empty assistant element and remove the user message from the in-memory history if you want Retry to resend exactly the same turn:

```js
assistantElement.closest(".message")?.remove();
messages.pop();
```

## Step 5: Render conversation turns

Replace the single output block with a message list:

```html
<div id="messages" aria-live="polite"></div>
```

Render user and assistant messages as separate elements. Continue using `textContent`; do not render model output through `innerHTML`.

Scroll only the message list. Keep the composer outside the scrolling element.

Use a flex layout:

```css
.app {
	display: flex;
	height: 100dvh;
	flex-direction: column;
}

#messages {
	min-height: 0;
	flex: 1;
	overflow-y: auto;
	padding: 24px;
}

#prompt-form {
	flex: 0 0 auto;
}

.message {
	max-width: 720px;
	margin: 0 auto 24px;
	white-space: pre-wrap;
}

.message.user .message-content {
	width: fit-content;
	margin-left: auto;
	border-radius: 16px;
	background: #eeeeef;
	padding: 10px 14px;
}
```

## Step 6: Add “New chat”

Add a button that:

1. Aborts an active stream
2. Clears the `messages` array
3. Clears rendered messages
4. Restores the empty state
5. Focuses the prompt input

Add the button:

```html
<button id="new-chat" type="button">New chat</button>
```

Wire it:

```js
document.querySelector("#new-chat").addEventListener("click", () => {
	controller?.abort();
	messages.length = 0;
	messagesElement.replaceChildren();
	promptInput.value = "";
	promptInput.focus();
});
```

## Step 7: Check the types

```bash
npx tsc --noEmit
```

If TypeScript widens a role to `string`, keep the `ClientMessage` type on parsed history and use `as const` only for the server-owned system role. Do not cast unvalidated request data.

## Manual tests

Ask:

```text
My name is Tanver. Reply with only “noted”.
```

Then ask:

```text
What name did I give you?
```

Also test:

- An empty `messages` array
- More than 20 messages
- A message with role `system`
- A message with empty content
- A conversation whose final message is from the assistant

## Verification

```bash
npx tsc --noEmit
npm run dev
```

## Checkpoint

- [ ] The second answer uses information from the first turn.
- [ ] The server, not the browser, owns the system message.
- [ ] Invalid roles and oversized histories return `400`.
- [ ] A failed stream is not saved as a completed assistant turn.
- [ ] New chat clears browser memory.
- [ ] Refreshing still clears the conversation.
- [ ] I can explain why stateless HTTP requests do not create model memory.

Continue to [Lesson 3](../lesson-03-testing/README.md).
