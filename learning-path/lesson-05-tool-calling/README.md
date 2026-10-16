# Lesson 5: Safe Tool Calling

## Goal

Allow the model to call one deterministic calculator function. This teaches tool schemas and execution boundaries without introducing third-party credentials.

## Security model

The model may request a tool call, but your code decides:

- Which tools exist
- Which arguments are accepted
- What the function can access
- How many tool calls may run
- What result returns to the model

Never treat model-generated tool arguments as trusted input.

## Step 1: Check model support

Confirm the selected model currently supports function calling in the Workers AI model catalog.

This project implements the Chat Completions tool loop directly. AI Gateway Auto Router selects between an explicit open-weight Workers AI pool while the application keeps tool allowlisting, runtime argument validation, tool-result messages, and recursion limits visible.

No additional dependency is required. Run:

```bash
npx tsc --noEmit
```

## Step 2: Define a narrow calculator

Start with one operation:

```ts
type AddArgs = {
	a: number;
	b: number;
};
```

Reject:

- Missing values
- Non-finite values
- Unexpected properties if strict validation is enabled
- Values outside a reasonable range

Return a string or JSON-serializable result.

Create `src/tools/calculator.ts`:

```ts
export type AddArgs = {
	a: number;
	b: number;
};

const LIMIT = 1_000_000_000;

export async function addNumbers(args: unknown): Promise<string> {
	if (
		typeof args !== "object" ||
		args === null ||
		!("a" in args) ||
		!("b" in args) ||
		typeof args.a !== "number" ||
		typeof args.b !== "number" ||
		!Number.isFinite(args.a) ||
		!Number.isFinite(args.b)
	) {
		throw new Error("a and b must be finite numbers");
	}

	if (Math.abs(args.a) > LIMIT || Math.abs(args.b) > LIMIT) {
		throw new Error(`a and b must be between -${LIMIT} and ${LIMIT}`);
	}

	return String(args.a + args.b);
}
```

The JSON schema validates model output. The function still validates at runtime because schemas are not a substitute for an execution boundary.

## Step 3: Describe the tool

Give it:

- A precise name such as `addNumbers`
- A description that says exactly when to use it
- A JSON schema with two required numbers
- The validated implementation

Import the calculator in `src/index.ts`:

```ts
import { addNumbers } from "./tools/calculator";
```

Define a native Chat Completions tool:

```ts
const CALCULATOR_TOOL: ChatCompletionTool = {
	type: "function",
	function: {
		name: "addNumbers",
		description: "Add two finite numbers and return their exact sum.",
		parameters: {
			type: "object",
			properties: {
				a: { type: "number", description: "The first number" },
				b: { type: "number", description: "The second number" },
			},
			required: ["a", "b"],
		},
	},
};
```

The first inference lets the model answer normally or request the calculator:

```ts
const response = await env.AI.run(MODEL, {
	messages,
	tools: [CALCULATOR_TOOL],
	tool_choice: "auto",
	parallel_tool_calls: false,
	chat_template_kwargs: { enable_thinking: false },
});
```

Read `response.choices[0].message.tool_calls`. For each allowed call:

1. Require the function name to equal `addNumbers`.
2. Parse its JSON argument string.
3. Pass the unknown value through `addNumbers` runtime validation.
4. Create a `ToolMessage` containing the result and matching `tool_call_id`.
5. Make a final streaming inference with the assistant tool-call message and tool result.

The implemented orchestration is `runChatWithCalculator()` in `src/index.ts`. Keep the `tee()` persistence logic from Lesson 4 after it returns the final stream.

When no calculator call is requested, the application performs a second inference without tools so the normal answer is still delivered as a true token stream. This costs an additional inference compared with returning the already-complete selection response, but avoids wrapping a buffered answer in a single SSE event.

## Step 4: Limit execution

Do not allow arbitrary URL fetching, shell commands, dynamic code execution, or unrestricted database queries.

The implementation enforces:

- JSON schema guidance for the model
- Independent runtime validation inside `addNumbers`
- At most two tool calls in a response
- No tools on the final inference, preventing recursion
- A single function with no network or storage access

Keep the tool list defined by server code. Never accept tool definitions or function names from the request body.

## Step 5: Expose tool activity in the UI

Show a small status such as:

```text
Using calculator…
```

Do not display raw internal prompts or hidden reasoning. Display only user-relevant tool names and results.

The endpoint streams only the final model answer, not a browser-facing audit event for internal tool calls. Use neutral UI copy:

```js
setStatus("Generating · calculator available", "streaming");
```

Do not claim “Calculator used” unless your server emits a separate trusted event after actual execution.

## Step 6: Test without AI

Unit test the calculator directly:

- `2 + 3`
- Negative numbers
- Decimal values
- Missing arguments
- `NaN` and infinity
- Values outside the allowed range

Then add one explicitly marked integration test for model tool selection if you choose to spend a real inference request.

Create `test/calculator.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addNumbers } from "../src/tools/calculator";

describe("addNumbers", () => {
	it.each([
		[2, 3, "5"],
		[-4, 9, "5"],
		[1.25, 2.5, "3.75"],
	])("adds %s and %s", async (a, b, expected) => {
		await expect(addNumbers({ a, b })).resolves.toBe(expected);
	});

	it.each([
		[Number.NaN, 1],
		[Number.POSITIVE_INFINITY, 1],
		[1_000_000_001, 1],
	])("rejects unsafe input", async (a, b) => {
		await expect(addNumbers({ a, b })).rejects.toThrow();
	});
});
```

Run only this test:

```bash
npm test -- --run test/calculator.spec.ts
```

## Step 7: Run a manual tool-call test

Start the Worker and ask a calculation that is awkward to guess:

```bash
curl -N -X POST \
	http://localhost:8787/conversations/11111111-1111-4111-8111-111111111111/chat/stream \
	-H 'Content-Type: application/json' \
	-d '{"prompt":"What is 123456.75 plus 8765.125? Use the calculator."}'
```

Expected result:

```text
132221.875
```

This request performs real inference and may consume Workers AI usage.

## Step 8: Verify

```bash
npx tsc --noEmit
npm test -- --run
npx wrangler deploy --dry-run
```

## Checkpoint

- [ ] The model can answer a calculation by using the tool.
- [ ] Tool arguments are validated independently of the model.
- [ ] Tool calls have a limit and the final inference cannot call another tool.
- [ ] Unit tests do not call Workers AI.
- [ ] The tool cannot fetch arbitrary URLs or execute arbitrary code.
- [ ] I can explain the difference between tool selection and tool execution.

References:

- [Workers AI function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/)
- [Traditional function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/traditional/)
- [AI Gateway Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/)

Continue to [Lesson 6](../lesson-06-production/README.md).
