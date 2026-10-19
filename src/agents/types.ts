export type EdgewordState = {
	mode: "stream" | "protected";
	turnCount: number;
	lastDecision?: "simple" | "complex" | "tool";
	lastModel?: string;
};

export type RoutingSnapshot = {
	requestId: string;
	decision: "simple" | "complex" | "tool";
	confidence: number;
	model: string;
	cost: number;
	weights?: {
		simple: number;
		complex: number;
		tool: number;
	};
	candidateModels?: string[];
};

export type ConversationAgentState = EdgewordState & {
	traceVisible?: boolean;
	lastRouting?: RoutingSnapshot;
	version?: number;
};

export type RoutingEvent = RoutingSnapshot & {
	createdAt: number;
};