# Lesson 16: Workflow Agent with Human Approval

## Use case

Extend Edgeword with a durable research-report workflow. The Agent prepares a plan, estimates whether the request needs expensive tools/models, waits for human approval, executes approved research exactly once, sends synthesis through the protected Gateway, and reports progress to the existing React learning trace.

## Why combine Agents and Workflows?

Agents provide:

- Real-time UI connections
- Persistent application state
- RPC methods
- Per-user or per-case identity

Workflows provide:

- Durable multi-step execution
- Step-level retry and checkpointing
- Long waits
- Human approval
- Progress and completion events

## Cloudflare framework and infrastructure used

- `EdgewordChatAgent`
- `AgentWorkflow`
- Cloudflare Workflows durable steps
- Agent-to-Workflow RPC and progress events
- `waitForApproval()`, `approveWorkflow()`, and `rejectWorkflow()`
- Existing protected AI Gateway for final synthesis
- React Agent connection for progress and approval UI

## Step 1: Define typed parameters

```ts
type ResearchParams = {
	conversationId: string;
	prompt: string;
	requestedBy: string;
	idempotencyKey: string;
};
```

Validate identity separately. Do not trust `requestedBy` from browser JSON in production.

## Step 2: Create the Workflow

```ts
import { AgentWorkflow } from "agents/workflows";
import type {
	AgentWorkflowEvent,
	AgentWorkflowStep,
} from "agents/workflows";

export class EdgewordResearchWorkflow extends AgentWorkflow<
	EdgewordChatAgent,
	ResearchParams
> {
	async run(
		event: AgentWorkflowEvent<ResearchParams>,
		step: AgentWorkflowStep,
	) {
		const plan = await step.do("validate-and-plan", async () => {
			if (!event.payload.prompt.trim()) {
				throw new Error("Invalid research prompt");
			}
			return {
				...event.payload,
				plannedAt: Date.now(),
			};
		});

		await this.reportProgress({
			step: "approval",
			status: "pending",
			message: "Approve protected research execution",
		});

		const approval = await this.waitForApproval<{
			approvedBy: string;
		}>(step, {
			timeout: "7 days",
		});

		if (!approval) throw new Error("Approval timeout");

		const evidence = await step.do("collect-evidence", async () => {
			return collectApprovedEvidence(plan, approval);
		});

		const result = await step.do("protected-synthesis", async () => {
			return synthesizeThroughProtectedGateway({
				plan,
				evidence,
				approval,
			});
		});

		await step.reportComplete(result);
		return result;
	}
}
```

`step.do()` checkpoints results. Completed steps are not repeated after a retry or restart.

## Step 3: Start the Workflow from the Agent

```ts
@callable()
async submitResearch(params: ResearchParams) {
	const instance = await this.runWorkflow(
		"EdgewordResearchWorkflow",
		params,
	);
	return {
		workflowId: instance.id,
	};
}
```

Use the validated conversation ID plus the caller-provided idempotency key to prevent duplicate submissions. Never use prompt text as the Workflow ID.

## Step 4: Track progress

```ts
async onWorkflowProgress(
	workflowName: string,
	workflowId: string,
	progress: unknown,
) {
	// Validate and add pending approval state.
}
```

Store only UI-relevant summaries in synchronized state. Workflow event history remains in the Workflow engine.

## Step 5: Approve or reject

```ts
@callable()
async approve(workflowId: string, approvedBy: string) {
	await this.approveWorkflow(workflowId, {
		reason: "Approved",
		metadata: {
			approvedBy,
			approvedAt: Date.now(),
		},
	});
}

@callable()
async reject(workflowId: string, reason: string) {
	await this.rejectWorkflow(workflowId, {
		reason,
	});
}
```

Authorization is mandatory. Only an authorized approver may call these methods.

## Step 6: Handle timeout and escalation

Choose an explicit policy:

- Auto-reject
- Escalate to another approver
- Schedule a reminder
- Require resubmission

Never leave approval Workflows waiting indefinitely.

## Step 7: Prevent duplicate execution

Evidence collection, tool calls, and final message insertion must be idempotent. Store the operation key before publishing the report to `AIChatAgent` history.

## Step 8: Preserve Edgeword controls

Every inference step must continue to use:

- Clef decision routing
- The open-weight Auto Router pools
- `hello-ai-protected` for final synthesis
- Request/response Guardrails and DLP
- Gateway request IDs and telemetry
- The existing `$5` protected-gateway budget
- Per-user/tenant authorization from Access

Workflow durability is not permission to bypass the current cost and protection boundary.

## Step 9: Test

Test:

- Validation failure
- Approval
- Rejection
- Timeout
- Unauthorized approval
- Workflow restart after validation
- Retry during processing
- Duplicate submit, evidence, publish, and approve calls
- Client disconnect while waiting
- AI Gateway rate/spend exhaustion
- Guardrails or DLP rejection before report publication

## Checkpoint

- [ ] Work survives Worker and Agent restarts.
- [ ] Waiting consumes no active Agent duration.
- [ ] Approval methods enforce authorization.
- [ ] Side effects are idempotent.
- [ ] Timeout behavior is explicit.
- [ ] Progress reaches connected clients.
- [ ] The final report is persisted in the same Agent conversation.
- [ ] Protected Gateway and budget controls remain in force.

References:

- [Run Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/)
- [Human in the loop](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)
- [Durable Agents with Workflows](https://developers.cloudflare.com/workflows/get-started/durable-agents/)

Continue to [Lesson 17](../lesson-17-mcp-agent/README.md).
