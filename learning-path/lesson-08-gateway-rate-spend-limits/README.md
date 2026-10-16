# Lesson 8: AI Gateway Rate and Spend Protection

## Goal

Protect the application from traffic spikes, automated abuse, and unexpected model costs.

Rate limits count requests. Spend limits track estimated monetary cost. Use both because equal request counts can have very different token costs.

## Step 1: Measure the application’s request multiplier

One browser chat currently creates two AI Gateway requests:

```text
tool_selection
  └── direct_response
```

or:

```text
tool_selection
  └── tool_response
```

Therefore:

```text
10 browser chat turns ≈ 20 gateway requests
```

Account for retries and Guardrails evaluation when estimating traffic. Do not set a gateway limit equal to the desired number of browser messages.

## Step 2: Choose a rate-limit scope

The default gateway rate limit applies uniformly to all requests using that gateway.

Choose:

- Requests allowed
- Window length
- Fixed or sliding window
- Whether this gateway is shared by other applications

A sliding window is smoother around time-window boundaries. A fixed window is easier to reason about but permits bursts across a boundary.

For an isolated learning gateway, begin with a conservative value that still allows the application’s two AI requests per chat turn. Do not copy a sample number directly into production without measuring traffic.

## Step 3: Enable gateway rate limiting

In the Cloudflare dashboard:

1. Go to **AI > AI Gateway**.
2. Select the gateway used by `AI_GATEWAY_ID`.
3. Open **Settings**.
4. Enable **Rate-limiting**.
5. Enter the request count.
6. Enter the time period.
7. Choose fixed or sliding enforcement.
8. Save.

Requests above the limit receive `429 Too Many Requests` and are not sent to the model.

## Step 4: Design application-level limits

A single gateway-wide limit protects total capacity but does not ensure fairness between users.

For per-user control:

1. Authenticate the user in the Worker.
2. Derive a stable internal user or tenant identifier.
3. Add a non-sensitive identifier to Gateway metadata.
4. Use Dynamic Routing or spend-limit dimensions to split by that metadata.

Do not trust a user ID supplied directly in request JSON. Derive it from verified identity.

Do not use `requestId` as a per-user limit key; every request ID is unique and would create a separate bucket.

## Step 5: Handle `429` clearly

The browser should distinguish rate limiting from a general inference failure:

```js
if (response.status === 429) {
	throw new Error("Chat usage limit reached. Try again later.");
}
```

The Worker should return a stable public response when it can identify an upstream rate-limit error:

```json
{
	"error": "rate_limited",
	"requestId": "..."
}
```

Do not parse undocumented error-message strings to detect `429`. Use a documented status or error property available in the installed runtime before implementing automatic classification.

The lab now uses `isRateLimitError()` to check:

- `status`, `statusCode`, or `httpStatus` equal to `429`
- Documented Workers AI codes `3036` and `3040`
- The same fields on a direct `cause`

It deliberately does not classify errors by matching human-readable messages.

`inferenceErrorResponse()` returns:

```json
{
	"error": "rate_limited",
	"message": "Chat usage limit reached. Try again later.",
	"requestId": "..."
}
```

with:

```text
HTTP 429
Cache-Control: no-store
X-Request-ID: <same request ID>
```

All inference catch boundaries use this shared response helper. Unrelated inference failures continue to return `502`.

The browser checks `response.status === 429` and displays the public `message` value instead of the internal error code.

## Step 6: Create a spend-limit plan

Spend limits can be scoped by:

- Provider
- Model
- Custom metadata
- A combination of dimensions

For this application, useful dimensions are:

```text
provider = workers-ai
model = cloudflare/auto
metadata.feature = durable_chat
```

The application restricts Auto Router to an explicit open-weight Workers AI model pool. Verify both the requested model and selected routed model in Gateway logs before creating model-specific spend rules.

Use **Filter by value** to apply a budget only to `durable_chat`.

Use **Split by value** only with a trusted stable identifier, such as an authenticated tenant ID.

## Step 7: Configure a spend limit

In the gateway dashboard:

1. Select the gateway.
2. Open **Settings > Spend limits**.
3. Add a rule.
4. Choose a fixed or rolling time window.
5. Set a budget appropriate for the learning account.
6. Optionally filter by provider, model, or `metadata.feature`.
7. Select **Block requests** when the budget is exhausted.
8. Save.

When spend reaches the limit, AI Gateway blocks matching requests with `429` until the window resets.

Current AI Gateway documentation allows up to 20 spend-limit rules per gateway. Recheck the limits page before production configuration.

### Lab configuration

Both gateways now have an enabled fixed 30-day cost rule:

```json
{
	"id": "monthly-5-usd",
	"enabled": true,
	"limitType": "cost",
	"limit": 5,
	"window": 2592000,
	"technique": "fixed"
}
```

This is `$5` per gateway, so the two gateways can consume approximately `$10` combined during one 30-day window. The rules cover inference routed through AI Gateway; they do not cap Worker or Durable Object charges.

The current request controls are:

```text
AI Gateway:        50 model calls / 60 seconds per gateway
Worker chat API:   10 chat turns / 60 seconds per client and colo
Worker storage API: 60 operations / 60 seconds per client and colo
```

One chat turn can consume two or three Gateway calls, so the Worker limit is intentionally below the Gateway request limit.

Worker Rate Limiting is local to each Cloudflare location, permissive, and eventually consistent. It is an abuse-control layer, not an exact billing counter. The AI Gateway spend rule is the hard inference-cost control.

## Step 8: Test safely

Do not generate a large number of paid requests just to test a production limit.

Use one of these safer approaches:

1. Create a separate learning gateway with a deliberately small temporary request limit.
2. Use a short window and a small number of synthetic prompts.
3. Confirm normal requests succeed.
4. Send only enough additional requests to cross the temporary limit.
5. Verify the next request returns `429`.
6. Restore the intended setting after the test.

Record:

- Gateway request count
- Browser chat-turn count
- `429` response
- Request ID
- Reset time

## Step 9: Monitor

In AI Gateway **Analytics**, monitor:

- Requests
- Token usage
- Estimated cost
- Errors
- `429` responses
- Cache hits

Create an operational review process before increasing limits.

## Checkpoint

- [ ] I know how many gateway calls one chat turn produces.
- [ ] A gateway-wide rate limit is configured.
- [ ] A spend-limit rule protects the learning workload.
- [ ] Limits use trusted dimensions.
- [ ] The UI has a clear rate-limit message.
- [ ] I tested with a small temporary limit rather than generating excessive traffic.

References:

- [AI Gateway rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)
- [AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)

Continue to [Lesson 9](../lesson-09-gateway-guardrails-dlp/README.md).
