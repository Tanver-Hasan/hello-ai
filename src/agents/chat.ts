import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
	convertToModelMessages,
	jsonSchema,
	stepCountIs,
	streamText,
	tool,
	type GenerateTextOnFinishCallback,
	type ToolSet,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { type Connection, type ConnectionContext } from "agents";
import {
	DECISION_MODEL,
	MODEL,
	aiGatewayOptions,
	autoRouterHeaders,
	decisionGatewayOptions,
	modelsForDecision,
	parseRouteDecision,
} from "../ai-routing";
import { addNumbers } from "../tools/calculator";
import { isReadonlyAgentRequest } from "./edgeword";

const calculator = tool({
	description: "Add two finite numbers and return their exact sum.",
	inputSchema: jsonSchema<{ a: number; b: number }>({
		type: "object",
		properties: {
			a: { type: "number" },
			b: { type: "number" },
		},
		required: ["a", "b"],
		additionalProperties: false,
	}),
	execute: ({ a, b }) => addNumbers({ a, b }),
});

function latestUserText(
	messages: EdgewordChatAgent["messages"],
): string {
	const message = [...messages].reverse().find(({ role }) => role === "user");
	if (!message) return "";
	return message.parts
		.filter(
			(part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
				part.type === "text",
		)
		.map(({ text }) => text)
		.join("\n")
		.trim();
}

export class EdgewordChatAgent extends AIChatAgent<Env> {
	override maxPersistedMessages = 40;

	override shouldConnectionBeReadonly(
		_connection: Connection,
		context: ConnectionContext,
	): boolean {
		return isReadonlyAgentRequest(context.request);
	}

	override async onChatMessage(
		onFinish: GenerateTextOnFinishCallback<ToolSet>,
		options?: OnChatMessageOptions,
	): Promise<Response> {
		const requestId = options?.requestId ?? crypto.randomUUID();
		const prompt = latestUserText(this.messages);
		if (!prompt || prompt.length > 4_000) {
			return Response.json({ error: "Invalid prompt" }, { status: 400 });
		}

		const decisionResponse = await this.env.AI.run(
			DECISION_MODEL,
			{
				model: "clef-flash",
				state: {
					prompt,
					recentMessages: this.messages.slice(-4),
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
			decisionGatewayOptions(
				this.env.AI_GATEWAY_ID,
				requestId,
				"agent_chat",
			),
		);
		const decision = parseRouteDecision(decisionResponse);
		const allowedModels = modelsForDecision(decision);
		const optionsForGateway = aiGatewayOptions(
			this.env.AI_GATEWAY_ID,
			requestId,
			"agent_response",
			allowedModels,
			"agent_chat",
		);
		const workersai = createWorkersAI({ binding: this.env.AI });
		const model = workersai(MODEL, {
			gateway: optionsForGateway.gateway,
			extraHeaders: autoRouterHeaders(requestId, allowedModels),
		});

		const conversationId = this.name.startsWith("agent-")
			? this.name.slice("agent-".length)
			: this.name;
		this.ctx.waitUntil(
			this.env.EdgewordAgent.getByName(conversationId).recordRouting({
				requestId,
				decision: decision.route,
				confidence: decision.confidence,
				model: MODEL,
				cost: 0,
				weights: decision.weights,
				candidateModels: allowedModels,
			}),
		);

		const result = streamText({
			model,
			system:
				"You are the Edgeword learning assistant. Explain clearly and use addNumbers for exact arithmetic addition.",
			messages: await convertToModelMessages(this.messages),
			tools: decision.route === "tool" ? { addNumbers: calculator } : undefined,
			stopWhen: stepCountIs(3),
			abortSignal: options?.abortSignal,
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}
}
