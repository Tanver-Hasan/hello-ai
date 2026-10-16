import { addNumbers } from "./tools/calculator";

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const MODEL = "cloudflare/auto";
const DECISION_MODEL = "@cf/cloudflare/clef-flash";
const NVIDIA_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";
const SIMPLE_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/openai/gpt-oss-20b",
];
const COMPLEX_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/moonshotai/kimi-k2.7-code",
	"@cf/qwen/qwen3.8-27b",
	"@cf/zai-org/glm-5.2",
	NVIDIA_MODEL,
];
const TOOL_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/moonshotai/kimi-k2.7-code",
	NVIDIA_MODEL,
];
const MIN_DECISION_CONFIDENCE = 0.65;

export type RouteDecision = {
	route: "simple" | "complex" | "tool";
	confidence: number;
	weights: {
		simple: number;
		complex: number;
		tool: number;
	};
};

const CALCULATOR_TOOL: ChatCompletionTool = {
	type: "function",
	function: {
		name: "addNumbers",
		description: "Add two finite numbers and return their exact sum.",
		parameters: {
			type: "object",
			properties: {
				a: {
					type: "number",
					description: "The first number",
				},
				b: {
					type: "number",
					description: "The second number",
				},
			},
			required: ["a", "b"],
		},
	},
};

type ClientMessage = {
	role: "user" | "assistant";
	content: string;
};

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_BODY_BYTES = 16_384;

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

		messages.push({
			role: item.role,
			content,
		});
	}

	if (messages.at(-1)?.role !== "user") {
		return "the final message must have role user";
	}

	return messages;
}
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conversationRoute(pathname: string) {
	const match = pathname.match(
		/^\/conversations\/([^/]+)\/(messages|chat\/stream|chat\/protected)$/,
	);

	if (!match || !UUID.test(match[1])) {
		return null;
	}

	return {
		id: match[1],
		action: match[2] as "messages" | "chat/stream" | "chat/protected",
	};
}

function parsePrompt(body: unknown): string {
	if (
		typeof body !== "object" ||
		body === null ||
		!("prompt" in body) ||
		typeof body.prompt !== "string"
	) {
		return "";
	}

	return body.prompt.trim();
}

async function readJsonBody(
	request: Request,
): Promise<
	| { ok: true; body: unknown }
	| { ok: false; response: Response }
> {
	const declaredSize = Number(request.headers.get("Content-Length") ?? "0");
	if (declaredSize > MAX_BODY_BYTES) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Request body too large" },
				{ status: 413 },
			),
		};
	}

	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
		return {
			ok: false,
			response: Response.json(
				{ error: "Request body too large" },
				{ status: 413 },
			),
		};
	}

	try {
		return { ok: true, body: JSON.parse(text) };
	} catch {
		return { ok: true, body: null };
	}
}

function clientKey(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "local";
}

async function enforceRateLimit(
	limiter: RateLimit,
	key: string,
): Promise<Response | null> {
	const result = await limiter.limit({ key });
	if (result.success) return null;

	return Response.json(
		{
			error: "rate_limited",
			message: "Too many requests. Try again later.",
		},
		{
			status: 429,
			headers: {
				"Cache-Control": "no-store",
				"Retry-After": "60",
			},
		},
	);
}

export function aiEventText(event: unknown): string {
	if (typeof event !== "object" || event === null) {
		return "";
	}

	if ("response" in event && typeof event.response === "string") {
		return event.response;
	}

	if (
		"result" in event &&
		typeof event.result === "object" &&
		event.result !== null &&
		"response" in event.result &&
		typeof event.result.response === "string"
	) {
		return event.result.response;
	}

	if ("choices" in event && Array.isArray(event.choices)) {
		const choice = event.choices[0];
		if (
			typeof choice === "object" &&
			choice !== null &&
			"delta" in choice &&
			typeof choice.delta === "object" &&
			choice.delta !== null &&
			"content" in choice.delta &&
			typeof choice.delta.content === "string"
		) {
			return choice.delta.content;
		}
	}

	return "";
}

async function collectAiText(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
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
				const event: unknown = JSON.parse(payload);
				text += aiEventText(event);
			}

			boundary = buffer.indexOf("\n\n");
		}

		if (done) {
			return text;
		}
	}
}

export function aiGatewayOptions(
	gatewayId: string,
	requestId: string,
	phase: string,
	allowedModels: string[] = COMPLEX_MODELS,
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
			"cf-aig-allowed-models": allowedModels.join(","),
		},
	};
}

function decisionGatewayOptions(
	gatewayId: string,
	requestId: string,
): AiOptions {
	return {
		gateway: {
			id: gatewayId,
			skipCache: true,
			collectLog: true,
			metadata: {
				requestId,
				feature: "durable_chat",
				phase: "clef_decision",
			},
		},
	};
}

export function parseRouteDecision(response: unknown): RouteDecision {
	const fallback = {
		route: "complex" as const,
		confidence: 0,
		weights: { simple: 0, complex: 0, tool: 0 },
	};
	if (
		typeof response !== "object" ||
		response === null ||
		!("answers" in response) ||
		typeof response.answers !== "object" ||
		response.answers === null ||
		!("route" in response.answers) ||
		typeof response.answers.route !== "object" ||
		response.answers.route === null
	) {
		return fallback;
	}

	const answer = response.answers.route;
	const route =
		"choice" in answer &&
		(answer.choice === "simple" ||
			answer.choice === "complex" ||
			answer.choice === "tool")
			? answer.choice
			: "complex";
	const confidence =
		"confidence" in answer && typeof answer.confidence === "number"
			? answer.confidence
			: 0;
	const probabilities =
		"probabilities" in answer &&
		typeof answer.probabilities === "object" &&
		answer.probabilities !== null
			? answer.probabilities
			: {};
	const weights = {
		simple:
			"simple" in probabilities && typeof probabilities.simple === "number"
				? probabilities.simple
				: 0,
		complex:
			"complex" in probabilities && typeof probabilities.complex === "number"
				? probabilities.complex
				: 0,
		tool:
			"tool" in probabilities && typeof probabilities.tool === "number"
				? probabilities.tool
				: 0,
	};

	return confidence >= MIN_DECISION_CONFIDENCE
		? { route, confidence, weights }
		: { route: "complex", confidence, weights };
}

export function modelsForDecision(decision: RouteDecision): string[] {
	if (decision.route === "simple") return SIMPLE_MODELS;
	if (decision.route === "tool") return TOOL_MODELS;
	return COMPLEX_MODELS;
}

async function decideRoute(
	ai: Ai,
	prompt: string,
	recentMessages: ChatCompletionMessageParam[],
	gatewayId: string,
	requestId: string,
): Promise<{ decision: RouteDecision; logIds: string[] }> {
	const response = await ai.run(
		DECISION_MODEL,
		{
			model: "clef-flash",
			state: {
				prompt,
				recentMessages: recentMessages.slice(-4),
			},
			questions: {
				route: {
					type: "choice",
					instructions:
						"Choose the minimum capability needed to answer the latest user request.",
					criteria: {
						simple:
							"Basic factual, explanatory, or conversational response with little reasoning.",
						complex:
							"Substantial technical analysis, multi-step reasoning, or difficult synthesis.",
						tool: "Exact arithmetic addition requiring the addNumbers tool.",
					},
				},
			},
		},
		decisionGatewayOptions(gatewayId, requestId),
	);

	return {
		decision: parseRouteDecision(response),
		logIds: ai.aiGatewayLogId ? [ai.aiGatewayLogId] : [],
	};
}

function captureGatewayLogId(ai: Ai, logIds: string[]): void {
	if (ai.aiGatewayLogId && !logIds.includes(ai.aiGatewayLogId)) {
		logIds.push(ai.aiGatewayLogId);
	}
}

type RoutedToolCall = {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
};

type RoutedAssistantMessage = {
	content: string | null;
	toolCalls: RoutedToolCall[];
	model: string;
};

export function chatAssistantMessage(
	response: unknown,
): RoutedAssistantMessage | null {
	if (
		typeof response !== "object" ||
		response === null ||
		!("choices" in response) ||
		!Array.isArray(response.choices)
	) {
		return null;
	}

	const choice = response.choices[0];
	if (
		typeof choice !== "object" ||
		choice === null ||
		!("message" in choice) ||
		typeof choice.message !== "object" ||
		choice.message === null
	) {
		return null;
	}

	const message = choice.message;
	const model =
		"model" in response && typeof response.model === "string"
			? response.model
			: MODEL;
	const content =
		"content" in message &&
		(typeof message.content === "string" || message.content === null)
			? message.content
			: null;
	const rawCalls =
		"tool_calls" in message && Array.isArray(message.tool_calls)
			? message.tool_calls
			: [];
	const toolCalls: RoutedToolCall[] = [];

	for (const call of rawCalls) {
		if (
			typeof call !== "object" ||
			call === null ||
			!("id" in call) ||
			typeof call.id !== "string" ||
			!("type" in call) ||
			call.type !== "function" ||
			!("function" in call) ||
			typeof call.function !== "object" ||
			call.function === null ||
			!("name" in call.function) ||
			typeof call.function.name !== "string" ||
			!("arguments" in call.function) ||
			typeof call.function.arguments !== "string"
		) {
			return null;
		}

		toolCalls.push({
			id: call.id,
			type: "function",
			function: {
				name: call.function.name,
				arguments: call.function.arguments,
			},
		});
	}

	return { content, toolCalls, model };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return value instanceof ReadableStream;
}

export function isRateLimitError(error: unknown): boolean {
	const candidates: unknown[] = [error];
	if (typeof error === "object" && error !== null && "cause" in error) {
		candidates.push(error.cause);
	}

	for (const candidate of candidates) {
		if (typeof candidate !== "object" || candidate === null) {
			continue;
		}

		for (const key of ["status", "statusCode", "httpStatus"]) {
			const value: unknown = Reflect.get(candidate, key);
			if (Number(value) === 429) {
				return true;
			}
		}

		for (const key of ["code", "errorCode"]) {
			const value: unknown = Reflect.get(candidate, key);
			if (
				[429, 3036, 3040].includes(Number(value))
			) {
				return true;
			}
		}
	}

	return false;
}

export function inferenceErrorResponse(
	error: unknown,
	requestId: string,
): Response {
	const rateLimited = isRateLimitError(error);
	return Response.json(
		rateLimited
			? {
					error: "rate_limited",
					message: "Chat usage limit reached. Try again later.",
					requestId,
				}
			: {
					error: "inference_failed",
					message: "AI inference failed.",
					requestId,
				},
		{
			status: rateLimited ? 429 : 502,
			headers: {
				"Cache-Control": "no-store",
				"X-Request-ID": requestId,
			},
		},
	);
}

async function runChatWithCalculator(
	ai: Ai,
	messages: ChatCompletionMessageParam[],
	gatewayId: string,
	requestId: string,
	decision: RouteDecision,
	logIds: string[],
): Promise<{
	stream: ReadableStream<Uint8Array>;
	routedModel: string;
	decision: RouteDecision;
	logIds: string[];
}> {
	const allowedModels = modelsForDecision(decision);
	if (decision.route !== "tool") {
		const stream: unknown = await ai.run(
			MODEL,
			{
				messages,
				stream: true,
			},
			aiGatewayOptions(
				gatewayId,
				requestId,
				`${decision.route}_response`,
				allowedModels,
			),
		);
		if (!isReadableStream(stream)) {
			throw new Error("Auto Router did not return a stream");
		}
		captureGatewayLogId(ai, logIds);
		return { stream, routedModel: MODEL, decision, logIds };
	}

	const response = await ai.run(
		MODEL,
		{
			messages,
			tools: [CALCULATOR_TOOL],
			tool_choice: "auto",
			parallel_tool_calls: false,
		},
		aiGatewayOptions(
			gatewayId,
			requestId,
			"tool_selection",
			allowedModels,
		),
	);
	const assistantMessage = chatAssistantMessage(response);
	captureGatewayLogId(ai, logIds);
	if (!assistantMessage) {
		throw new Error("Workers AI returned no response");
	}
	const calls = assistantMessage.toolCalls;

	if (calls.length === 0) {
		const stream: unknown = await ai.run(
			MODEL,
			{
				messages,
				stream: true,
			},
				aiGatewayOptions(
					gatewayId,
					requestId,
					"direct_response",
					allowedModels,
				),
		);
		if (!isReadableStream(stream)) {
			throw new Error("Auto Router did not return a stream");
		}
		captureGatewayLogId(ai, logIds);
		return { stream, routedModel: assistantMessage.model, decision, logIds };
	}
	if (calls.length > 2) {
		throw new Error("Too many calculator calls");
	}

	const toolMessages: ToolMessage[] = [];
	for (const call of calls) {
		if (call.type !== "function" || call.function.name !== "addNumbers") {
			throw new Error("Unsupported tool call");
		}

		toolMessages.push({
			role: "tool",
			tool_call_id: call.id,
			content: await addNumbers(JSON.parse(call.function.arguments)),
		});
	}

	const assistantToolMessage: AssistantMessage = {
		role: "assistant",
		content: assistantMessage.content,
		tool_calls: calls,
	};

	const stream: unknown = await ai.run(
		MODEL,
		{
			messages: [
				...messages,
				assistantToolMessage,
				...toolMessages,
			],
			stream: true,
		},
		aiGatewayOptions(gatewayId, requestId, "tool_response", allowedModels),
	);
	if (!isReadableStream(stream)) {
		throw new Error("Auto Router did not return a stream");
	}
	captureGatewayLogId(ai, logIds);
	return { stream, routedModel: assistantMessage.model, decision, logIds };
}

async function runProtectedChat(
	ai: Ai,
	messages: ChatCompletionMessageParam[],
	gatewayId: string,
	requestId: string,
	decision: RouteDecision,
	logIds: string[],
): Promise<{
	content: string;
	routedModel: string;
	decision: RouteDecision;
	logIds: string[];
}> {
	const allowedModels = modelsForDecision(decision);
	if (decision.route !== "tool") {
		const response = await ai.run(
			MODEL,
			{ messages },
			aiGatewayOptions(
				gatewayId,
				requestId,
				`protected_${decision.route}_response`,
				allowedModels,
			),
		);
		const assistantMessage = chatAssistantMessage(response);
		captureGatewayLogId(ai, logIds);
		if (!assistantMessage) {
			throw new Error("Workers AI returned no response");
		}
		return {
			content: assistantMessage.content ?? "",
			routedModel: assistantMessage.model,
			decision,
			logIds,
		};
	}

	const response = await ai.run(
		MODEL,
		{
			messages,
			tools: [CALCULATOR_TOOL],
			tool_choice: "auto",
			parallel_tool_calls: false,
		},
		aiGatewayOptions(
			gatewayId,
			requestId,
			"protected_tool_selection",
			allowedModels,
		),
	);
	const assistantMessage = chatAssistantMessage(response);
	captureGatewayLogId(ai, logIds);
	if (!assistantMessage) {
		throw new Error("Workers AI returned no response");
	}
	const calls = assistantMessage.toolCalls;

	if (calls.length === 0) {
		return {
			content: assistantMessage.content ?? "",
			routedModel: assistantMessage.model,
			decision,
			logIds,
		};
	}
	if (calls.length > 2) {
		throw new Error("Too many calculator calls");
	}

	const toolMessages: ToolMessage[] = [];
	for (const call of calls) {
		if (call.type !== "function" || call.function.name !== "addNumbers") {
			throw new Error("Unsupported tool call");
		}

		toolMessages.push({
			role: "tool",
			tool_call_id: call.id,
			content: await addNumbers(JSON.parse(call.function.arguments)),
		});
	}

	const assistantToolMessage: AssistantMessage = {
		role: "assistant",
		content: assistantMessage.content,
		tool_calls: calls,
	};
	const finalResponse = await ai.run(
		MODEL,
		{
			messages: [...messages, assistantToolMessage, ...toolMessages],
		},
		aiGatewayOptions(
			gatewayId,
			requestId,
			"protected_tool_response",
			allowedModels,
		),
	);
	captureGatewayLogId(ai, logIds);

	return {
		content: chatAssistantMessage(finalResponse)?.content ?? "",
		routedModel: assistantMessage.model,
		decision,
		logIds,
	};
}

function sanitizeGatewayLog(log: AiGatewayLog) {
	const guardrails: unknown = Reflect.get(log, "guardrails");
	const dlpAction: unknown = Reflect.get(log, "dlp_action");
	const dlpProfiles: unknown = Reflect.get(log, "dlp_profiles");

	return {
		id: log.id,
		phase:
			typeof log.metadata?.phase === "string" ? log.metadata.phase : "unknown",
		provider: log.provider,
		model: log.model,
		success: log.success,
		statusCode: log.status_code,
		durationMs: log.duration,
		tokensIn: log.tokens_in ?? 0,
		tokensOut: log.tokens_out ?? 0,
		cost: log.cost ?? 0,
		cached: log.cached,
		guardrails:
			typeof guardrails === "object" && guardrails !== null
				? guardrails
				: null,
		dlpAction: typeof dlpAction === "string" ? dlpAction : null,
		dlpProfiles: Array.isArray(dlpProfiles) ? dlpProfiles : [],
	};
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const requestId = crypto.randomUUID();
		const actor = clientKey(request);

		if (request.method === "GET" && url.pathname === "/telemetry") {
			const rateLimit = await enforceRateLimit(
				env.STORAGE_RATE_LIMITER,
				`telemetry:${actor}`,
			);
			if (rateLimit) return rateLimit;

			const gateway =
				url.searchParams.get("gateway") === "protected"
					? env.AI_PROTECTED_GATEWAY_ID
					: env.AI_GATEWAY_ID;
			const logIds = (url.searchParams.get("logs") ?? "")
				.split(",")
				.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
				.slice(0, 4);

			const logs = await Promise.all(
				logIds.map(async (logId) => {
					try {
						return sanitizeGatewayLog(
							await env.AI.gateway(gateway).getLog(logId),
						);
					} catch {
						return null;
					}
				}),
			);

			return Response.json(
				{ gateway, logs: logs.filter((log) => log !== null) },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}

		if (request.method === "GET" && url.pathname === "/models") {
			return Response.json(
				{
					decisionModels: [
						{
							id: DECISION_MODEL,
							name: "Clef Flash",
							purpose: "Classifies each request as simple, complex, or tool.",
						},
					],
					router: {
						id: MODEL,
						name: "Cloudflare Auto Router",
						purpose:
							"Selects the final eligible open-weight model from the Clef-selected pool.",
					},
					pools: {
						simple: SIMPLE_MODELS,
						complex: COMPLEX_MODELS,
						tool: TOOL_MODELS,
					},
				},
				{ headers: { "Cache-Control": "public, max-age=300" } },
			);
		}

		if (request.method === "GET" && url.pathname === "/") {
			return Response.json({
				name: "hello-ai",
				endpoints: [
					"POST /chat",
					"POST /chat/stream",
					"GET /conversations/:id/messages",
					"POST /conversations/:id/chat/stream",
					"POST /conversations/:id/chat/protected",
					"DELETE /conversations/:id",
				],
			});
		}

		const route = conversationRoute(url.pathname);
		if (route?.action === "messages") {
			if (request.method !== "GET") {
				return Response.json(
					{ error: "Method not allowed" },
					{ status: 405, headers: { Allow: "GET" } },
				);
			}

			const rateLimit = await enforceRateLimit(
				env.STORAGE_RATE_LIMITER,
				`history:${actor}`,
			);
			if (rateLimit) return rateLimit;

			const conversation = env.CONVERSATIONS.getByName(route.id);
			return Response.json({
				messages: await conversation.listMessages(),
			});
		}

		if (route?.action === "chat/protected") {
			if (request.method !== "POST") {
				return Response.json(
					{ error: "Method not allowed" },
					{ status: 405, headers: { Allow: "POST" } },
				);
			}

			const rateLimit = await enforceRateLimit(
				env.CHAT_RATE_LIMITER,
				`chat:${actor}`,
			);
			if (rateLimit) return rateLimit;
			const parsedBody = await readJsonBody(request);
			if (!parsedBody.ok) return parsedBody.response;
			const prompt = parsePrompt(parsedBody.body);
			if (!prompt || prompt.length > MAX_MESSAGE_LENGTH) {
				return Response.json({ error: "Invalid prompt" }, { status: 400 });
			}

			const conversation = env.CONVERSATIONS.getByName(route.id);
			await conversation.appendMessage("user", prompt);
			const history = await conversation.listMessages();

			try {
				const modelMessages: ChatCompletionMessageParam[] = [
					{
						role: "system",
						content:
							"You are a helpful assistant. Use addNumbers whenever arithmetic addition is required.",
					},
					...history
						.slice(-MAX_MESSAGES)
						.map(({ role, content }) => ({ role, content })),
				];
				const { decision, logIds } = await decideRoute(
					env.AI,
					prompt,
					modelMessages,
					env.AI_PROTECTED_GATEWAY_ID,
					requestId,
				);
				const { content, routedModel } = await runProtectedChat(
					env.AI,
					modelMessages,
					env.AI_PROTECTED_GATEWAY_ID,
					requestId,
					decision,
					logIds,
				);

				if (content.trim()) {
					await conversation.appendMessage("assistant", content);
				}

				return Response.json(
					{
						response: content,
						requestId,
						model: routedModel,
						decision,
						candidateModels: modelsForDecision(decision),
						telemetryLogIds: logIds,
					},
					{
						headers: {
							"Cache-Control": "no-store",
							"X-Request-ID": requestId,
							"X-AI-Gateway": env.AI_PROTECTED_GATEWAY_ID,
							"X-Routed-Model": routedModel,
							"X-Route-Decision": decision.route,
							"X-Route-Confidence": String(decision.confidence),
							"X-Route-Weights": JSON.stringify(decision.weights),
							"X-Candidate-Models": modelsForDecision(decision).join(","),
							"X-Telemetry-Log-Ids": logIds.join(","),
						},
					},
				);
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "protected_inference_failed",
						conversationId: route.id,
						message: error instanceof Error ? error.message : "Unknown error",
					}),
				);
				return inferenceErrorResponse(error, requestId);
			}
		}

		if (route?.action === "chat/stream") {
			if (request.method !== "POST") {
				return Response.json(
					{ error: "Method not allowed" },
					{ status: 405, headers: { Allow: "POST" } },
				);
			}

			const rateLimit = await enforceRateLimit(
				env.CHAT_RATE_LIMITER,
				`chat:${actor}`,
			);
			if (rateLimit) return rateLimit;
			const parsedBody = await readJsonBody(request);
			if (!parsedBody.ok) return parsedBody.response;
			const prompt = parsePrompt(parsedBody.body);
			if (!prompt || prompt.length > MAX_MESSAGE_LENGTH) {
				return Response.json({ error: "Invalid prompt" }, { status: 400 });
			}

			const conversation = env.CONVERSATIONS.getByName(route.id);
			await conversation.appendMessage("user", prompt);
			const history = await conversation.listMessages();

			try {
				const modelMessages: ChatCompletionMessageParam[] = [
					{
						role: "system",
						content:
							"You are a helpful assistant. Use addNumbers whenever arithmetic addition is required.",
					},
					...history
						.slice(-MAX_MESSAGES)
						.map(({ role, content }) => ({ role, content })),
				];
				const { decision, logIds } = await decideRoute(
					env.AI,
					prompt,
					modelMessages,
					env.AI_GATEWAY_ID,
					requestId,
				);
				const { stream, routedModel } = await runChatWithCalculator(
					env.AI,
					modelMessages,
					env.AI_GATEWAY_ID,
					requestId,
					decision,
					logIds,
				);

				const [clientStream, persistenceStream] = stream.tee();
				ctx.waitUntil(
					collectAiText(persistenceStream)
						.then(async (content) => {
							if (content.trim()) {
								await conversation.appendMessage("assistant", content);
							}
						})
						.catch((error) => {
							console.error(
								JSON.stringify({
									event: "conversation_persistence_failed",
									conversationId: route.id,
									message:
										error instanceof Error ? error.message : "Unknown error",
								}),
							);
						}),
				);

				return new Response(clientStream, {
					headers: {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						"Content-Encoding": "identity",
						"X-Request-ID": requestId,
						"X-AI-Gateway": env.AI_GATEWAY_ID,
						"X-Routed-Model": routedModel,
						"X-Route-Decision": decision.route,
						"X-Route-Confidence": String(decision.confidence),
						"X-Route-Weights": JSON.stringify(decision.weights),
						"X-Candidate-Models": modelsForDecision(decision).join(","),
						"X-Telemetry-Log-Ids": logIds.join(","),
					},
				});
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "ai_inference_failed",
						conversationId: route.id,
						message: error instanceof Error ? error.message : "Unknown error",
					}),
				);
				return inferenceErrorResponse(error, requestId);
			}
		}

		const deleteMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);
		if (deleteMatch && UUID.test(deleteMatch[1])) {
			if (request.method !== "DELETE") {
				return Response.json(
					{ error: "Method not allowed" },
					{ status: 405, headers: { Allow: "DELETE" } },
				);
			}

			const rateLimit = await enforceRateLimit(
				env.STORAGE_RATE_LIMITER,
				`delete:${actor}`,
			);
			if (rateLimit) return rateLimit;

			const conversation = env.CONVERSATIONS.getByName(deleteMatch[1]);
			await conversation.deleteConversation();
			return new Response(null, { status: 204 });
		}

		if (url.pathname !== "/chat" && url.pathname !== "/chat/stream") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}

		if (request.method !== "POST") {
			return Response.json(
				{ error: "Method not allowed" },
				{
					status: 405,
					headers: { Allow: "POST" },
				},
			);
		}

		const rateLimit = await enforceRateLimit(
			env.CHAT_RATE_LIMITER,
			`legacy:${actor}`,
		);
		if (rateLimit) return rateLimit;
		const parsedBody = await readJsonBody(request);
		if (!parsedBody.ok) return parsedBody.response;
		const parsed = parseMessages(parsedBody.body);
		if (typeof parsed === "string") {
			return Response.json({ error: parsed }, { status: 400 });
		}
		const messages = parsed;

		if (url.pathname === "/chat") {
			// TODO: Implement streaming response

			try {
				const response = await env.AI.run(
					MODEL,
					{
							messages: [
								{ role: "system", content: "You are a helpful assistant." },
								...messages,
							],
						},
					aiGatewayOptions(env.AI_GATEWAY_ID, requestId, "legacy_response"),
				);

				return Response.json(response);
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "ai_inference_failed",
						message: error instanceof Error ? error.message : "Unknown error",
					}),
				);
				return inferenceErrorResponse(error, requestId);
			}
		}

		if (url.pathname === "/chat/stream") {
			try {
					const stream: unknown = await env.AI.run(
						MODEL,
					{
						messages: [
							{ role: "system", content: "You are a helpful assistant." },
								...messages,
							],
							stream: true,
						},
					aiGatewayOptions(env.AI_GATEWAY_ID, requestId, "legacy_stream"),
					);
					if (!isReadableStream(stream)) {
						throw new Error("Auto Router did not return a stream");
					}

					return new Response(stream, {
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
					},
				});
				// TODO: Implement streaming response
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "ai_inference_failed",
						message: error instanceof Error ? error.message : "Unknown error",
					}),
				);
				return inferenceErrorResponse(error, requestId);
			}
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	}
} satisfies ExportedHandler<Env>;

export { Conversation } from "./conversation";