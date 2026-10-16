import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

type Mode = "stream" | "protected";
type Role = "user" | "assistant";

type Message = {
	id: number | string;
	role: Role;
	content: string;
	model?: string;
	decision?: string;
	confidence?: number;
	pending?: boolean;
	error?: boolean;
};

type Conversation = {
	id: string;
	title: string;
	updatedAt: number;
};

type StreamEvent = {
	done: boolean;
	model: string;
	text: string;
};

type RouteWeights = {
	simple: number;
	complex: number;
	tool: number;
};

type GatewayLog = {
	id: string;
	phase: string;
	provider: string;
	model: string;
	success: boolean;
	statusCode: number;
	durationMs: number;
	tokensIn: number;
	tokensOut: number;
	cost: number;
	cached: boolean;
	guardrails: Record<string, unknown> | null;
	dlpAction: string | null;
	dlpProfiles: string[];
};

type ModelCatalog = {
	decisionModels: Array<{
		id: string;
		name: string;
		purpose: string;
	}>;
	router: {
		id: string;
		name: string;
		purpose: string;
	};
	pools: Record<"simple" | "complex" | "tool", string[]>;
};

const ACTIVE_KEY = "hello-ai-conversation";
const HISTORY_KEY = "hello-ai-conversations";
const INSPECTOR_KEY = "hello-ai-learning-trace";
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const examples = [
	"Explain Durable Objects with a simple analogy.",
	"Compare Auto Router and Dynamic Routing.",
	"What is 98,765.5 plus 1,234.25?",
];

function loadConversations(): Conversation[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
		if (!Array.isArray(value)) return [];
		return value.filter(
			(item): item is Conversation =>
				typeof item === "object" &&
				item !== null &&
				"id" in item &&
				typeof item.id === "string" &&
				UUID.test(item.id) &&
				"title" in item &&
				typeof item.title === "string" &&
				"updatedAt" in item &&
				typeof item.updatedAt === "number",
		);
	} catch {
		return [];
	}
}

function initialConversationId(): string {
	const value = localStorage.getItem(ACTIVE_KEY);
	if (value && UUID.test(value)) return value;
	const id = crypto.randomUUID();
	localStorage.setItem(ACTIVE_KEY, id);
	return id;
}

function initialInspectorOpen(): boolean {
	if (!window.matchMedia("(min-width: 1101px)").matches) return false;
	return localStorage.getItem(INSPECTOR_KEY) !== "closed";
}

function parseEvent(block: string): StreamEvent {
	const payload = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");

	if (!payload) return { done: false, model: "", text: "" };
	if (payload === "[DONE]") return { done: true, model: "", text: "" };

	const event = JSON.parse(payload);
	if (event.error) {
		throw new Error(
			typeof event.error === "string"
				? event.error
				: "The model returned an error.",
		);
	}

	return {
		done: false,
		model: typeof event.model === "string" ? event.model : "",
		text:
			event.response ??
			event.choices?.[0]?.delta?.content ??
			event.result?.response ??
			"",
	};
}

function shortModel(model?: string): string {
	if (!model || model === "cloudflare/auto") return "Auto Router";
	return model.replace("@cf/", "").replaceAll("/", " / ");
}

function parseWeights(value: string | null): RouteWeights {
	try {
		const parsed: unknown = JSON.parse(value ?? "{}");
		if (typeof parsed !== "object" || parsed === null) {
			throw new Error("Invalid weights");
		}
		return {
			simple:
				"simple" in parsed && typeof parsed.simple === "number"
					? parsed.simple
					: 0,
			complex:
				"complex" in parsed && typeof parsed.complex === "number"
					? parsed.complex
					: 0,
			tool:
				"tool" in parsed && typeof parsed.tool === "number"
					? parsed.tool
					: 0,
		};
	} catch {
		return { simple: 0, complex: 0, tool: 0 };
	}
}

function Icon({
	name,
	size = 18,
}: {
	name:
		| "add"
		| "arrow"
		| "close"
		| "copy"
		| "menu"
		| "panel"
		| "settings"
		| "stop"
		| "trash";
	size?: number;
}) {
	const paths = {
		add: <path d="M12 5v14M5 12h14" />,
		arrow: <path d="m5 12 7-7 7 7M12 5v14" />,
		copy: (
			<>
				<rect x="8" y="8" width="11" height="11" rx="2" />
				<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
			</>
		),
		close: <path d="m6 6 12 12M18 6 6 18" />,
		menu: <path d="M4 7h16M4 12h16M4 17h16" />,
		panel: (
			<>
				<rect x="3" y="4" width="18" height="16" rx="2" />
				<path d="M15 4v16" />
			</>
		),
		settings: (
			<>
				<circle cx="12" cy="12" r="3" />
				<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.52-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.08V3h4v.08a1.7 1.7 0 0 0 1.03 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
			</>
		),
		stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
		trash: (
			<>
				<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
			</>
		),
	};
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.8"
			viewBox="0 0 24 24"
			width={size}
		>
			{paths[name]}
		</svg>
	);
}

function ModelWithPool({
	model,
	candidates,
	compact = false,
}: {
	model: string;
	candidates: string[];
	compact?: boolean;
}) {
	return (
		<span className={`model-tooltip ${compact ? "compact" : ""}`} tabIndex={0}>
			<span className={compact ? "model-pill" : "selected-model"}>
				{shortModel(model)}
			</span>
			<span className="model-tooltip-card" role="tooltip">
				<strong>Auto Router candidate pool</strong>
				{candidates.length === 0 ? (
					<span>Available after Clef makes a decision.</span>
				) : (
					candidates.map((candidate) => (
						<code key={candidate}>{candidate}</code>
					))
				)}
			</span>
		</span>
	);
}

function App() {
	const [conversationId, setConversationId] = useState(initialConversationId);
	const [conversations, setConversations] = useState<Conversation[]>(() =>
		loadConversations(),
	);
	const [messages, setMessages] = useState<Message[]>([]);
	const [prompt, setPrompt] = useState("");
	const [mode, setMode] = useState<Mode>("stream");
	const [status, setStatus] = useState("Ready");
	const [sending, setSending] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [route, setRoute] = useState<string>();
	const [confidence, setConfidence] = useState<number>();
	const [weights, setWeights] = useState<RouteWeights>({
		simple: 0,
		complex: 0,
		tool: 0,
	});
	const [model, setModel] = useState("cloudflare/auto");
	const [candidateModels, setCandidateModels] = useState<string[]>([]);
	const [gatewayLogs, setGatewayLogs] = useState<GatewayLog[]>([]);
	const [telemetryLoading, setTelemetryLoading] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [modelCatalog, setModelCatalog] = useState<ModelCatalog>();
	const [pendingDelete, setPendingDelete] = useState<Conversation>();
	const [deleting, setDeleting] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(initialInspectorOpen);
	const controllerRef = useRef<AbortController | null>(null);
	const messageEndRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const rememberConversation = (id: string, title?: string) => {
		setConversations((current) => {
			const existing = current.find((item) => item.id === id);
			const next = existing
				? current.map((item) =>
						item.id === id
							? {
									...item,
									title:
										title && item.title === "New chat" ? title : item.title,
									updatedAt: Date.now(),
								}
							: item,
					)
				: [
						...current,
						{ id, title: title || "New chat", updatedAt: Date.now() },
					];
			const sorted = next
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 50);
			localStorage.setItem(HISTORY_KEY, JSON.stringify(sorted));
			return sorted;
		});
	};

	useEffect(() => {
		rememberConversation(conversationId);
	}, []);

	useEffect(() => {
		localStorage.setItem(INSPECTOR_KEY, inspectorOpen ? "open" : "closed");
	}, [inspectorOpen]);

	useEffect(() => {
		fetch("/models")
			.then(async (response) => {
				if (!response.ok) throw new Error("Unable to load model catalog");
				setModelCatalog(await response.json());
			})
			.catch(() => setModelCatalog(undefined));
	}, []);

	useEffect(() => {
		if (!settingsOpen && !pendingDelete) return;
		const close = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				setSettingsOpen(false);
				setPendingDelete(undefined);
			}
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [settingsOpen, pendingDelete]);

	useEffect(() => {
		const controller = new AbortController();
		setStatus("Loading conversation");
		fetch(`/conversations/${conversationId}/messages`, {
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error("Unable to restore conversation");
				const body = await response.json();
				setMessages(body.messages ?? []);
				setStatus(body.messages?.length ? "Conversation restored" : "Ready");
			})
			.catch((error) => {
				if (error.name !== "AbortError") setStatus("Unable to restore chat");
			});
		return () => controller.abort();
	}, [conversationId]);

	useEffect(() => {
		messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "0px";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
	}, [prompt]);

	const updateAssistant = (
		id: string,
		update: Partial<Message> | ((message: Message) => Partial<Message>),
	) => {
		setMessages((current) =>
			current.map((message) =>
				message.id === id
					? {
							...message,
							...(typeof update === "function" ? update(message) : update),
						}
					: message,
			),
		);
	};

	const loadTelemetry = async (logIds: string[], requestMode: Mode) => {
		if (logIds.length === 0) {
			setGatewayLogs([]);
			return;
		}

		setTelemetryLoading(true);
		try {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				if (attempt > 0) {
					await new Promise((resolve) => setTimeout(resolve, 600));
				}
				const response = await fetch(
					`/telemetry?gateway=${requestMode}&logs=${encodeURIComponent(
						logIds.join(","),
					)}`,
				);
				if (!response.ok) continue;
				const body = await response.json();
				if (Array.isArray(body.logs) && body.logs.length > 0) {
					setGatewayLogs(body.logs);
					return;
				}
			}
			setGatewayLogs([]);
		} finally {
			setTelemetryLoading(false);
		}
	};

	const send = async (event?: FormEvent) => {
		event?.preventDefault();
		const content = prompt.trim();
		if (!content || sending) return;

		const userId = crypto.randomUUID();
		const assistantId = crypto.randomUUID();
		const controller = new AbortController();
		controllerRef.current = controller;
		setSending(true);
		setPrompt("");
		setStatus(mode === "protected" ? "Running protected checks" : "Routing");
		setRoute(undefined);
		setConfidence(undefined);
		setWeights({ simple: 0, complex: 0, tool: 0 });
		setGatewayLogs([]);
		setModel("cloudflare/auto");
		setCandidateModels([]);
		setMessages((current) => [
			...current,
			{ id: userId, role: "user", content },
			{ id: assistantId, role: "assistant", content: "", pending: true },
		]);
		rememberConversation(
			conversationId,
			content.length > 42 ? `${content.slice(0, 42)}…` : content,
		);

		try {
			const endpoint = mode === "protected" ? "protected" : "stream";
			const response = await fetch(
				`/conversations/${conversationId}/chat/${endpoint}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ prompt: content }),
					signal: controller.signal,
				},
			);

			if (!response.ok) {
				const body = await response.json().catch(() => null);
				throw new Error(
					body?.message ??
						body?.error ??
						`Request failed (${response.status})`,
				);
			}

			const decision = response.headers.get("X-Route-Decision") ?? undefined;
			const confidenceValue = Number(
				response.headers.get("X-Route-Confidence"),
			);
			const decisionWeights = parseWeights(
				response.headers.get("X-Route-Weights"),
			);
			const telemetryLogIds = (
				response.headers.get("X-Telemetry-Log-Ids") ?? ""
			)
				.split(",")
				.filter(Boolean);
			const responseCandidateModels = (
				response.headers.get("X-Candidate-Models") ?? ""
			)
				.split(",")
				.filter(Boolean);
			const routedModel =
				response.headers.get("X-Routed-Model") || "cloudflare/auto";
			setRoute(decision);
			setConfidence(
				Number.isFinite(confidenceValue) ? confidenceValue : undefined,
			);
			setWeights(decisionWeights);
			setModel(routedModel);
			setCandidateModels(responseCandidateModels);

			if (mode === "protected") {
				const body = await response.json();
				const answer = typeof body.response === "string" ? body.response : "";
				setModel(body.model || routedModel);
				setRoute(body.decision?.route || decision);
				setConfidence(body.decision?.confidence ?? confidenceValue);
				setWeights(body.decision?.weights ?? decisionWeights);
				setCandidateModels(
					Array.isArray(body.candidateModels)
						? body.candidateModels
						: responseCandidateModels,
				);
				updateAssistant(assistantId, {
					content: answer || "The protected model returned no text.",
					model: body.model,
					decision: body.decision?.route,
					confidence: body.decision?.confidence,
					pending: false,
				});
				setStatus("Protected checks complete");
				void loadTelemetry(
					Array.isArray(body.telemetryLogIds)
						? body.telemetryLogIds
						: telemetryLogIds,
					mode,
				);
				return;
			}

			if (!response.body) throw new Error("Streaming is unavailable.");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let doneEvent = false;
			setStatus("Streaming response");

			while (!doneEvent) {
				const { value, done } = await reader.read();
				buffer += decoder.decode(value, { stream: !done }).replace(
					/\r\n/g,
					"\n",
				);
				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const streamEvent = parseEvent(block);
					if (streamEvent.done) {
						doneEvent = true;
						break;
					}
					if (streamEvent.model) setModel(streamEvent.model);
					if (streamEvent.text) {
						updateAssistant(assistantId, (message) => ({
							content: message.content + streamEvent.text,
							model: streamEvent.model || message.model,
							decision,
							confidence: Number.isFinite(confidenceValue)
								? confidenceValue
								: undefined,
						}));
					}
					boundary = buffer.indexOf("\n\n");
				}
				if (done) break;
			}

			updateAssistant(assistantId, { pending: false });
			setStatus("Complete");
			void loadTelemetry(telemetryLogIds, mode);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				updateAssistant(assistantId, {
					content: "Generation stopped.",
					pending: false,
					error: true,
				});
				setStatus("Stopped");
			} else {
				updateAssistant(assistantId, {
					content:
						error instanceof Error ? error.message : "Unable to respond.",
					pending: false,
					error: true,
				});
				setStatus("Request failed");
			}
		} finally {
			setSending(false);
			controllerRef.current = null;
		}
	};

	const newChat = () => {
		controllerRef.current?.abort();
		const id = crypto.randomUUID();
		localStorage.setItem(ACTIVE_KEY, id);
		setConversationId(id);
		setMessages([]);
		setRoute(undefined);
		setConfidence(undefined);
		setWeights({ simple: 0, complex: 0, tool: 0 });
		setGatewayLogs([]);
		setModel("cloudflare/auto");
		setCandidateModels([]);
		setStatus("Ready");
		rememberConversation(id, "New chat");
		setSidebarOpen(false);
		textareaRef.current?.focus();
	};

	const selectConversation = (id: string) => {
		controllerRef.current?.abort();
		localStorage.setItem(ACTIVE_KEY, id);
		setConversationId(id);
		setSidebarOpen(false);
		setRoute(undefined);
		setConfidence(undefined);
		setWeights({ simple: 0, complex: 0, tool: 0 });
		setGatewayLogs([]);
		setModel("cloudflare/auto");
		setCandidateModels([]);
	};

	const removeConversation = async () => {
		if (!pendingDelete || deleting) return;
		setDeleting(true);
		try {
			const response = await fetch(`/conversations/${pendingDelete.id}`, {
				method: "DELETE",
			});
			if (response.status !== 204) {
				const body = await response.json().catch(() => null);
				throw new Error(
					body?.message ?? body?.error ?? "Unable to delete conversation",
				);
			}

			const remaining = conversations.filter(
				(conversation) => conversation.id !== pendingDelete.id,
			);
			if (pendingDelete.id === conversationId) {
				const id = crypto.randomUUID();
				const next = [
					{ id, title: "New chat", updatedAt: Date.now() },
					...remaining,
				].slice(0, 50);
				localStorage.setItem(ACTIVE_KEY, id);
				localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
				setConversations(next);
				setConversationId(id);
				setMessages([]);
				setRoute(undefined);
				setConfidence(undefined);
				setWeights({ simple: 0, complex: 0, tool: 0 });
				setGatewayLogs([]);
				setModel("cloudflare/auto");
				setCandidateModels([]);
				setStatus("Conversation deleted");
			} else {
				localStorage.setItem(HISTORY_KEY, JSON.stringify(remaining));
				setConversations(remaining);
				setStatus("Conversation deleted");
			}
			setPendingDelete(undefined);
		} catch (error) {
			setStatus(
				error instanceof Error ? error.message : "Unable to delete conversation",
			);
		} finally {
			setDeleting(false);
		}
	};

	const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	};

	const totalCost = gatewayLogs.reduce((sum, log) => sum + log.cost, 0);
	const totalTokensIn = gatewayLogs.reduce(
		(sum, log) => sum + log.tokensIn,
		0,
	);
	const totalTokensOut = gatewayLogs.reduce(
		(sum, log) => sum + log.tokensOut,
		0,
	);
	const totalDuration = gatewayLogs.reduce(
		(sum, log) => sum + log.durationMs,
		0,
	);
	const dlpActions = [
		...new Set(
			gatewayLogs
				.map((log) => log.dlpAction)
				.filter((action): action is string => Boolean(action)),
		),
	];
	const guardrailEvaluated = gatewayLogs.some(
		(log) => log.guardrails && Object.keys(log.guardrails).length > 0,
	);
	const allCatalogModels = modelCatalog
		? [...new Set(Object.values(modelCatalog.pools).flat())]
		: [];

	return (
		<div className={`app-shell ${inspectorOpen ? "" : "inspector-hidden"}`}>
			<button
				aria-label="Close conversations"
				className={`scrim ${sidebarOpen ? "visible" : ""}`}
				onClick={() => setSidebarOpen(false)}
				type="button"
			/>
			<aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
				<div className="brand">
					<span className="brand-mark">E</span>
					<div>
						<strong>Edgeword</strong>
						<span>Workers AI lab</span>
					</div>
				</div>
				<button className="new-chat" onClick={newChat} type="button">
					<Icon name="add" />
					New conversation
				</button>
				<p className="sidebar-label">Recent</p>
				<nav className="chat-list">
					{conversations.map((conversation) => (
						<div
							className="chat-link-row"
							key={conversation.id}
						>
							<button
								aria-current={conversation.id === conversationId}
								className="chat-link"
								onClick={() => selectConversation(conversation.id)}
								title={conversation.title}
								type="button"
							>
								<span>{conversation.title}</span>
							</button>
							<button
								aria-label={`Delete ${conversation.title}`}
								className="delete-chat"
								onClick={() => setPendingDelete(conversation)}
								title="Delete conversation"
								type="button"
							>
								<Icon name="trash" size={15} />
							</button>
						</div>
					))}
				</nav>
				<button
					className="settings-button"
					onClick={() => {
						setSettingsOpen(true);
						setSidebarOpen(false);
					}}
					type="button"
				>
					<Icon name="settings" />
					Model settings
				</button>
				<div className="sidebar-footer">
					<span className="edge-dot" />
					Cloudflare edge connected
				</div>
			</aside>

			<main className="chat">
				<header className="topbar">
					<button
						aria-label="Open conversations"
						className="menu-button"
						onClick={() => setSidebarOpen(true)}
						type="button"
					>
						<Icon name="menu" />
					</button>
					<div className="topbar-copy">
						<strong>AI workspace</strong>
						<span>{status}</span>
					</div>
					<button
						aria-label={
							inspectorOpen ? "Hide learning trace" : "Show learning trace"
						}
						aria-pressed={inspectorOpen}
						className="inspector-toggle"
						onClick={() => setInspectorOpen((open) => !open)}
						title={
							inspectorOpen ? "Hide learning trace" : "Show learning trace"
						}
						type="button"
					>
						<Icon name="panel" />
					</button>
					<div className="mode-switch" role="group" aria-label="Response mode">
						<button
							aria-pressed={mode === "stream"}
							onClick={() => setMode("stream")}
							type="button"
						>
							Streaming
						</button>
						<button
							aria-pressed={mode === "protected"}
							onClick={() => setMode("protected")}
							type="button"
						>
							Protected
						</button>
					</div>
				</header>

				<section className="message-scroll">
					{messages.length === 0 ? (
						<div className="empty-state">
							<div className="empty-orbit">
								<span />
							</div>
							<p className="eyebrow">Cloudflare AI Gateway</p>
							<h1>What do you want to explore?</h1>
							<p className="empty-copy">
								Clef routes the task. Auto Router chooses the open-weight
								model. You stay in control of streaming and protection.
							</p>
							<div className="suggestion-grid">
								{examples.map((example) => (
									<button
										key={example}
										onClick={() => {
											setPrompt(example);
											textareaRef.current?.focus();
										}}
										type="button"
									>
										{example}
										<Icon name="arrow" size={15} />
									</button>
								))}
							</div>
						</div>
					) : (
						<div className="messages">
							{messages.map((message) => (
								<article className={`message ${message.role}`} key={message.id}>
									<div className="message-avatar">
										{message.role === "user" ? "You" : "AI"}
									</div>
									<div className="message-body">
										{message.role === "assistant" && (
											<div className="message-meta">
												<span>{shortModel(message.model || model)}</span>
												{(message.decision || route) && (
													<span>
														{message.decision || route}
														{" · "}
														{Math.round(
															(message.confidence ?? confidence ?? 0) * 100,
														)}
														%
													</span>
												)}
												<span>{mode === "protected" ? "Protected" : "Live"}</span>
											</div>
										)}
										<div
											className={`message-content ${
												message.error ? "error" : ""
											}`}
										>
											{message.role === "assistant" ? (
												message.content ? (
													<Markdown remarkPlugins={[remarkGfm]}>
														{message.content}
													</Markdown>
												) : (
													<span className="typing">
														<i />
														<i />
														<i />
													</span>
												)
											) : (
												message.content
											)}
										</div>
										{message.role === "assistant" && message.content && (
											<button
												className="copy-button"
												onClick={() =>
													navigator.clipboard.writeText(message.content)
												}
												type="button"
											>
												<Icon name="copy" size={14} />
												Copy
											</button>
										)}
									</div>
								</article>
							))}
							<div ref={messageEndRef} />
						</div>
					)}
				</section>

				<footer className="composer-wrap">
					<form className="composer" onSubmit={send}>
						<textarea
							aria-label="Message"
							maxLength={4000}
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={onPromptKeyDown}
							placeholder="Message Edgeword…"
							ref={textareaRef}
							rows={1}
							value={prompt}
						/>
						<div className="composer-bottom">
							<div className="composer-hints">
								<ModelWithPool
									candidates={candidateModels}
									compact
									model={model}
								/>
								<span>{prompt.length}/4000</span>
							</div>
							{sending ? (
								<button
									aria-label="Stop generation"
									className="send-button stop"
									onClick={() => controllerRef.current?.abort()}
									type="button"
								>
									<Icon name="stop" />
								</button>
							) : (
								<button
									aria-label="Send message"
									className="send-button"
									disabled={!prompt.trim()}
									type="submit"
								>
									<Icon name="arrow" />
								</button>
							)}
						</div>
					</form>
					<p className="disclaimer">
						AI can make mistakes. Check important information.
					</p>
				</footer>
			</main>

			{inspectorOpen && <aside className="inspector">
				<div className="inspector-heading">
					<div>
						<p>Learning trace</p>
						<h2>How this answer was made</h2>
					</div>
					<div className="inspector-heading-actions">
						<span className={telemetryLoading ? "pulse-dot" : "trace-dot"} />
						<button
							aria-label="Hide learning trace"
							onClick={() => setInspectorOpen(false)}
							type="button"
						>
							<Icon name="close" size={16} />
						</button>
					</div>
				</div>

				<section className="trace-section">
					<div className="section-title">
						<span>01</span>
						Clef decision
					</div>
					<div className="decision-result">
						<strong>{route || "Waiting"}</strong>
						<span>
							{confidence === undefined
								? "No decision yet"
								: `${Math.round(confidence * 100)}% confidence`}
						</span>
					</div>
					{(["simple", "complex", "tool"] as const).map((item) => (
						<div className="weight-row" key={item}>
							<div>
								<span>{item}</span>
								<small>{Math.round(weights[item] * 100)}%</small>
							</div>
							<div className="weight-track">
								<span style={{ width: `${weights[item] * 100}%` }} />
							</div>
						</div>
					))}
				</section>

				<section className="trace-section">
					<div className="section-title">
						<span>02</span>
						Auto Router
					</div>
					<ModelWithPool candidates={candidateModels} model={model} />
					<p className="trace-note">
						Selected from the {route || "eligible"} open-weight pool.
					</p>
				</section>

				<section className="trace-section">
					<div className="section-title">
						<span>03</span>
						Gateway usage
					</div>
					<div className="metric-grid">
						<div>
							<strong>{gatewayLogs.length}</strong>
							<span>calls</span>
						</div>
						<div>
							<strong>{totalTokensIn + totalTokensOut}</strong>
							<span>tokens</span>
						</div>
						<div>
							<strong>{(totalDuration / 1000).toFixed(2)}s</strong>
							<span>gateway time</span>
						</div>
						<div>
							<strong>${totalCost.toFixed(6)}</strong>
							<span>estimated</span>
						</div>
					</div>
					<div className="token-split">
						<span>{totalTokensIn} input</span>
						<span>{totalTokensOut} output</span>
					</div>
				</section>

				<section className="trace-section">
					<div className="section-title">
						<span>04</span>
						Protection
					</div>
					<div className="protection-row">
						<span>Mode</span>
						<strong>{mode === "protected" ? "Protected" : "Streaming"}</strong>
					</div>
					<div className="protection-row">
						<span>DLP</span>
						<strong>{dlpActions.join(", ") || "No match"}</strong>
					</div>
					<div className="protection-row">
						<span>Guardrails</span>
						<strong>
							{mode === "protected"
								? guardrailEvaluated
									? "Evaluated"
									: "No match"
								: "Not applied"}
						</strong>
					</div>
				</section>

				<section className="trace-section phase-list">
					<div className="section-title">
						<span>05</span>
						Request phases
					</div>
					{gatewayLogs.length === 0 ? (
						<p className="trace-note">
							Send a message to inspect Gateway phases.
						</p>
					) : (
						gatewayLogs.map((log) => (
							<div className="phase-item" key={log.id}>
								<span className={log.success ? "ok" : "failed"} />
								<div>
									<strong>{log.phase.replaceAll("_", " ")}</strong>
									<small>
										{shortModel(log.model)} · {log.durationMs}ms
									</small>
								</div>
							</div>
						))
					)}
				</section>
			</aside>}

			{pendingDelete && (
				<div
					className="settings-backdrop"
					onMouseDown={(event) => {
						if (event.currentTarget === event.target && !deleting) {
							setPendingDelete(undefined);
						}
					}}
				>
					<section
						aria-labelledby="delete-title"
						aria-modal="true"
						className="delete-dialog"
						role="alertdialog"
					>
						<div className="delete-icon">
							<Icon name="trash" />
						</div>
						<h2 id="delete-title">Delete this conversation?</h2>
						<p>
							<strong>{pendingDelete.title}</strong> and its Durable Object
							SQLite storage will be permanently removed.
						</p>
						<div className="delete-actions">
							<button
								disabled={deleting}
								onClick={() => setPendingDelete(undefined)}
								type="button"
							>
								Cancel
							</button>
							<button
								className="danger"
								disabled={deleting}
								onClick={() => void removeConversation()}
								type="button"
							>
								{deleting ? "Deleting…" : "Delete permanently"}
							</button>
						</div>
					</section>
				</div>
			)}

			{settingsOpen && (
				<div
					className="settings-backdrop"
					onMouseDown={(event) => {
						if (event.currentTarget === event.target) setSettingsOpen(false);
					}}
				>
					<section
						aria-labelledby="settings-title"
						aria-modal="true"
						className="settings-dialog"
						role="dialog"
					>
						<header className="settings-header">
							<div>
								<p>Routing catalog</p>
								<h2 id="settings-title">Models and decisions</h2>
							</div>
							<button
								aria-label="Close settings"
								onClick={() => setSettingsOpen(false)}
								type="button"
							>
								<Icon name="close" />
							</button>
						</header>

						{modelCatalog ? (
							<div className="settings-content">
								<section className="catalog-section">
									<div className="catalog-heading">
										<span>01</span>
										<div>
											<h3>Decision models</h3>
											<p>Models that classify work before answer generation.</p>
										</div>
									</div>
									{modelCatalog.decisionModels.map((item) => (
										<div className="catalog-model featured" key={item.id}>
											<div>
												<strong>{item.name}</strong>
												<code>{item.id}</code>
											</div>
											<p>{item.purpose}</p>
										</div>
									))}
								</section>

								<section className="catalog-section">
									<div className="catalog-heading">
										<span>02</span>
										<div>
											<h3>Model router</h3>
											<p>The final selector inside each Clef-chosen pool.</p>
										</div>
									</div>
									<div className="catalog-model router">
										<div>
											<strong>{modelCatalog.router.name}</strong>
											<code>{modelCatalog.router.id}</code>
										</div>
										<p>{modelCatalog.router.purpose}</p>
									</div>
								</section>

								<section className="catalog-section">
									<div className="catalog-heading">
										<span>03</span>
										<div>
											<h3>Answer models</h3>
											<p>All open-weight models eligible across route pools.</p>
										</div>
									</div>
									<div className="catalog-model-list">
										{allCatalogModels.map((modelId) => {
											const routes = (
												["simple", "complex", "tool"] as const
											).filter((pool) =>
												modelCatalog.pools[pool].includes(modelId),
											);
											return (
												<div className="catalog-model" key={modelId}>
													<code>{modelId}</code>
													<div className="route-tags">
														{routes.map((routeName) => (
															<span key={routeName}>{routeName}</span>
														))}
													</div>
												</div>
											);
										})}
									</div>
								</section>

								<section className="catalog-section">
									<div className="catalog-heading">
										<span>04</span>
										<div>
											<h3>Decision pools</h3>
											<p>The exact candidates Auto Router receives per route.</p>
										</div>
									</div>
									<div className="pool-grid">
										{(["simple", "complex", "tool"] as const).map((pool) => (
											<div className="pool-card" key={pool}>
												<strong>{pool}</strong>
												<span>{modelCatalog.pools[pool].length} models</span>
												{modelCatalog.pools[pool].map((modelId) => (
													<code key={modelId}>{modelId}</code>
												))}
											</div>
										))}
									</div>
								</section>
							</div>
						) : (
							<p className="catalog-loading">Loading model catalog…</p>
						)}
					</section>
				</div>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
