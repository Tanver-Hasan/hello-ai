# Lesson 9: AI Gateway Guardrails and DLP

## Goal

Add content-safety and sensitive-data controls without accidentally disabling or buffering the application’s streaming responses.

Guardrails and Data Loss Prevention solve different problems:

- **Guardrails** classify prompt and response safety categories.
- **DLP** detects sensitive data such as financial, identity, healthcare, or custom organizational data.

## Critical streaming constraints

AI Gateway Guardrails do not support `stream: true` requests.

DLP behavior depends on what is scanned:

- Request-only DLP scans the prompt before model inference and preserves response streaming.
- Response or Both DLP must inspect the complete response and increases time to first token by buffering generation.

Do not enable response Guardrails on the existing streaming route and assume streaming will continue.

## Step 1: Choose a protection mode

### Mode A: Streaming-first

Use:

- Request-only DLP
- No Gateway Guardrails on this gateway
- Existing streamed model response

Choose this when time to first token is important and prompt data is the primary leakage concern.

### Mode B: High-protection, non-streaming

Use:

- Prompt and response Guardrails
- Request and response DLP
- A non-streaming Worker endpoint
- A separate gateway ID

Choose this when response inspection is more important than incremental token delivery.

Using separate gateways prevents one protection profile from unexpectedly changing every chat route.

## Step 2: Start policies in Flag mode

Before blocking:

1. Use synthetic test data.
2. Configure the policy action as **Flag**.
3. Observe false positives and expected matches in Gateway logs.
4. Document acceptable and unacceptable behavior.
5. Change reviewed high-confidence policies to **Block**.

Starting directly in Block mode can interrupt legitimate traffic without evidence.

## Step 3: Configure request-only DLP for streaming

In the Cloudflare dashboard:

1. Go to **AI > AI Gateway**.
2. Select the streaming gateway.
3. Open **Firewall**.
4. Enable **Data Loss Prevention (DLP)**.
5. Select **Add Policy**.
6. Give the policy a stable ID, such as `flag-financial-prompts`.
7. Select the required DLP profiles.
8. Set **Action** to **Flag**.
9. Set **Check** to **Request**.
10. Save.

Request-only scanning does not buffer the model response.

After reviewing logs, change specific policies from Flag to Block where appropriate.

DLP applies uniformly to requests passing through a gateway. There is no per-request header that selects or bypasses individual DLP profiles. Use separate gateways for different policies.

## Step 4: Inspect DLP results

Send synthetic data designed for the selected test profile. Do not use a real credit card number, government ID, medical record, or customer record.

In Gateway logs, inspect:

- DLP Action
- DLP Policies Matched
- DLP Profiles Matched
- DLP Entries Matched
- DLP Check
- Request ID

Verify Flag records the match without blocking. Then test a reviewed Block policy and confirm the model is not called.

## Step 5: Create a non-streaming protected route

For Guardrails or response-side DLP, add a separate endpoint such as:

```text
POST /conversations/:id/chat/protected
```

Use a separate gateway variable:

```jsonc
"vars": {
	"AI_GATEWAY_ID": "hello-ai-streaming",
	"AI_PROTECTED_GATEWAY_ID": "hello-ai-protected"
}
```

Both gateways were created explicitly with the Cloudflare `cf` CLI. The former `default` gateway was deleted only after both deployed routes passed smoke tests.

The protected route must call Workers AI without `stream: true`:

```ts
const response = await env.AI.run(
	MODEL,
	{
		messages,
		chat_template_kwargs: {
			enable_thinking: false,
		},
	},
	aiGatewayOptions(
		env.AI_PROTECTED_GATEWAY_ID,
		requestId,
		"protected_response",
	),
);

return Response.json(response);
```

After changing the gateway variables, run `npm run cf-typegen` and verify both bindings before deployment.

The completed application provides a UI mode selector:

- **Streaming** calls `/conversations/:id/chat/stream` through `hello-ai-streaming`.
- **Protected** calls `/conversations/:id/chat/protected` through `hello-ai-protected`.

Protected responses are persisted synchronously after Guardrails and request/response DLP complete.

## Step 6: Configure Guardrails

On the dedicated non-streaming gateway:

1. Open **Guardrails**.
2. Turn Guardrails on.
3. Select **Configure specific categories**.
4. Choose prompt categories.
5. Choose response categories.
6. Set initial actions to **Flag**.
7. Save.

Useful categories include:

- `P1` — prompt injection
- `S1` through `S13` — supported Llama Guard hazard categories

After testing, set selected categories to **Block**.

Guardrails evaluations use Workers AI and incur Workers AI usage. They also add latency.

## Step 7: Understand Guardrails failure behavior

For categories configured as Block:

- If Guardrails cannot obtain an evaluation, the request is blocked.

For categories configured as Flag:

- If evaluation is unavailable, the request proceeds without evaluation.

This is a deliberate availability-versus-safety trade-off. Document which behavior the application requires.

## Step 8: Configure response DLP

On the dedicated protected gateway:

1. Open **Firewall > DLP**.
2. Add a policy.
3. Select the required profiles.
4. Start with **Flag**.
5. Choose **Response** or **Both**.
6. Save and test.

Response scanning buffers output so that DLP can inspect it before delivery. The protected endpoint is intentionally non-streaming.

## Step 9: Test matrix

Test only synthetic examples:

| Case | Expected behavior |
| --- | --- |
| Normal prompt | Allowed |
| Synthetic prompt-injection attempt | P1 flagged or blocked |
| Synthetic request-side DLP match | Flagged or blocked before inference |
| Synthetic response-side DLP match | Flagged or blocked before delivery |
| Guardrails unavailable with Block | Request blocked |
| Guardrails unavailable with Flag | Request proceeds without evaluation |

For every case, record:

- HTTP status
- Public error code
- Request ID
- Gateway log action
- Whether model inference occurred
- Whether output streamed or was buffered

## Step 10: Keep public errors generic

Do not reveal exact DLP patterns or internal safety rules to untrusted clients.

Use stable responses such as:

```json
{
	"error": "content_blocked",
	"requestId": "..."
}
```

Keep detailed policy IDs and matched detection entries in protected Gateway logs.

## Checkpoint

- [ ] Streaming routes use request-only DLP.
- [ ] Guardrails and response DLP use a separate non-streaming gateway.
- [ ] Policies were evaluated in Flag mode before Block mode.
- [ ] Tests use synthetic, not real, sensitive data.
- [ ] Public errors do not expose DLP patterns.
- [ ] I understand the latency and Workers AI usage added by Guardrails.

References:

- [AI Gateway Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/)
- [Set up Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/set-up-guardrail/)
- [Guardrails usage considerations](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/)
- [AI Gateway DLP](https://developers.cloudflare.com/ai-gateway/features/dlp/)
- [Set up DLP](https://developers.cloudflare.com/ai-gateway/features/dlp/set-up-dlp/)
- [AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)

Continue to [Lesson 10](../lesson-10-clef-decision-routing/README.md).
