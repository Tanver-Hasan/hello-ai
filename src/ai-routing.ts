export const MODEL = "cloudflare/auto";
export const DECISION_MODEL = "@cf/cloudflare/clef-flash";
export const SIMPLE_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/openai/gpt-oss-20b",
];
export const COMPLEX_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/moonshotai/kimi-k2.7-code",
	"@cf/qwen/qwen3.8-27b",
	"@cf/zai-org/glm-5.2",
];
export const TOOL_MODELS = [
	"@cf/google/gemma-4-26b-a4b-it",
	"@cf/moonshotai/kimi-k2.7-code",
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

export function autoRouterHeaders(
	requestId: string,
	allowedModels: string[],
): Record<string, string> {
	return {
		"cf-aig-session-id": requestId,
		"cf-aig-turn-id": requestId,
		"cf-aig-allowed-models": allowedModels.join(","),
	};
}

export function aiGatewayOptions(
	gatewayId: string,
	requestId: string,
	phase: string,
	allowedModels: string[] = COMPLEX_MODELS,
	feature = "durable_chat",
): AiOptions {
	return {
		gateway: {
			id: gatewayId,
			skipCache: true,
			collectLog: true,
			metadata: {
				requestId,
				feature,
				phase,
			},
		},
		extraHeaders: autoRouterHeaders(requestId, allowedModels),
	};
}

export function decisionGatewayOptions(
	gatewayId: string,
	requestId: string,
	feature = "durable_chat",
): AiOptions {
	return {
		gateway: {
			id: gatewayId,
			skipCache: true,
			collectLog: true,
			metadata: {
				requestId,
				feature,
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
