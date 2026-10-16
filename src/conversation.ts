import { DurableObject } from "cloudflare:workers";

export type MessageRole = "user" | "assistant";

const MAX_USER_MESSAGE_LENGTH = 4_000;
const MAX_ASSISTANT_MESSAGE_LENGTH = 32_000;
const MAX_STORED_MESSAGES = 40;

export type StoredMessage = {
	id: number;
	role: MessageRole;
	content: string;
	createdAt: number;
};

type MessageRow = {
	id: number;
	role: MessageRole;
	content: string;
	created_at: number;
};

export class Conversation extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	private hasSchema(): boolean {
		return (
			this.ctx.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
				)
				.toArray().length > 0
		);
	}

	private initializeSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
				content TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
	}

	listMessages(): StoredMessage[] {
		if (!this.hasSchema()) return [];
		return this.ctx.storage.sql
			.exec<MessageRow>(
				"SELECT id, role, content, created_at FROM messages ORDER BY id",
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				role: row.role,
				content: row.content,
				createdAt: row.created_at,
			}));
	}

	appendMessage(role: MessageRole, content: string): void {
		this.initializeSchema();
		const maxLength =
			role === "user" ? MAX_USER_MESSAGE_LENGTH : MAX_ASSISTANT_MESSAGE_LENGTH;
		if (
			(role !== "user" && role !== "assistant") ||
			typeof content !== "string" ||
			!content.trim() ||
			content.length > maxLength
		) {
			throw new Error("Invalid message");
		}

		this.ctx.storage.sql.exec(
			"INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
			role,
			content.trim(),
			Date.now(),
		);
		this.ctx.storage.sql.exec(
			`DELETE FROM messages
			 WHERE id NOT IN (
				SELECT id FROM messages ORDER BY id DESC LIMIT ?
			 )`,
			MAX_STORED_MESSAGES,
		);
	}

	clearMessages(): void {
		if (!this.hasSchema()) return;
		this.ctx.storage.sql.exec("DELETE FROM messages");
	}

	async deleteConversation(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}