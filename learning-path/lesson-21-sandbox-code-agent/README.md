# Lesson 21: Isolated Code Execution with Sandbox SDK

## Goal

Add an optional code-interpreter tool to Agent Chat using Cloudflare Sandbox SDK and Containers. The current chat does not execute code and remains unchanged.

## Version requirement

Cloudflare released Sandbox SDK 1.0 on September 30, 2026. New implementations should follow current 1.0 documentation:

- Your code owns the Sandbox Durable Object class.
- The class controls `this.ctx.container` directly.
- Your code decides image, lifetime, network access, snapshots, and exposed methods.

Do not copy a 0.x `getSandbox()` architecture into a new 1.0 implementation without checking the installed version. Sandbox SDK 0.x documentation is retained for existing applications.

## Additive architecture

```text
Current chat — no code execution

Optional Agent Chat
  → Clef/tool decision
  → human approval
  → EdgewordSandbox Durable Object
      → isolated Container
          → Python/JavaScript/TypeScript execution
  → bounded result
  → protected or streaming Agent response
```

## Cloudflare infrastructure used

- Cloudflare Agents SDK
- Sandbox SDK 1.0
- Durable Object Container API
- Cloudflare Containers
- Optional Sandbox interpreter extension
- R2 snapshots/backups when explicitly needed
- Access, rate limits, and separate Sandbox quotas

## Step 1: Define the allowed use case

Start with data analysis:

```text
Input: user-supplied CSV or small JSON
Code: model-proposed Python
Output: text/table/chart metadata
```

Do not begin with a general-purpose shell exposed directly to users or models.

## Step 2: Install only after checking the current release

```bash
npm view @cloudflare/sandbox version time --json
```

Install a stable version published at least seven days earlier:

```bash
npm install @cloudflare/sandbox
```

Local container development requires Docker:

```bash
docker info
```

## Step 3: Create a dedicated Sandbox Durable Object

Sandbox 1.0 requires your own class:

```ts
import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export class EdgewordSandbox extends DurableObject<Env> {
	private container: NonNullable<DurableObjectState["container"]>;
	private files: Files;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (!ctx.container) throw new Error("Sandbox container is not configured");
		this.container = ctx.container;
		this.files = new Files(ctx.container);
	}
}
```

Use the current installed Container API types for process execution. In 1.0, process lifecycle, cancellation, and retries are application decisions.

## Step 4: Configure a separate container

The Sandbox binding must be additional to `Conversation` and Agent bindings. Configure:

- `EdgewordSandbox` Durable Object binding
- Container image
- Instance type
- Maximum instances
- Durable Object scheduling policy

Use a minimal image containing only required runtimes and packages. Large images increase cold-start and supply-chain risk.

## Step 5: Derive a safe sandbox identity

Use:

```text
verified-user-subject + Agent conversation ID + execution session ID
```

Do not use:

- One global sandbox
- Prompt text
- Unverified browser IDs
- A predictable shared constant

## Step 6: Require approval

Before running model-generated code, show:

- Language
- Code
- Input files
- Requested network destinations
- CPU/time/storage budget
- Whether files persist

Approval applies to one execution plan. Changing code or permissions requires another approval.

## Step 7: Restrict execution

Enforce:

- Language allowlist
- Command or interpreter API allowlist
- Execution timeout
- Output-size limit
- File-size and file-count limits
- Working-directory boundary
- Process-count limit
- Container instance quota
- No privileged mode
- No host filesystem access

Never concatenate untrusted values into shell commands. Prefer argv arrays or the interpreter API.

## Step 8: Control egress and credentials

Default to no outbound network access. If a tool needs an API:

1. Allowlist exact destinations.
2. Intercept outbound requests in Worker code.
3. Keep credentials in Worker bindings or Secrets Store.
4. Add authorization headers outside the container.
5. Return only the API response fields the task needs.

Never inject Cloudflare API tokens or AI Gateway credentials into the sandbox.

## Step 9: Bound results

Return a structured result:

```ts
type SandboxResult = {
	success: boolean;
	exitCode?: number;
	stdout: string;
	stderr: string;
	files: Array<{
		name: string;
		size: number;
	}>;
	truncated: boolean;
};
```

Truncate before storing results in Agent history or sending them to a model.

## Step 10: Stop, destroy, or snapshot

Choose explicitly:

- Destroy temporary sandboxes immediately
- Stop reusable sandboxes after inactivity
- Snapshot only approved workspace paths
- Set snapshot retention in R2

Container/Sandbox costs are not covered by the two `$5` AI Gateway limits. Add separate monitoring and quotas.

## Step 11: Test

Test:

- Infinite loop timeout
- Excessive stdout
- Filesystem traversal
- Network access denial
- Secret discovery attempts
- Fork/process bomb limits
- Container cleanup
- Cancellation after partial file writes
- Duplicate Workflow retry
- Current chat cannot invoke Sandbox

## Checkpoint

- [ ] Sandbox is available only in optional Agent mode.
- [ ] Every execution requires authorization and approval.
- [ ] Credentials never enter the container.
- [ ] Egress, time, output, files, and instance count are bounded.
- [ ] Cleanup behavior is explicit.
- [ ] Sandbox cost is monitored separately.

References:

- [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/)
- [Sandbox SDK 1.0 changes](https://developers.cloudflare.com/sandbox/sdk/migrate/changes-in-1-0/)
- [Sandbox security model](https://developers.cloudflare.com/sandbox/sdk/concepts/security/)
- [Container limits](https://developers.cloudflare.com/containers/platform/limits/)

Continue to [Lesson 22](../lesson-22-agent-capstone/README.md).
