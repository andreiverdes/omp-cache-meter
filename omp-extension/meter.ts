import type { Model, Usage } from "./host";
import type { MeterSettings } from "./settings";
import type { Block, Cell, Item, Span, Tone, View } from "./view";

export type Tier = "short" | "long";
export type WarmingMode = "off" | "streaming" | "idle";
export type Retention = "auto" | "short" | "long" | "none";
/** `compacted`: /compact replaced the conversation after the last request, so the cached prefix is no longer used. */
export type Stage = "warm" | "expiring" | "cold" | "compacted";

export interface Req {
	at: number;
	kind: "turn" | "warm";
	read: number;
	write: number;
	uncached: number;
	cost: number;
	/** The first turn after a compaction: its cache write is the new prefix, not a miss. */
	afterCompact?: true;
}

/** USD per token. */
interface Price {
	input: number;
	read: number;
	write: number;
}

const TEN_S = 10_000;
const IDLE_WINDOW_MS = 30 * 60_000; // omp stops idle warming 30 min after the last request
const RUN_LIMIT_MS = 60 * 60_000; // omp never schedules a refresh more than 1 h out
const LONG_WRITE_FACTOR = 1.6; // Anthropic 1h writes cost 2× input, 5m writes 1.25×

/** Per-session request history and running totals; rebuilt from the session branch on load. */
export class Tracker {
	history: Req[] = [];
	totals = { saved: 0, warmCost: 0, warms: 0, misses: 0, missCost: 0 };
	observedTier: Tier | undefined;
	/** Tier the latest request asked for (`cache_control.ttl`); survives resets, it follows the credential. */
	requestedTier: Tier | undefined;
	/** Last warming decision or stop omp reported, with when it happened. */
	decision: { at: number; action: "warm" | "stop"; warmCost: number; missCost: number } | undefined;
	stopped: { at: number; reason: string } | undefined;
	/** The latest compaction, until the next turn sends the new prefix. */
	compacted: { at: number; tokensBefore: number; tokensAfter: number | undefined } | undefined;

	reset(): void {
		this.history = [];
		this.totals = { saved: 0, warmCost: 0, warms: 0, misses: 0, missCost: 0 };
		this.observedTier = undefined;
		this.decision = undefined;
		this.stopped = undefined;
		this.compacted = undefined;
	}

	/** Adds one request; returns false when it carried no prompt tokens (errors, aborts). */
	record(kind: Req["kind"], usage: Usage, at: number, model: Model | undefined): boolean {
		const r: Req = { at, kind, read: usage.cacheRead, write: usage.cacheWrite, uncached: usage.input, cost: usage.cost.total };
		if (r.read + r.write + r.uncached === 0) return false;
		const price = priceOf(model, this.requestedTier ?? this.observedTier);
		if (usage.cttl?.ephemeral1h) this.observedTier = "long";
		else if (usage.cttl?.ephemeral5m) this.observedTier = "short";
		this.totals.saved += r.read * (price.input - price.read);
		if (kind === "warm") {
			this.totals.warms++;
			this.totals.warmCost += r.cost;
		}
		if (kind === "turn" && this.compacted) {
			r.afterCompact = true;
			this.compacted = undefined;
		} else if (this.history.length > 0 && r.read === 0 && r.write > 0) {
			this.totals.misses++;
			this.totals.missCost += r.write * price.write;
		}
		this.history.push(r);
		return true;
	}
}

/**
 * The cache tier an Anthropic Messages payload requests: `cache_control.ttl` on a system block or the last
 * message's content. Other payload shapes yield undefined.
 */
export function requestedTier(payload: unknown): Tier | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const blocks: unknown[] = [];
	if ("system" in payload && Array.isArray(payload.system)) blocks.push(...payload.system);
	if ("messages" in payload && Array.isArray(payload.messages)) {
		const last: unknown = payload.messages.at(-1);
		if (typeof last === "object" && last !== null && "content" in last && Array.isArray(last.content)) blocks.push(...last.content);
	}
	for (const b of blocks) {
		if (typeof b !== "object" || b === null || !("cache_control" in b)) continue;
		const cc: unknown = b.cache_control;
		if (typeof cc !== "object" || cc === null) continue;
		return "ttl" in cc && cc.ttl === "1h" ? "long" : "short";
	}
	return undefined;
}

function priceOf(model: Model | undefined, tier: Tier | undefined): Price {
	const c = model?.cost;
	if (!c) return { input: 0, read: 0, write: 0 };
	const longFactor = tier === "long" && model?.api === "anthropic-messages" ? LONG_WRITE_FACTOR : 1;
	return { input: c.input / 1e6, read: c.cacheRead / 1e6, write: (c.cacheWrite / 1e6) * longFactor };
}

export interface Env {
	now: number;
	settings: MeterSettings;
	model: Model | undefined;
	retention: Retention;
	warmingMode: WarmingMode;
	agentRunning: boolean;
}

/** Everything the meter, the panel and Tern show; time-dependent fields are computed from `now`. */
export interface Snapshot {
	last: Req & { total: number; hitPct: number };
	/** The prefix the next request sends: the last request's prompt, or the compacted context after /compact. */
	prefixTokens: number;
	tier: Tier;
	tierSource: "observed" | "assumed";
	/** "5m tier", "1h tier (assumed)". */
	tierLabel: string;
	ttlMs: number;
	expiresAt: number;
	leftMs: number;
	rewriteCost: number;
	coldAdvice: "compact" | "keep going";
	/** `reason` says, in plain words, why no refresh is planned; undefined while one is. */
	warming: { scheduled: boolean; nextWarmAt: number | undefined; summary: string; reason: string | undefined };
	stage: Stage;
	advice: "keep going" | "send now" | "compact";
	/** Set while a compaction is newer than the last request; `tokensAfter` is omp's estimate when it has one. */
	compacted: { tokensBefore: number; tokensAfter: number | undefined } | undefined;
	cachingOff: boolean;
}

/** omp's refresh delay for an entry lifetime (cache-warmer.ts): 90 % of it, at least 10 s before expiry. */
export function warmDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= TEN_S) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - TEN_S)));
}

export function snapshot(t: Tracker, env: Env): Snapshot | undefined {
	const last = t.history.at(-1);
	if (!last) return undefined;
	const total = last.read + last.write + last.uncached;
	const known = t.requestedTier ?? t.observedTier;
	const tier: Tier = known ?? (env.retention === "long" ? "long" : "short");
	const declared = env.model?.promptCache?.[tier];
	const ttlMs = (declared ?? (tier === "long" ? 3600 : 300)) * 1000;
	const expiresAt = last.at + ttlMs;
	const leftMs = expiresAt - env.now;
	// After /compact the next request sends the summary instead of the cached conversation: a new prefix.
	const compacted = t.compacted && t.compacted.at >= last.at ? t.compacted : undefined;
	const prefixTokens = compacted ? (compacted.tokensAfter ?? 0) : total;
	const rewriteCost = prefixTokens * priceOf(env.model, tier).write;

	// Mirror of omp's warmer rules (cache-warmer.ts); omp does not expose its live status to extensions.
	const delay = warmDelayMs(ttlMs);
	const nextWarmAt = delay === undefined ? undefined : last.at + delay;
	let reason: string | undefined;
	if (env.retention === "none") reason = "prompt caching is off";
	else if (env.warmingMode === "off") reason = "cache warming is off in /settings";
	else if (declared === undefined || nextWarmAt === undefined) reason = "the model declares no cache lifetime";
	else if (t.stopped && t.stopped.at >= last.at) reason = t.stopped.reason;
	else if (t.decision && t.decision.at >= last.at && t.decision.action === "stop") reason = "omp judged a refresh not worth it";
	else if (env.agentRunning) {
		if (nextWarmAt > last.at + RUN_LIMIT_MS) reason = "past omp's 1 h refresh limit";
	} else if (env.warmingMode === "streaming") reason = "streaming warming stops when you go idle";
	else if (delay !== undefined && delay >= IDLE_WINDOW_MS) reason = "omp only refreshes 5m caches while idle, and this one is 1h";
	else if (nextWarmAt > last.at + IDLE_WINDOW_MS) reason = "omp stops refreshing 30 min after your last message";
	const scheduled = reason === undefined && !compacted && nextWarmAt !== undefined && nextWarmAt > env.now;
	// No rule fired but the refresh time passed: after refreshes, the 30 min idle limit; otherwise omp never got to it.
	if (!scheduled && reason === undefined) reason = last.kind === "warm" ? "omp stops refreshing 30 min after your last message" : "no refresh ran in time";
	let summary: string;
	if (scheduled && delay !== undefined) {
		summary = `warming at ${clock((ttlMs - delay) / 1000)} left`;
		const d = t.decision;
		if (d && d.at >= last.at) summary += ` · refresh $${d.warmCost.toFixed(2)} vs miss $${d.missCost.toFixed(2)}`;
	} else {
		summary = compacted ? "old prefix dropped by /compact" : `not warmed: ${reason}`;
	}

	const { rule, tokenThreshold, dollarThreshold } = env.settings.advice;
	const byTokens = tokenThreshold > 0 && prefixTokens >= tokenThreshold;
	const byDollars = dollarThreshold > 0 && rewriteCost >= dollarThreshold;
	const compact = rule === "tokens" ? byTokens : rule === "dollars" ? byDollars : byTokens || byDollars;
	const coldAdvice = compact ? "compact" : "keep going";

	const leadMs = env.settings.meter.warnLeadSeconds * 1000;
	const stage: Stage = compacted ? "compacted" : leftMs <= 0 ? "cold" : leftMs <= leadMs && !scheduled ? "expiring" : "warm";
	const advice = stage === "cold" ? coldAdvice : stage === "expiring" ? "send now" : "keep going";
	return {
		last: { ...last, total, hitPct: total > 0 ? (100 * last.read) / total : 0 },
		prefixTokens,
		tier,
		tierSource: known ? "observed" : "assumed",
		tierLabel: `${tier === "long" ? "1h" : "5m"} tier${known ? "" : " (assumed)"}`,
		ttlMs,
		expiresAt,
		leftMs,
		rewriteCost,
		coldAdvice,
		warming: { scheduled, nextWarmAt, summary, reason: scheduled ? undefined : reason },
		stage,
		advice,
		compacted: compacted && { tokensBefore: compacted.tokensBefore, tokensAfter: compacted.tokensAfter },
		cachingOff: env.retention === "none",
	};
}

// ── views ──────────────────────────────────────────────────────────────────
// Renderers build a View (view.ts) once; toAnsi pads it for the terminal TUI, toTsp describes it for native
// hosts such as Tern.

export function tokens(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

export function clock(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A past span: `4:12` under an hour, then `3h 05m`, then `2d 4h`. */
export function elapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	if (s < 3600) return clock(s);
	if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** The colour of a stage: the meter's edge, badge, countdown and advice. */
export function stageTone(stage: Stage): Tone {
	return stage === "cold" ? "error" : stage === "expiring" ? "warning" : stage === "compacted" ? "accent" : "success";
}

const STAGE_BADGE: Record<Stage, string> = { warm: "warm", expiring: "expiring", cold: "cold", compacted: "reset by /compact" };
const muted = (text: string): Span[] => [{ text, tone: "muted" }];

/**
 * The meter above the composer: a title bar (stage badge left, what to do right) over a table whose
 * columns line up labels, values, bars and details. Empty when settings hide it now.
 */
export function renderMeter(s: Snapshot, settings: MeterSettings): View {
	const tone = stageTone(s.stage);
	const show = settings.meter.show;
	if (show === "off" || (show === "near-expiry" && (s.stage === "warm" || s.stage === "compacted"))) return { tone, blocks: [] };
	if (s.cachingOff) return { tone: "muted", blocks: [{ kind: "bar", left: [muted("⛁ prompt caching off")], right: [muted("providers.cacheRetention: none")] }] };
	const cost = `$${s.rewriteCost.toFixed(2)}`;
	const title: Item[] = [[{ text: "⛁ prompt cache", tone: "strong" }], { badge: STAGE_BADGE[s.stage], tone }];
	const keepGoing: Item = [{ text: "✓ keep going", tone: "success" }];

	if (settings.meter.size === "compact") {
		const detail =
			s.stage === "cold" ? `rewrite ≈ ${cost}` : s.stage === "compacted" ? `new prefix ≈ ${cost}` : `${s.last.hitPct.toFixed(1)}% hit · ${clock(s.leftMs / 1000)}`;
		const advice: Item = s.advice === "compact" ? [{ text: "→ /compact", tone }] : s.advice === "send now" ? [{ text: "→ send now", tone }] : keepGoing;
		return { tone, blocks: [{ kind: "bar", left: [...title, muted(detail)], right: [advice] }] };
	}

	if (s.compacted) {
		const { tokensBefore, tokensAfter } = s.compacted;
		return {
			tone,
			blocks: [
				{ kind: "bar", left: title, right: [keepGoing] },
				{
					kind: "table",
					cols: [{}, { align: "end" }, { grow: true, priority: -1 }],
					rows: [
						tokensAfter === undefined
							? [muted("conversation"), [{ text: tokens(tokensBefore) }], muted("tokens before the summary")]
							: [muted("conversation"), [{ text: `${tokens(tokensBefore)} → ${tokens(tokensAfter)}` }], muted("tokens before → after the summary")],
						[muted("next request"), [{ text: tokensAfter === undefined ? "–" : `≈ ${cost}` }], muted("writes the new prefix to the cache")],
					],
				},
			],
		};
	}

	if (s.stage === "cold") {
		const compact = s.coldAdvice === "compact";
		const recommended: Span[] = [{ text: "✓ recommended", tone: "success" }];
		return {
			tone,
			blocks: [
				{
					kind: "bar",
					left: [...title, muted(`expired ${elapsed(-s.leftMs / 1000)} ago`)],
					right: [[{ text: "next message re-sends ", tone: "muted" }, { text: `${tokens(s.prefixTokens)} tokens` }, { text: " ≈ ", tone: "muted" }, { text: cost, tone: "warning" }]],
				},
				{
					kind: "table",
					cols: [{}, { grow: true }, { align: "end" }],
					rows: [
						[[{ text: "keep going", tone: "accent" }], muted(`send as usual; pays ${cost} once, then it's cached again`), compact ? [] : recommended],
						[[{ text: "/compact", tone: "accent" }], muted("summarise first; later turns send far fewer tokens"), compact ? recommended : []],
						[[{ text: "/new", tone: "accent" }], muted("fresh session; best when this task is finished"), []],
					],
				},
				{ kind: "bar", left: [muted(`why: ${s.warming.reason ?? "the cache expired"}`)], right: [muted("/cache settings")] },
			],
		};
	}

	const expiring = s.stage === "expiring";
	const total = s.last.total || 1;
	// A planned refresh is worth showing; why a cache won't be warmed only matters once it is about to expire.
	const lifetime = s.warming.scheduled || expiring ? `${s.tierLabel} · ${s.warming.summary}` : s.tierLabel;
	const rows: Cell[][] = [
		[
			muted("last request"),
			[{ text: `${s.last.hitPct.toFixed(1)}% hit`, tone: "success" }],
			{ bar: [[s.last.read / total, "success"], [s.last.write / total, "accent"], [s.last.uncached / total, "warning"]] },
			[...muted("read "), { text: tokens(s.last.read) }, ...muted("  write "), { text: tokens(s.last.write) }, ...muted("  uncached "), { text: tokens(s.last.uncached) }],
		],
		[muted("expires in"), [{ text: clock(s.leftMs / 1000), tone }], settings.meter.countdownBar ? { bar: [[Math.max(0, s.leftMs) / s.ttlMs, tone]] } : [], muted(lifetime)],
	];
	if (expiring) rows.push([muted("if it expires"), [{ text: cost, tone: "warning" }], [], muted(`the next turn rewrites ${tokens(s.prefixTokens)} tokens`)]);
	return {
		tone,
		blocks: [
			{ kind: "bar", left: title, right: [expiring ? [{ text: "→ send now to keep it", tone: "warning" }] : keepGoing] },
			{ kind: "table", cols: [{}, { align: "end" }, {}, { grow: true, priority: -1 }], rows },
		],
	};
}

/** The `/cache` panel: a title bar, session totals and the latest requests as tables, and the commands. */
export function renderPanel(t: Tracker, s: Snapshot | undefined, model: Model | undefined, mode: WarmingMode): View {
	const about = [model ? `${model.provider} · ${model.id}` : undefined, s?.tierLabel, `warming ${mode}`].filter(Boolean).join(" · ");
	const header: Block = { kind: "bar", left: [[{ text: "⛁ Prompt cache · this session", tone: "strong" }]], right: [muted(about)] };
	if (!s) return { tone: "accent", blocks: [header, { kind: "gap" }, { kind: "bar", left: [muted("No requests yet.")], right: [] }] };
	let read = 0;
	let all = 0;
	for (const r of t.history) {
		read += r.read;
		all += r.read + r.write + r.uncached;
	}
	const k = t.totals;
	const kpis: Block = {
		kind: "table",
		cols: [{ head: "session hit" }, { head: "saved by the cache" }, { head: "warming", priority: -2 }, { head: "misses", priority: -1 }],
		rows: [
			[
				[{ text: `${all > 0 ? ((100 * read) / all).toFixed(1) : "0.0"}%`, tone: "success" }],
				[{ text: `$${k.saved.toFixed(2)}` }],
				[{ text: `$${k.warmCost.toFixed(2)}` }, ...muted(` · ${k.warms} ${k.warms === 1 ? "refresh" : "refreshes"}`)],
				[{ text: String(k.misses), tone: k.misses > 0 ? "warning" : undefined }, ...muted(` · $${k.missCost.toFixed(2)} rewrites`)],
			],
		],
	};
	const recent = t.history.slice(-8);
	let turn = t.history.filter(r => r.kind === "turn").length - recent.filter(r => r.kind === "turn").length;
	const rows: Cell[][] = recent.map((r, i) => {
		const total = r.read + r.write + r.uncached;
		const miss = !r.afterCompact && (i > 0 || t.history.length > recent.length) && r.read === 0 && r.write > 0;
		return [
			muted(new Date(r.at).toTimeString().slice(0, 8)),
			r.kind === "warm" ? [{ text: "warm", tone: "accent" }] : [{ text: `turn ${++turn}` }],
			{ bar: [[r.read / total, "success"], [r.write / total, "accent"], [r.uncached / total, "warning"]] },
			[{ text: tokens(r.read) }],
			[{ text: tokens(r.write) }],
			[{ text: tokens(r.uncached) }],
			[{ text: `${((100 * r.read) / total).toFixed(1)}%`, tone: r.read / total >= 0.9 ? undefined : "warning" }],
			[{ text: `$${r.cost.toFixed(2)}` }],
			r.afterCompact ? [{ text: "after /compact", tone: "accent" }] : miss ? [{ text: "miss", tone: "error" }] : [],
		];
	});
	const end = { align: "end" } as const;
	const requests: Block = {
		kind: "table",
		cols: [{ head: "time" }, { head: "request" }, { head: "split", priority: -1 }, { head: "read", ...end }, { head: "write", ...end }, { head: "uncached", ...end, priority: -2 }, { head: "hit", ...end }, { head: "cost", ...end }, { head: "" }],
		rows,
	};
	const footer: Block = { kind: "bar", left: ["/cache closes", "/cache settings", "/compact", "/new"].map(text => muted(text)), right: [] };
	return { tone: "accent", blocks: [header, { kind: "gap" }, kpis, { kind: "gap" }, requests, { kind: "gap" }, footer] };
}
