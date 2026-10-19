import {
	Agent,
	callable,
	type Connection,
	type ConnectionContext,
} from "agents";
import type {
	ConversationAgentState,
	EdgewordState,
	RoutingEvent,
	RoutingSnapshot,
} from "./types";

export type {
	ConversationAgentState,
	EdgewordState,
	RoutingEvent,
	RoutingSnapshot,
} from "./types";

type RoutingEventRow = {
	request_id: string;
	decision: RoutingSnapshot["decision"];
	confidence: number;
	model: string;
	cost: number;
	created_at: number;
};

export function isReadonlyAgentRequest(request: Request): boolean {
	const url = new URL(request.url);
	if (url.searchParams.get("role") === "viewer") return true;

	const local =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "::1";
	return !local && !request.headers.has("Cf-Access-Jwt-Assertion");
}

export class EdgewordAgent extends Agent<Env, ConversationAgentState> {
	override initialState: ConversationAgentState = {
		mode: "stream",
		turnCount: 0,
		traceVisible: true,
		version: 0,
	};

	override onStart(): void {
		this.ensureRoutingSchema();

		if (
			this.state.traceVisible === undefined ||
			this.state.version === undefined
		) {
			this.setState(this.normalizedState());
		}
	}

	private ensureRoutingSchema(): void {
		this.sql`
			CREATE TABLE IF NOT EXISTS routing_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				request_id TEXT NOT NULL UNIQUE,
				decision TEXT NOT NULL,
				confidence REAL NOT NULL,
				model TEXT NOT NULL,
				cost REAL NOT NULL,
				created_at INTEGER NOT NULL
			)
		`;
	}

	private normalizedState(): ConversationAgentState {
		return {
			...this.state,
			traceVisible: this.state.traceVisible ?? true,
			version: this.state.version ?? 0,
		};
	}

	override validateStateChange(
		nextState: ConversationAgentState,
		_source: Connection | "server",
	): void {
		if (nextState.mode !== "stream" && nextState.mode !== "protected") {
			throw new Error("Invalid mode");
		}
		if (!Number.isInteger(nextState.turnCount) || nextState.turnCount < 0) {
			throw new Error("Invalid turn count");
		}
		if (
			nextState.version !== undefined &&
			(!Number.isInteger(nextState.version) || nextState.version < 0)
		) {
			throw new Error("Invalid version");
		}
		if (
			nextState.traceVisible !== undefined &&
			typeof nextState.traceVisible !== "boolean"
		) {
			throw new Error("Invalid trace visibility");
		}
		if (
			nextState.lastDecision !== undefined &&
			!["simple", "complex", "tool"].includes(nextState.lastDecision)
		) {
			throw new Error("Invalid routing decision");
		}
		if (
			nextState.lastModel !== undefined &&
			(!nextState.lastModel || nextState.lastModel.length > 200)
		) {
			throw new Error("Invalid model");
		}

		if (nextState.lastRouting) {
			this.validateRoutingSnapshot(nextState.lastRouting);
		}
	}

	private validateRoutingSnapshot(snapshot: RoutingSnapshot): void {
		if (!snapshot.requestId || snapshot.requestId.length > 100) {
			throw new Error("Invalid routing request ID");
		}
		if (!["simple", "complex", "tool"].includes(snapshot.decision)) {
			throw new Error("Invalid routing decision");
		}
		if (
			!Number.isFinite(snapshot.confidence) ||
			snapshot.confidence < 0 ||
			snapshot.confidence > 1
		) {
			throw new Error("Invalid routing confidence");
		}
		if (!snapshot.model || snapshot.model.length > 200) {
			throw new Error("Invalid routing model");
		}
		if (!Number.isFinite(snapshot.cost) || snapshot.cost < 0) {
			throw new Error("Invalid routing cost");
		}
		if (
			snapshot.weights &&
			Object.values(snapshot.weights).some(
				(weight) =>
					!Number.isFinite(weight) || weight < 0 || weight > 1,
			)
		) {
			throw new Error("Invalid routing weights");
		}
		if (
			snapshot.candidateModels &&
			(snapshot.candidateModels.length > 10 ||
				snapshot.candidateModels.some(
					(model) => !model || model.length > 200,
				))
		) {
			throw new Error("Invalid candidate models");
		}
	}

	override shouldConnectionBeReadonly(
		_connection: Connection,
		context: ConnectionContext,
	): boolean {
		return isReadonlyAgentRequest(context.request);
	}

	@callable()
	setMode(mode: EdgewordState["mode"]): ConversationAgentState {
		const current = this.normalizedState();
		this.setState({
			...current,
			mode,
			version: (current.version ?? 0) + 1,
		});
		return this.state;
	}

	@callable()
	setPreferences(
		mode: ConversationAgentState["mode"],
		traceVisible: boolean,
		expectedVersion: number,
	): ConversationAgentState {
		const current = this.normalizedState();
		if (expectedVersion !== current.version) {
			throw new Error("State changed; reload and retry");
		}

		this.setState({
			...current,
			mode,
			traceVisible,
			version: (current.version ?? 0) + 1,
		});

		return this.state;
	}

	recordRouting(snapshot: RoutingSnapshot): ConversationAgentState {
		this.ensureRoutingSchema();
		this.validateRoutingSnapshot(snapshot);
		const existing = this.sql<{ id: number }>`
			SELECT id FROM routing_events
			WHERE request_id = ${snapshot.requestId}
			LIMIT 1
		`;
		if (existing.length > 0) return this.state;

		this.sql`
			INSERT INTO routing_events (
				request_id, decision, confidence, model, cost, created_at
			) VALUES (
				${snapshot.requestId},
				${snapshot.decision},
				${snapshot.confidence},
				${snapshot.model},
				${snapshot.cost},
				${Date.now()}
			)
		`;

		const current = this.normalizedState();
		const nextState = {
			...current,
			turnCount: current.turnCount + 1,
			lastDecision: snapshot.decision,
			lastModel: snapshot.model,
			lastRouting: snapshot,
			version: (current.version ?? 0) + 1,
		};
		this.setState(nextState);
		return this.state;
	}

	listRoutingEvents(limit = 20): RoutingEvent[] {
		this.ensureRoutingSchema();
		const safeLimit =
			Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
		return this.sql<RoutingEventRow>`
			SELECT request_id, decision, confidence, model, cost, created_at
			FROM routing_events
			ORDER BY id DESC
			LIMIT ${safeLimit}
		`.map((row) => ({
			requestId: row.request_id,
			decision: row.decision,
			confidence: row.confidence,
			model: row.model,
			cost: row.cost,
			createdAt: row.created_at,
		}));
	}

	async deleteAgentData(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}