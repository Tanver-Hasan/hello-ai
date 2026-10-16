# Lesson 7: AI Gateway Authentication and Log Privacy

## Goal

Prevent unauthorized gateway use and decide exactly what AI Gateway may retain about chat requests.

This lesson changes gateway settings in the Cloudflare dashboard. Read every step before changing the deployed gateway.

## Architecture

```text
Browser
  │ no Cloudflare API token
  ▼
Worker
  │ env.AI binding identity
  ▼
Authenticated AI Gateway
  │
  ▼
Workers AI
```

The browser never receives a Cloudflare API token. The Worker-side AI binding authenticates to AI Gateway using the associated Cloudflare account identity.

## Step 1: Confirm requests use the binding

The application should call:

```ts
env.AI.run(model, input, {
	gateway: {
		id: env.AI_GATEWAY_ID,
	},
});
```

Do not replace this with a browser request to AI Gateway. Doing so would require exposing a credential or creating an unauthenticated inference path.

## Step 2: Verify gateway authentication

In the Cloudflare dashboard:

1. Select the account that owns the `hello-ai` Worker.
2. Go to **AI > AI Gateway**.
3. Select the `default` gateway.
4. Open **Settings**.
5. Confirm **Authenticated Gateway** is enabled.

The automatically created `default` gateway has authentication enabled by default.

No additional authentication header is required when requests come from a Worker AI binding.

## Step 3: Understand token scope

External applications using the REST API need a Cloudflare API token. Provider-native gateway endpoints use `cf-aig-authorization`; the recommended REST API uses the standard `Authorization` header.

Do not create an external token for this browser application.

AI Gateway `Run` permission is account-scoped, not limited to one gateway. A token with that permission can invoke every gateway in the account, including gateways that use stored provider credentials. Use separate Cloudflare accounts when strong tenant or gateway credential isolation is required.

## Step 4: Choose a logging policy

AI Gateway logs can contain:

- Prompts
- Model responses
- Provider and model
- Token usage
- Cost and duration
- Request status
- Custom metadata

Choose one policy before using real data:

| Policy | Visibility | Payload retention |
| --- | --- | --- |
| Full logs | Metrics and request/response bodies | Prompts and answers may be retained |
| Metadata-only logs | Usage, latency, model, cost and status | Request/response bodies are not retained |
| No logs | No gateway log entry | Nothing is retained by Gateway logs |

For this learning project, use synthetic prompts until the policy is reviewed.

## Step 5: Configure log collection

In the gateway’s **Settings**:

1. Find **Collect logs**.
2. Decide whether gateway logs are required.
3. If they are not required, disable collection.
4. Review retention and deletion behavior for the account.
5. Leave log classification disabled unless you intentionally want stored content analyzed for task and model-fit classification.

The Worker currently sends:

```ts
collectLog: true
```

To disable a log entry for every application request, change it to:

```ts
collectLog: false
```

The binding’s current `GatewayOptions` type exposes `collectLog`, but not the per-request `cf-aig-collect-log-payload` header. For this binding-based application, use the gateway’s settings or disable the complete log entry when payload retention is unacceptable.

## Step 6: Keep metadata safe

The application adds:

```ts
metadata: {
	requestId,
	feature: "durable_chat",
	phase,
}
```

Safe metadata describes the request without containing its content.

Never put these values in metadata:

- Prompt or answer text
- Email address
- Full name
- Authentication token
- Durable Object contents
- Payment or health information

AI Gateway currently accepts up to five metadata entries per request. This application uses three.

## Step 7: Distinguish gateway auth from user auth

Authenticated Gateway protects the model path between the Worker and AI Gateway. It does not identify or authorize visitors to your Worker.

The public Worker still needs the appropriate application control:

- Authentication for private saved conversations
- Turnstile for human-verification use cases
- Worker or Gateway rate limits for abuse and cost control
- Authorization checks before reading a conversation belonging to a user

Do not treat a random conversation UUID as authorization.

## Step 8: Verify

Send one synthetic chat request, then:

1. Open browser developer tools.
2. Select the `/chat/stream` request.
3. Copy its `X-Request-ID` response header.
4. Open AI Gateway **Logs**.
5. Search for the same request ID.
6. Confirm the entry contains only the metadata and payload detail allowed by your selected policy.
7. Confirm no API token is present in browser storage, JavaScript, or network requests.

Do not paste log payloads or credentials into bug reports.

## Checkpoint

- [ ] Authenticated Gateway is enabled.
- [ ] The browser has no Cloudflare API token.
- [ ] A deliberate log-retention policy is selected.
- [ ] Metadata contains no prompt text or personal data.
- [ ] I understand that Gateway authentication is not end-user authentication.
- [ ] I can correlate a browser request with a gateway log using `X-Request-ID`.

References:

- [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)

Continue to [Lesson 8](../lesson-08-gateway-rate-spend-limits/README.md).
