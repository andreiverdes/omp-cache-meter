// The slice of omp's extension API this extension uses, typed from omp's docs (extensions.md, session.md,
// rpc.md) and observed in omp 18.12.0. omp ships no type package this repo can import.

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
	/** Anthropic cache-write split by entry lifetime; present when the request wrote cache. */
	cttl?: { ephemeral5m?: number; ephemeral1h?: number };
}

export interface Model {
	id: string;
	provider: string;
	api: string;
	/** USD per million tokens. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Cache entry lifetime in seconds per retention tier. */
	promptCache?: { short?: number; long?: number };
}

export interface Theme {
	fg(token: "success" | "warning" | "error" | "accent" | "muted" | "borderMuted" | "text", text: string): string;
}

export interface Component {
	render(width: number): string[];
	/** The node native hosts (Tern) draw instead of `render`'s terminal lines. */
	describe?(capabilities: unknown): unknown;
	invalidate(): void;
}

export interface Tui {
	requestRender(): void;
}

export type WidgetContent = string[] | ((tui: Tui, theme: Theme) => Component);

export interface ExtensionUI {
	setWidget(key: string, content: WidgetContent | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export type SessionEntry =
	| { type: "message"; timestamp: string; message: { role: string; provider?: string; model?: string; usage?: Usage } }
	| { type: "model_usage"; timestamp: string; purpose: string; provider: string; model: string; usage: Usage }
	| { type: "compaction" | "custom" | "custom_message" | "branch_summary" | "model_change"; timestamp: string };

export interface ExtensionContext {
	ui: ExtensionUI;
	hasUI: boolean;
	cwd: string;
	readonly model: Model | undefined;
	isIdle(): boolean;
	sessionManager: { getBranch(): SessionEntry[] };
	setInterval(fn: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
}

export interface MessageEndEvent {
	message: { role: string; provider?: string; model?: string; usage?: Usage };
}

export interface CacheWarmingDecisionEvent {
	warmCost: number;
	missCost: number;
	continuationProbability: number;
	action: "warm" | "stop";
}

export interface CacheWarmingEndEvent {
	provider: string;
	model: string;
	outcome: "hit" | "miss" | "error" | "aborted";
	usage?: Usage;
	warmingStopReason?: string;
}

export interface CommandDef {
	description: string;
	getArgumentCompletions?(prefix: string): { label: string; value: string; description?: string }[] | null;
	handler(args: string, ctx: ExtensionContext): Promise<void>;
}

type Handler<E> = (event: E, ctx: ExtensionContext) => unknown;

export interface ExtensionAPI {
	pi: { settings: unknown };
	on(event: "session_start" | "session_switch" | "session_branch" | "session_tree" | "session_shutdown", handler: Handler<unknown>): void;
	on(event: "agent_start" | "agent_end", handler: Handler<unknown>): void;
	on(event: "message_end", handler: Handler<MessageEndEvent>): void;
	on(event: "before_provider_request", handler: Handler<{ payload: unknown }>): void;
	on(event: "cache_warming_decision", handler: Handler<CacheWarmingDecisionEvent>): void;
	on(event: "cache_warming_end", handler: Handler<CacheWarmingEndEvent>): void;
	registerCommand(name: string, def: CommandDef): void;
}
