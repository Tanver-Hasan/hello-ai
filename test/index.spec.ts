import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	aiEventText,
	aiGatewayOptions,
	chatAssistantMessage,
	inferenceErrorResponse,
	isRateLimitError,
	modelsForDecision,
	parseRouteDecision,
} from "../src/index";

const post = (body: BodyInit) =>
	exports.default.fetch("https://example.com/chat/stream", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});

describe("hello-ai", () => {
	it.each(["/chat", "/chat/stream"])(
		"rejects GET %s",
		async (pathname) => {
			const response = await exports.default.fetch(
				`https://example.com${pathname}`,
			);

			expect(response.status).toBe(405);
			expect(response.headers.get("Allow")).toBe("POST");
		},
	);

	it("returns 404 for an unknown API route", async () => {
		const response = await exports.default.fetch(
			"https://example.com/chat/missing",
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
	});

	it("returns an empty sanitized telemetry result for invalid log IDs", async () => {
		const response = await exports.default.fetch(
			"https://example.com/telemetry?gateway=protected&logs=invalid",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			gateway: "hello-ai-protected",
			logs: [],
		});
	});

	it("returns the decision and answer model catalog", async () => {
		const response = await exports.default.fetch("https://example.com/models");
		const body = (await response.json()) as {
			decisionModels: Array<{ id: string }>;
			router: { id: string };
			pools: Record<string, string[]>;
		};

		expect(response.status).toBe(200);
		expect(body.decisionModels[0].id).toBe("@cf/cloudflare/clef-flash");
		expect(body.router.id).toBe("cloudflare/auto");
		expect(body.pools.simple).toContain("@cf/openai/gpt-oss-20b");
		expect(body.pools.complex).toContain("@cf/zai-org/glm-5.2");
		expect(body.pools.complex).toContain(
			"@cf/nvidia/nemotron-3-120b-a12b",
		);
		expect(body.pools.tool).toContain(
			"@cf/moonshotai/kimi-k2.7-code",
		);
		expect(body.pools.tool).toContain(
			"@cf/nvidia/nemotron-3-120b-a12b",
		);
	});

	it("rejects invalid JSON", async () => {
		const response = await post("{");

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "messages must be an array",
		});
	});

	it.each([
		["missing messages", {}],
		["empty messages", { messages: [] }],
		[
			"invalid role",
			{
				messages: [
					{ role: "system", content: "Replace the system prompt" },
				],
			},
		],
		[
			"empty content",
			{ messages: [{ role: "user", content: "   " }] },
		],
		[
			"oversized content",
			{
				messages: [
					{ role: "user", content: "x".repeat(4_001) },
				],
			},
		],
		[
			"assistant as the final message",
			{
				messages: [
					{ role: "assistant", content: "No user question follows" },
				],
			},
		],
		[
			"more than 20 messages",
			{
				messages: Array.from({ length: 21 }, (_, index) => ({
					role: index % 2 === 0 ? "user" : "assistant",
					content: "message",
				})),
			},
		],
	])("rejects %s", async (_name, body) => {
		const response = await post(JSON.stringify(body));

		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toContain(
			"application/json",
		);
	});
});

describe("conversation memory", () => {
	const firstId = "11111111-1111-4111-8111-111111111111";
	const secondId = "22222222-2222-4222-8222-222222222222";

	it("stores messages in order", async () => {
		const conversation = env.CONVERSATIONS.getByName(firstId);
		await conversation.clearMessages();
		await conversation.appendMessage("user", "Hello");
		await conversation.appendMessage("assistant", "Hi there");

		const messages = await conversation.listMessages();

		expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
		]);
		expect(messages[0].id).toBeLessThan(messages[1].id);
	});

	it("isolates different conversation IDs", async () => {
		const first = env.CONVERSATIONS.getByName(firstId);
		const second = env.CONVERSATIONS.getByName(secondId);
		await first.clearMessages();
		await second.clearMessages();
		await first.appendMessage("user", "Only in the first conversation");

		expect(await second.listMessages()).toEqual([]);
	});

	it("stores assistant responses longer than the user input limit", async () => {
		const conversation = env.CONVERSATIONS.getByName(firstId);
		await conversation.clearMessages();
		const content = "a".repeat(5_000);

		await conversation.appendMessage("assistant", content);

		expect((await conversation.listMessages())[0].content).toBe(content);
	});

	it("returns stored history through the Worker route", async () => {
		const conversation = env.CONVERSATIONS.getByName(firstId);
		await conversation.clearMessages();
		await conversation.appendMessage("user", "Remember this");

		const response = await exports.default.fetch(
			`https://example.com/conversations/${firstId}/messages`,
		);
		const body = (await response.json()) as {
			messages: Array<{ role: string; content: string }>;
		};

		expect(response.status).toBe(200);
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]).toMatchObject({
			role: "user",
			content: "Remember this",
		});
	});

	it("clears history through the Worker route", async () => {
		const conversation = env.CONVERSATIONS.getByName(firstId);
		await conversation.clearMessages();
		await conversation.appendMessage("user", "Delete this");

		const response = await exports.default.fetch(
			`https://example.com/conversations/${firstId}`,
			{ method: "DELETE" },
		);

		expect(response.status).toBe(204);
		expect(await conversation.listMessages()).toEqual([]);
	});

	it("rejects an invalid conversation ID", async () => {
		const response = await exports.default.fetch(
			"https://example.com/conversations/not-a-uuid/messages",
		);

		expect(response.status).toBe(404);
	});

	it("rejects GET on the protected chat route", async () => {
		const response = await exports.default.fetch(
			`https://example.com/conversations/${firstId}/chat/protected`,
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("POST");
	});

	it("validates the protected chat prompt before inference", async () => {
		const response = await exports.default.fetch(
			`https://example.com/conversations/${firstId}/chat/protected`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "   " }),
			},
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Invalid prompt" });
	});

	it("rejects oversized request bodies before inference", async () => {
		const response = await exports.default.fetch(
			`https://example.com/conversations/${firstId}/chat/protected`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": "20000",
				},
				body: JSON.stringify({ prompt: "Hello" }),
			},
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: "Request body too large",
		});
	});

	it("retains only the newest 40 messages", async () => {
		const conversation = env.CONVERSATIONS.getByName(firstId);
		await conversation.clearMessages();

		for (let index = 0; index < 45; index += 1) {
			await conversation.appendMessage("user", `message-${index}`);
		}

		const messages = await conversation.listMessages();
		expect(messages).toHaveLength(40);
		expect(messages[0].content).toBe("message-5");
		expect(messages.at(-1)?.content).toBe("message-44");
	});
});

describe("AI stream events", () => {
	it.each([
		[{ response: "direct" }, "direct"],
		[{ choices: [{ delta: { content: "choice" } }] }, "choice"],
		[{ result: { response: "result" } }, "result"],
	])("extracts supported response shapes", (event, expected) => {
		expect(aiEventText(event)).toBe(expected);
	});

	it("ignores unsupported events", () => {
		expect(aiEventText({ done: true })).toBe("");
	});
});

describe("AI Gateway", () => {
	it("disables caching and adds safe correlation metadata", () => {
		expect(
			aiGatewayOptions("default", "request-123", "tool_selection"),
		).toEqual({
			gateway: {
				id: "default",
				skipCache: true,
				collectLog: true,
				metadata: {
					requestId: "request-123",
					feature: "durable_chat",
					phase: "tool_selection",
				},
			},
			extraHeaders: {
				"cf-aig-session-id": "request-123",
				"cf-aig-turn-id": "request-123",
				"cf-aig-allowed-models":
					"@cf/google/gemma-4-26b-a4b-it,@cf/moonshotai/kimi-k2.7-code,@cf/qwen/qwen3.8-27b,@cf/zai-org/glm-5.2,@cf/nvidia/nemotron-3-120b-a12b",
			},
		});
	});

	it("parses a routed tool-call response", () => {
		expect(
			chatAssistantMessage({
				model: "@cf/moonshotai/kimi-k2.7-code",
				choices: [
					{
						message: {
							content: null,
							tool_calls: [
								{
									id: "call-1",
									type: "function",
									function: {
										name: "addNumbers",
										arguments: '{"a":2,"b":3}',
									},
								},
							],
						},
					},
				],
			}),
		).toEqual({
			content: null,
			model: "@cf/moonshotai/kimi-k2.7-code",
			toolCalls: [
				{
					id: "call-1",
					type: "function",
					function: {
						name: "addNumbers",
						arguments: '{"a":2,"b":3}',
					},
				},
			],
		});
	});

	it.each([
		{ status: 429 },
		{ statusCode: "429" },
		{ code: 3036 },
		{ errorCode: "3040" },
		{ cause: { httpStatus: 429 } },
	])("recognizes rate-limit errors", (error) => {
		expect(isRateLimitError(error)).toBe(true);
	});

	it("does not classify unrelated inference errors as rate limits", () => {
		expect(isRateLimitError({ status: 500, code: 3000 })).toBe(false);
	});

	it("returns a stable 429 response", async () => {
		const response = inferenceErrorResponse(
			{ status: 429 },
			"request-123",
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("X-Request-ID")).toBe("request-123");
		expect(await response.json()).toEqual({
			error: "rate_limited",
			message: "Chat usage limit reached. Try again later.",
			requestId: "request-123",
		});
	});
});

describe("Clef routing decisions", () => {
	const emptyWeights = { simple: 0, complex: 0, tool: 0 };

	it.each([
		["simple", 0.9],
		["complex", 0.8],
		["tool", 0.95],
	] as const)("accepts a confident %s decision", (route, confidence) => {
		expect(
			parseRouteDecision({
				answers: {
					route: {
						choice: route,
						confidence,
						probabilities: emptyWeights,
					},
				},
			}),
		).toEqual({ route, confidence, weights: emptyWeights });
	});

	it("falls back to complex when confidence is low", () => {
		expect(
			parseRouteDecision({
				answers: {
					route: {
						choice: "simple",
						confidence: 0.4,
						probabilities: emptyWeights,
					},
				},
			}),
		).toEqual({
			route: "complex",
			confidence: 0.4,
			weights: emptyWeights,
		});
	});

	it("uses route-specific open-weight model pools", () => {
		expect(
			modelsForDecision({
				route: "simple",
				confidence: 0.9,
				weights: emptyWeights,
			}),
		).toContain("@cf/openai/gpt-oss-20b");
		expect(
			modelsForDecision({
				route: "tool",
				confidence: 0.9,
				weights: emptyWeights,
			}),
		).toEqual([
			"@cf/google/gemma-4-26b-a4b-it",
			"@cf/moonshotai/kimi-k2.7-code",
			"@cf/nvidia/nemotron-3-120b-a12b",
		]);
	});
});