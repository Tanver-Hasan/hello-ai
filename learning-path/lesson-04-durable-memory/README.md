# Lesson 4: Persistent Memory with Durable Objects

## Goal

Persist each conversation so it survives page refreshes and Worker restarts.

Use one Durable Object per conversation. Do not use one global object for all users.

## Architecture

```text
Browser sends conversation ID
             │
             ▼
Worker validates request
             │ getByName(conversationId)
             ▼
Conversation Durable Object
             │
             ├── SQLite message history
             └── Workers AI request
```

The Worker remains the public stateless entry point. The Durable Object owns state for one conversation.

## Step 1: Choose the identity

Generate a conversation ID in the browser:

```js
crypto.randomUUID()
```

Store it in `localStorage`. Include it in API routes:

```text
POST /conversations/:id/chat/stream
GET  /conversations/:id/messages
DELETE /conversations/:id
```

Validate the ID before using it as a Durable Object name.

## Step 2: Configure the binding

Add a Durable Object binding and declarative SQLite class export to `wrangler.jsonc`:

```jsonc
"durable_objects": {
	"bindings": [
		{
			"name": "CONVERSATIONS",
			"class_name": "Conversation"
		}
	]
},
"exports": {
	"Conversation": {
		"type": "durable-object",
		"storage": "sqlite"
	}
}
```

Current Wrangler supports declarative Durable Object class exports. The `exports` entry declares this as a live SQLite-backed class.

Add the new API prefix to the Assets configuration:

```jsonc
"run_worker_first": [
	"/chat",
	"/chat/*",
	"/conversations/*"
]
```

Then regenerate types:

```bash
npm run cf-typegen
```

## Step 3: Create the Durable Object

Create `src/conversation.ts` and extend Cloudflare’s `DurableObject` base class.

Initialize a SQLite table for messages:

```sql
CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
	content TEXT NOT NULL,
	created_at INTEGER NOT NULL
)
```

Use `this.ctx.storage.sql`. New Durable Object namespaces should use SQLite storage.

Create `src/conversation.ts`:

```ts
import { DurableObject } from "cloudflare:workers";

export type MessageRole = "user" | "assistant";

export type StoredMessage = {
	id: number;
	role: MessageRole;
	content: string;
	createdAt: number;
};

type MessageRow = {
	id: number;
	role: MessageRole;
	content: string;
	created_at: number;
};

export class Conversation extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
	}

	listMessages(): StoredMessage[] {
		return this.ctx.storage.sql
			.exec<MessageRow>(
				"SELECT id, role, content, created_at FROM messages ORDER BY id",
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				role: row.role,
				content: row.content,
				createdAt: row.created_at,
			}));
	}

	appendMessage(role: MessageRole, content: string): void {
		if (
			(role !== "user" && role !== "assistant") ||
			typeof content !== "string" ||
			!content.trim() ||
			content.length > 4_000
		) {
			throw new Error("Invalid message");
		}

		this.ctx.storage.sql.exec(
			"INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
			role,
			content.trim(),
			Date.now(),
		);
	}

	clearMessages(): void {
		this.ctx.storage.sql.exec("DELETE FROM messages");
	}
}
```

Export the class from `src/index.ts`:

```ts
export { Conversation } from "./conversation";
```

Run:

```bash
npm run cf-typegen
npx tsc --noEmit
```

## Step 4: Add RPC methods

Create focused public methods such as:

```ts
listMessages()
appendMessage(role, content)
clearMessages()
```

Validate arguments at the RPC boundary. Persist a completed user or assistant message before treating it as durable state.

Do not hold `blockConcurrencyWhile()` across AI inference or other external I/O. Use it only when constructor initialization requires it.

The methods in the previous step are RPC methods because they are public methods on the exported Durable Object class. Calls through a stub cross the Worker-to-object boundary.

## Step 5: Route to one object per conversation

From the Worker:

```ts
const conversation = env.CONVERSATIONS.getByName(conversationId);
```

The same ID routes to the same logical object. Different conversation IDs receive isolated storage.

Add a strict ID parser in `src/index.ts`:

```ts
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conversationRoute(pathname: string) {
	const match = pathname.match(
		/^\/conversations\/([^/]+)\/(messages|chat\/stream)$/,
	);

	if (!match || !UUID.test(match[1])) {
		return null;
	}

	return {
		id: match[1],
		action: match[2] as "messages" | "chat/stream",
	};
}
```

Read history:

```ts
const route = conversationRoute(url.pathname);
if (route?.action === "messages" && request.method === "GET") {
	const conversation = env.CONVERSATIONS.getByName(route.id);
	return Response.json({
		messages: await conversation.listMessages(),
	});
}
```

Add a clear route:

```ts
const deleteMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);
if (
	deleteMatch &&
	UUID.test(deleteMatch[1]) &&
	request.method === "DELETE"
) {
	const conversation = env.CONVERSATIONS.getByName(deleteMatch[1]);
	await conversation.clearMessages();
	return new Response(null, { status: 204 });
}
```

## Step 6: Decide when to persist streamed output

Use this first policy:

1. Persist the user message before inference.
2. Accumulate the assistant text while streaming.
3. Persist the assistant message only after a successful complete stream.
4. Record or remove incomplete turns according to an explicit failure policy.

Streaming while also saving the final text requires careful stream transformation. Implement and test this boundary rather than consuming the stream twice.

Add an SSE collector for the persistence branch:

```ts
async function collectAiText(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";

	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");

		let boundary = buffer.indexOf("\n\n");
		while (boundary !== -1) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const payload = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");

			if (payload && payload !== "[DONE]") {
				const event = JSON.parse(payload);
				text += typeof event.response === "string" ? event.response : "";
			}

			boundary = buffer.indexOf("\n\n");
		}

		if (done) return text;
	}
}
```

Update `fetch()` to accept `ctx`:

```ts
async fetch(request, env, ctx): Promise<Response>
```

Implement the persistent stream route:

```ts
if (route?.action === "chat/stream" && request.method === "POST") {
	const body: unknown = await request.json().catch(() => null);
	const prompt =
		typeof body === "object" &&
		body !== null &&
		"prompt" in body &&
		typeof body.prompt === "string"
			? body.prompt.trim()
			: "";

	if (!prompt || prompt.length > 4_000) {
		return Response.json({ error: "Invalid prompt" }, { status: 400 });
	}

	const conversation = env.CONVERSATIONS.getByName(route.id);
	await conversation.appendMessage("user", prompt);
	const history = await conversation.listMessages();

	const stream = await env.AI.run(MODEL, {
		messages: [
			{ role: "system", content: "You are a helpful assistant." },
			...history.map(({ role, content }) => ({ role, content })),
		],
		stream: true,
		chat_template_kwargs: {
			enable_thinking: false,
		},
	});

	const [clientStream, persistenceStream] = stream.tee();
	ctx.waitUntil(
		collectAiText(persistenceStream).then(async (content) => {
			if (content.trim()) {
				await conversation.appendMessage("assistant", content);
			}
		}),
	);

	return new Response(clientStream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
		},
	});
}
```

`tee()` creates one branch for the browser and one for persistence. `ctx.waitUntil()` ties persistence to the request lifetime after the response starts streaming.

For this lesson, a user message remains stored if inference fails. Display a Retry action for that turn. Define and test a different failure policy before changing it.

## Step 7: Restore history in the browser

On page load:

1. Read the conversation ID from `localStorage`.
2. Fetch `/conversations/:id/messages`.
3. Render returned turns.
4. Create a new ID if no conversation exists.

“New chat” should create a new ID. Deleting server data should be a separate, explicit action.

Create or restore an ID:

```js
const STORAGE_KEY = "hello-ai-conversation";

const getConversationId = () => {
	let id = localStorage.getItem(STORAGE_KEY);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(STORAGE_KEY, id);
	}
	return id;
};

let conversationId = getConversationId();
```

Change the stream request:

```js
fetch(`/conversations/${conversationId}/chat/stream`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ prompt }),
});
```

Restore messages:

```js
const restoreConversation = async () => {
	const response = await fetch(
		`/conversations/${conversationId}/messages`,
	);
	if (!response.ok) {
		throw new Error("Unable to restore conversation");
	}

	const body = await response.json();
	for (const message of body.messages) {
		renderMessage(message.role, message.content);
	}
};
```

Start a new chat without deleting the old one:

```js
const startNewChat = () => {
	controller?.abort();
	conversationId = crypto.randomUUID();
	localStorage.setItem(STORAGE_KEY, conversationId);
	messagesElement.replaceChildren();
	promptInput.focus();
};
```

Delete the active conversation only after an explicit user action:

```js
await fetch(`/conversations/${conversationId}`, {
	method: "DELETE",
});
```

## Step 8: Test isolation

Use two valid IDs:

```bash
ID_ONE="11111111-1111-4111-8111-111111111111"
ID_TWO="22222222-2222-4222-8222-222222222222"
```

Send a prompt to `ID_ONE`, then fetch both histories:

```bash
curl http://localhost:8787/conversations/$ID_ONE/messages
curl http://localhost:8787/conversations/$ID_TWO/messages
```

The second conversation must remain empty.

## Verification

```bash
npm run cf-typegen
npx tsc --noEmit
npm test -- --run
npm run dev
```

Use Local Explorer to inspect the local Durable Object namespace and storage.

## Checkpoint

- [ ] Refreshing restores the conversation.
- [ ] Two conversation IDs have isolated histories.
- [ ] The Worker uses `getByName()` with a validated ID.
- [ ] State is stored in SQLite, not only in memory.
- [ ] Constructor initialization does not perform AI inference.
- [ ] Tests cover message ordering and isolation.
- [ ] I can explain why one global Durable Object would be a bottleneck.

## Abuse and cost controls added later

A public client-chosen UUID is not authentication. If a conversation ID leaks, another caller can read or delete that conversation. Production private chats need authenticated ownership checks.

The completed lab adds these bounded-cost controls:

- Chat requests: 10 per 60 seconds per client and Cloudflare location
- Storage/history requests: 60 per 60 seconds per client and location
- JSON body limit: 16 KiB before inference
- Prompt limit: 4,000 characters
- Stored history: newest 40 messages per conversation
- Explicit delete uses `storage.deleteAll()`
- Reading an unused UUID does not create a messages table or persist storage
- AI Gateway spend limits protect inference separately

Rate limiting reduces bulk abuse but does not replace authentication. The number of Durable Object identities is otherwise unlimited, and each initialized SQLite object has storage overhead.

References:

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Continue to [Lesson 5](../lesson-05-tool-calling/README.md).
