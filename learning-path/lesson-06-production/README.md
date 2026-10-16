# Lesson 6: AI Gateway and Production Readiness

## Goal

Route every Workers AI inference through AI Gateway, correlate requests across the browser and gateway logs, and prepare the application for controlled deployment.

## Step 1: Enable logs and traces

The project already enables observability. Also enable traces in `wrangler.jsonc`:

```jsonc
"observability": {
	"enabled": true,
	"traces": {
		"enabled": true
	}
}
```

Use structured logs with event names and safe metadata. Do not log secrets, authorization headers, full conversation history, or unnecessary personal data.

Use a lower sampling rate for a high-traffic production Worker:

```jsonc
"observability": {
	"logs": {
		"enabled": true,
		"head_sampling_rate": 1
	},
	"traces": {
		"enabled": true,
		"head_sampling_rate": 0.1
	}
}
```

During learning, a rate of `1` captures every request. Revisit sampling after measuring production traffic.

## Step 2: Add request correlation

Generate a request ID with:

```ts
crypto.randomUUID()
```

Return it in an `X-Request-ID` header and include it in structured error logs. This lets you connect a client-visible failure to Worker logs.

Add a response wrapper:

```ts
function withRequestId(response: Response, requestId: string): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Request-ID", requestId);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
```

Create the ID at the beginning of `fetch()`:

```ts
const requestId = crypto.randomUUID();
```

Wrap every return:

```ts
return withRequestId(
	Response.json({ error: "Not found" }, { status: 404 }),
	requestId,
);
```

Include safe fields in errors:

```ts
console.error(
	JSON.stringify({
		event: "ai_inference_failed",
		requestId,
		path: url.pathname,
		message: error instanceof Error ? error.message : "Unknown error",
	}),
);
```

Do not log the prompt or conversation history.

## Step 3: Route inference through AI Gateway

Add a configurable gateway ID to `wrangler.jsonc`:

```jsonc
"vars": {
	"AI_GATEWAY_ID": "hello-ai-streaming",
	"AI_PROTECTED_GATEWAY_ID": "hello-ai-protected"
}
```

Regenerate types:

```bash
npm run cf-typegen
```

The generated `Env` now includes:

```ts
AI_GATEWAY_ID: "hello-ai-streaming";
AI_PROTECTED_GATEWAY_ID: "hello-ai-protected";
```

Both gateways were created explicitly with the Cloudflare `cf` CLI. The former `default` gateway was deleted after both deployed routes passed smoke tests.

Create a shared options builder:

```ts
export function aiGatewayOptions(
	gatewayId: string,
	requestId: string,
	phase: string,
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
			"cf-aig-allowed-models":
				"@cf/google/gemma-4-26b-a4b-it,@cf/moonshotai/kimi-k2.7-code",
		},
	};
}
```

The application uses:

```ts
const MODEL = "cloudflare/auto";
```

`cf-aig-allowed-models` replaces Auto Router’s managed default pool with two open-weight, function-calling Workers AI models. This avoids third-party Unified Billing while preserving an actual model-routing choice. Session and turn IDs pin multi-step tool calls to the same routed model.

Pass the returned object as the third argument to every `env.AI.run()` call:

```ts
const response = await env.AI.run(
	MODEL,
	input,
	aiGatewayOptions(
		env.AI_GATEWAY_ID,
		requestId,
		"tool_selection",
	),
);
```

The chat flow records these inference phases:

1. `tool_selection` — the model decides whether to call `addNumbers`.
2. `direct_response` — when no tool is needed, a second inference streams the normal answer.
3. `tool_response` — after calculator execution, a second inference streams the final answer.

Calls for one browser request use the same request ID, so they can be correlated in AI Gateway logs. This learning implementation prioritizes true streaming and clear tool orchestration; the selection call adds latency and inference usage.

### Why caching is disabled

`skipCache: true` is deliberate because conversation requests contain private, user-specific history. Do not enable caching until you have designed a privacy-safe cache key and verified that responses cannot leak between conversations.

### Logging and privacy

`collectLog: true` enables gateway request logs. Depending on gateway settings, logs can include prompts and responses. Before handling real user data:

1. Open the AI Gateway dashboard.
2. Select `hello-ai-streaming` or `hello-ai-protected`.
3. Review its logging settings and retention.
4. Disable payload storage if prompts or answers must not be retained.

Metadata must not contain prompt text, answers, secrets, or personal information. AI Gateway accepts up to five metadata entries per request; this lab uses three.

### Inspect requests

After running one chat request:

1. Open **AI Gateway** in the Cloudflare dashboard.
2. Select `hello-ai-streaming` or `hello-ai-protected`.
3. Open **Analytics** to inspect requests, tokens, cost, errors, and cache activity.
4. Open **Logs** and filter by `requestId`.
5. Confirm `tool_selection` followed by either `direct_response` or `tool_response`.

The Worker returns the same ID in the `X-Request-ID` response header, making a browser request traceable to gateway logs.

## Step 4: Protect public inference

Before publishing an unrestricted endpoint:

- Add rate limits appropriate to your plan and expected traffic.
- Add Turnstile when browser users should prove they are human.
- Enforce body-size, message-count, and content-length limits.
- Set explicit tool-call limits.
- Define authentication before storing personal conversations.

Retrieve current product limits from each Cloudflare product’s `/platform/limits/` page rather than relying on remembered numbers.

### Declare Turnstile configuration

After creating a Turnstile widget for your approved development and production hostnames, declare the required secret name:

```jsonc
"secrets": {
	"required": ["TURNSTILE_SECRET"]
},
"vars": {
	"TURNSTILE_HOSTNAMES": "localhost,127.0.0.1"
}
```

Production must use its own hostname allowlist and must not allow `localhost`.

Regenerate types:

```bash
npm run cf-typegen
```

Store the deployed secret interactively; never put its value in source or `wrangler.jsonc`:

```bash
npx wrangler secret put TURNSTILE_SECRET
```

Treat that command as a deployment. For gradual deployments, follow the current `wrangler versions secret` workflow instead.

For local development, put the value in an ignored `.dev.vars` file:

```text
TURNSTILE_SECRET=your-local-secret
```

Verify `.dev.vars` is ignored before creating it.

### Embed the browser widget

Load the Turnstile script:

```html
<script
	src="https://challenges.cloudflare.com/turnstile/v0/api.js"
	async
	defer
></script>
```

Add the widget near the composer:

```html
<div
	class="cf-turnstile"
	data-sitekey="YOUR_PUBLIC_SITE_KEY"
	data-action="chat"
></div>
```

Include the generated token in the chat request as `turnstileToken`. The site key is public; the secret is not.

Read it immediately before the request:

```js
const turnstileToken = document.querySelector(
	'[name="cf-turnstile-response"]',
)?.value;

const response = await fetch("/chat/stream", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		messages,
		turnstileToken,
	}),
});
```

### Verify on the Worker

Add:

```ts
type SiteverifyResult = {
	success: boolean;
	action?: string;
	hostname?: string;
};

async function verifyTurnstile(
	token: string,
	request: Request,
	env: Env,
): Promise<boolean> {
	if (!token || token.length > 2_048) return false;

	const expectedHostnames = new Set(
		env.TURNSTILE_HOSTNAMES.split(",")
			.map((hostname) => hostname.trim())
			.filter(Boolean),
	);
	if (expectedHostnames.size === 0) return false;

	try {
		const response = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				signal: AbortSignal.timeout(10_000),
				body: new URLSearchParams({
					secret: env.TURNSTILE_SECRET,
					response: token,
					remoteip: request.headers.get("CF-Connecting-IP") ?? "",
				}),
			},
		);

		if (!response.ok) return false;
		const result = await response.json<SiteverifyResult>();
		return (
			result.success === true &&
			result.action === "chat" &&
			typeof result.hostname === "string" &&
			expectedHostnames.has(result.hostname)
		);
	} catch {
		return false;
	}
}
```

Call `verifyTurnstile` before inference and return `403` when it fails. Tokens are single-use, so reset the widget before retrying from a page that remains open.

After parsing the body as `unknown`, narrow the token:

```ts
const turnstileToken =
	typeof body === "object" &&
	body !== null &&
	"turnstileToken" in body &&
	typeof body.turnstileToken === "string"
		? body.turnstileToken
		: "";

if (!(await verifyTurnstile(turnstileToken, request, env))) {
	return withRequestId(
		Response.json({ error: "verification_failed" }, { status: 403 }),
		requestId,
	);
}
```

Run this check before `env.AI.run()`.

Do not call Siteverify from the browser. Verification must happen in the Worker.

### Enforce request size early

Reject an oversized declared body before JSON parsing:

```ts
const contentLength = Number(request.headers.get("Content-Length") ?? "0");
if (contentLength > 100_000) {
	return Response.json({ error: "Request too large" }, { status: 413 });
}
```

Keep the message count and per-message limits from Lesson 2 even when `Content-Length` is absent.

## Step 5: Complete error behavior

Use stable public errors:

- `400` invalid request
- `401` or `403` authentication/authorization failure
- `404` unknown route or inaccessible conversation
- `405` unsupported method
- `429` rate limit
- `502` upstream inference failure

Do not return raw internal exception messages to clients.

Create one JSON error helper so responses remain consistent:

```ts
function errorResponse(
	status: number,
	code: string,
	requestId: string,
): Response {
	return withRequestId(
		Response.json(
			{
				error: code,
				requestId,
			},
			{ status },
		),
		requestId,
	);
}
```

Example:

```ts
return errorResponse(400, "invalid_request", requestId);
```

## Step 6: Verify locally

```bash
npm run cf-typegen
npx tsc --noEmit
npm test -- --run
npx wrangler deploy --dry-run
```

Run one manual browser conversation and inspect:

- Browser network events
- Worker logs
- Trace outcome and duration
- AI Gateway request visibility
- Durable Object state

Also verify:

```bash
curl -i http://localhost:8787/chat
```

The response should contain `X-Request-ID`.

Test Turnstile with a fresh real token, then replay the same token. The first valid request should proceed and the replay should be rejected.

## Step 7: Deploy intentionally

Check authentication and target account:

```bash
npx wrangler whoami
```

Deploy only when you intend to change the remote Worker:

```bash
npm run deploy
```

After deployment, run a small smoke test against the returned URL.

Use deployed tail logs during the smoke test:

```bash
npx wrangler tail
```

Do not paste secret values or complete sensitive logs into issue reports.

## Step 8: Rollback planning

Worker code rollback does not roll back Durable Object data or connected resources. Before production deployment:

1. Review schema compatibility with existing stored conversations.
2. Prefer additive schema changes.
3. Keep old readers compatible during rollout.
4. Test rollback behavior in a non-production environment.

## Checkpoint

- [ ] Logs and traces are enabled.
- [ ] Errors include a request ID but not sensitive prompt data.
- [ ] AI Gateway receives inference requests.
- [ ] Public inference has abuse controls.
- [ ] TypeScript, tests, and dry run pass.
- [ ] The target account and Worker name were checked before deployment.
- [ ] I can trace one failed request from browser response to server log.

References:

- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)
- [Workers AI with AI Gateway](https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/)
- [AI Gateway binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)

Continue to [Lesson 7](../lesson-07-gateway-auth-privacy/README.md).
