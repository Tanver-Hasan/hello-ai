# Lesson 11: React Chat Interface

## Goal

Replace the accumulated single-file HTML interface with a maintainable React application while preserving the Worker, Durable Object, AI Gateway, Auto Router, Clef, tool calling, and protection modes.

## Why Hugging Face Chat UI was not embedded

Hugging Face Chat UI is a complete SvelteKit application rather than a reusable chat component. It owns:

- Server routes
- MongoDB-backed conversations, users, files and settings
- Model discovery through an OpenAI-compatible endpoint
- Authentication and environment configuration
- Its own deployment adapter

Adopting it would replace—not enhance—the architecture built in Lessons 1–10. This lab instead uses a purpose-built React frontend against the existing Worker API.

## Step 1: Install the frontend stack

The project uses versions published more than seven days before installation:

```text
React 19.3.0
Vite 8.3.4
Cloudflare Vite plugin 1.63.1
react-markdown 10.1.0
remark-gfm 4.0.1
```

`react-markdown` renders model output without passing it directly to `innerHTML`.

## Step 2: Understand the source layout

```text
index.html
app/
├── main.tsx
├── styles.css
└── tsconfig.json
vite.config.mts
```

The former vanilla interface is preserved under:

```text
legacy-ui/index.html
```

It is no longer part of the active build.

## Step 3: Use the Cloudflare Vite plugin

`vite.config.mts` combines React and Cloudflare:

```ts
export default defineConfig({
	publicDir: false,
	plugins: [
		react(),
		cloudflare({ viteEnvironment: { name: "worker" } }),
	],
	environments: {
		worker: {
			build: { sourcemap: true },
		},
	},
});
```

Vite builds the Worker and client together. The generated deploy configuration points Wrangler at `dist/client`.

## Step 4: Run the application

```bash
npm run dev
```

Vite provides frontend hot-module replacement while the Worker runs in workerd.

## Step 5: Preserve chat behavior

The React application retains:

- Durable conversation IDs in `localStorage`
- Previous conversation list
- History restoration
- New conversations
- Streaming SSE parsing
- Protected non-streaming mode
- Stop generation with `AbortController`
- Markdown and GitHub-flavored Markdown
- Clef route and confidence
- Clef probability weights
- Auto Router’s actual selected model
- Gateway phase, token, latency and estimated-cost inspector
- Guardrails and DLP outcomes
- Rate-limit and inference errors

## Step 6: Build and validate

```bash
npm run typecheck
npm test -- --run
npm run build
npx wrangler deploy --dry-run
```

The production build writes:

```text
dist/
├── client/
└── worker/
```

## Step 7: Deploy

```bash
npm run deploy
```

The script builds first, then Wrangler automatically uses the redirected Vite output configuration.

## Checkpoint

- [ ] The desktop layout has a persistent conversation sidebar.
- [ ] The mobile sidebar opens as a drawer.
- [ ] Enter sends and Shift+Enter creates a newline.
- [ ] Streaming and Protected modes both work.
- [ ] Markdown tables and code blocks render safely.
- [ ] Clef route, confidence and selected model are visible.
- [ ] The right inspector shows decision weights, cost, tokens and protection outcomes.
- [ ] Build, type-check and tests pass.

References:

- [React on Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Hugging Face Chat UI architecture](https://github.com/huggingface/chat-ui)

Continue to [Lesson 12](../lesson-12-agents-foundations/README.md).
