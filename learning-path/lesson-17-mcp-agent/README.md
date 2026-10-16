# Lesson 17: Agents and Model Context Protocol

## Use cases

1. Publish MCP versions of Edgeword’s calculator and learning-document lookup without removing the native calculator.
2. Connect `EdgewordChatAgent` as an MCP client.
3. Keep the native calculator permanently for Streaming and Protected modes; MCP tools enhance optional Agent mode.

## Architecture added to the lab

```text
EdgewordChatAgent
  ├── Clef + Auto Router + AI Gateway
  ├── native addNumbers fallback
  └── authenticated MCP client
        └── Edgeword tools Worker
              ├── add
              └── readLesson
```

## Cloudflare framework and infrastructure used

- Agents SDK MCP client inside `EdgewordChatAgent`
- `agents/mcp/server` stateless handler
- Workers-hosted MCP endpoint
- MCP SDK v2 and Zod schemas
- OAuth-protected remote tools
- Existing Clef tool route and Auto Router tool-capable pool
- Current AI Gateway telemetry and budgets

## Important API choice

For new MCP servers, use:

```ts
createMcpHandler
```

from:

```ts
agents/mcp/server
```

`McpAgent` is deprecated and feature-frozen. Do not start a new server with it.

## Step 1: Match MCP package versions

The current stateless handler uses MCP SDK v2:

```bash
npm install agents @modelcontextprotocol/server@2.0.0 zod
```

Use the exact MCP versions required by the installed Agents release. Verify peer requirements before installing.

## Step 2: Build a narrow server

Create tools with:

- Stable names
- Precise descriptions
- Strict Zod schemas
- Small outputs
- No ambient access to secrets

Register the existing calculator contract:

```ts
server.registerTool(
	"add",
	{
		description: "Add two finite numbers",
		inputSchema: {
			a: z.number().finite(),
			b: z.number().finite(),
		},
	},
	async ({ a, b }) => ({
		content: [
			{
				type: "text",
				text: String(a + b),
			},
		],
	}),
);
```

Add a bounded learning-path tool:

```ts
server.registerTool(
	"readLesson",
	{
		description: "Read one approved Edgeword lesson",
		inputSchema: {
			lesson: z.number().int().min(1).max(18),
		},
	},
	async ({ lesson }) => readApprovedLesson(lesson),
);
```

The tool must map numbers to an allowlisted resource. It must not accept arbitrary filesystem paths.

## Step 3: Expose a stateless handler

```ts
import { createMcpHandler } from "agents/mcp/server";

const mcp = createMcpHandler(() => createServer(), {
	legacy: "reject",
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return mcp(request, env, ctx);
	},
};
```

Validate allowed `Host` values before calling the handler. The handler does not infer a Host allowlist from `request.url`.

## Step 4: Secure the endpoint

Remote MCP servers should use OAuth and explicit authorization. Authentication alone is insufficient; each tool needs authorization appropriate to its data and side effects.

Do not expose:

- Arbitrary fetch
- Arbitrary SQL
- Shell execution
- Dynamic code evaluation
- Unrestricted file paths
- Secrets in tool results

## Step 5: Connect an Agent as an MCP client

Use the current `McpClient` API from the installed Agents release inside `EdgewordChatAgent`. Configure:

- Server URL
- Authentication or OAuth
- Connection name
- Retry policy
- Elicitation handling, if supported

Wait for required connections before letting a chat model select MCP tools:

```ts
await this.waitForMcpConnections();
```

Merge only approved MCP tools into the same AI SDK tool set as `addNumbers`. Continue applying the Clef `tool` route and Auto Router tool-capable pool.

## Step 6: Apply a tool allowlist

Do not automatically expose every discovered MCP tool to Edgeword’s answer model. Filter by:

- Trusted server identity
- Tool name
- User role
- Agent workflow
- Side-effect level

## Step 7: Handle human approval

Require approval for tools that:

- Create or delete records
- Send communications
- Spend money
- Deploy code
- Change security configuration

Display server, tool name, and validated arguments to the approver.

## Step 8: Bound output

Large MCP responses can exhaust context and increase cost. Limit:

- Tool response size
- Number of tool calls
- Recursive steps
- Timeouts
- Concurrent connections

## Step 9: Test

Test:

- MCP initialize and capability negotiation
- Invalid tool arguments
- Unauthorized calls
- Host validation
- OAuth expiration
- Server unavailable
- Tool timeout
- Oversized result
- Approval and rejection
- Legacy client rejection
- Native calculator and MCP calculator parity
- Clef tool routing and Auto Router session affinity
- Gateway budget behavior during MCP-assisted turns

## Checkpoint

- [ ] New servers use `createMcpHandler`.
- [ ] Host and OAuth validation are configured.
- [ ] Agent tools use an allowlist.
- [ ] Side effects require authorization or approval.
- [ ] Tool results have size and time bounds.
- [ ] No generic execution primitive is exposed.
- [ ] The native calculator remains available regardless of MCP status.
- [ ] Edgeword’s routing, telemetry, and protected mode remain unchanged.

References:

- [MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP client API](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/)
- [Secure MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/)

Continue to [Lesson 18](../lesson-18-agent-production/README.md).
