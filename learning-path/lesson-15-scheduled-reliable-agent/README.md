# Lesson 15: Scheduled and Reliable Agent

## Use case

Extend `EdgewordChatAgent` with opt-in conversation follow-ups. It schedules a reminder, queues summary generation, and retries temporary AI/Gateway failures without staying active continuously.

The use case is deliberately tied to the current lab:

```text
User asks for a follow-up
  → Agent schedules it
  → Agent wakes later
  → queue generates a bounded conversation summary
  → existing protected Gateway checks the result
  → connected React clients receive updated Agent state
```

## Cloudflare framework and infrastructure used

- `EdgewordChatAgent`
- Agents SDK `schedule()` and `scheduleEvery()`
- Agent-local SQLite schedule persistence
- Built-in Agent FIFO queue
- `this.retry()` with backoff and jitter
- Existing protected AI Gateway for generated summaries
- Agent state synchronization to the React UI

## Choosing the primitive

| Need | Primitive |
| --- | --- |
| Run once later | `schedule()` |
| Recurring interval | `scheduleEvery()` |
| Cron timing | `schedule(cron, ...)` |
| FIFO deferred work | `queue()` |
| Retry one async operation | `this.retry()` |
| Checkpoint long in-agent work | `runFiber()` |
| Independent multi-step pipeline | Workflow |

Agents wake, work, persist, and sleep. They are not continuously running processes.

## Step 1: Model monitor state

```ts
type FollowUpState = {
	enabled: boolean;
	nextReminderAt?: number;
	lastSummaryAt?: number;
	failureCount: number;
};
```

## Step 2: Enable monitoring

```ts
@callable()
async enableFollowUps() {
	if (this.state.enabled) return;

	await this.scheduleEvery(86_400, "prepareDailyFollowUp");
	this.setState({
		...this.state,
		enabled: true,
	});
}
```

Make commands idempotent so repeated button clicks do not create duplicate schedules.

## Step 3: Implement the scheduled callback

```ts
async prepareDailyFollowUp() {
	const result = await this.retry(
		() => loadBoundedConversationContext(),
		{
			maxAttempts: 4,
			shouldRetry: (error) => isTemporary(error),
		},
	);

	this.setState({
		...this.state,
		lastSummaryAt: Date.now(),
		failureCount: 0,
	});

	await this.queue("generateProtectedSummary", {
		context: result,
		idempotencyKey: crypto.randomUUID(),
	});
}
```

## Step 4: Process queued work

```ts
async generateProtectedSummary(payload: {
	context: unknown;
	idempotencyKey: string;
}) {
	await generateThroughProtectedGateway(payload);
}
```

Queue items are persisted in the Agent’s SQLite infrastructure and processed sequentially. A successful callback is dequeued automatically. The summary must reuse `hello-ai-protected`, its Guardrails/DLP, Auto Router pool, and `$5` budget.

## Step 5: Configure retry policy

Per-task:

```ts
await this.schedule(
	60,
	"prepareDailyFollowUp",
	{},
	{
		retry: {
			maxAttempts: 5,
		},
	},
);
```

Class default:

```ts
static options = {
	retry: {
		maxAttempts: 3,
	},
};
```

Do not retry authentication failures, invalid input, or other permanent errors.

## Step 6: Cancel cleanly

```ts
@callable()
async disableFollowUps() {
	const schedules = this.getSchedules();
	for (const schedule of schedules) {
		await this.cancelSchedule(schedule.id);
	}
	this.setState({
		...this.state,
		enabled: false,
	});
}
```

Filter schedules by callback or stored ID in a real agent rather than canceling unrelated work.

## Step 7: Prevent duplicate side effects

Retries may execute code more than once. Use an idempotency key:

```text
agent-name + schedule-id + checked-at
```

Store generated-summary idempotency keys before reporting success.

## Step 8: Choose schedules versus Workflows

Use schedules, queue, retries, and fibers for work about the agent’s own lifecycle. Use Workflows for a discrete pipeline with multiple durable steps, independent retries, or human approval.

## Step 9: Test

Test:

- Enable is idempotent
- Disable cancels the intended schedule
- Temporary errors retry
- Permanent errors do not retry
- Queue ordering
- Duplicate summaries are suppressed
- Agent eviction does not lose scheduled work
- Protected Gateway rejection does not publish an unchecked summary
- Spend-limit `429` stops retries until a later schedule

## Checkpoint

- [ ] The agent sleeps between scheduled events.
- [ ] Schedule creation is idempotent.
- [ ] Retries distinguish temporary and permanent errors.
- [ ] Queued side effects use idempotency keys.
- [ ] Schedules can be inspected and canceled.

References:

- [Schedule tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)
- [Queue tasks](https://developers.cloudflare.com/agents/runtime/execution/queue-tasks/)
- [Retries](https://developers.cloudflare.com/agents/runtime/execution/retries/)
- [Durable execution](https://developers.cloudflare.com/agents/runtime/execution/durable-execution/)

Continue to [Lesson 16](../lesson-16-workflow-approval-agent/README.md).
