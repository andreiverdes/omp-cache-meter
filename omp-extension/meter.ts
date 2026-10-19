import type { Model, Theme, Usage } from "./host";
import type { MeterSettings } from "./settings";

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
	warming: { scheduled: boolean; nextWarmAt: number | undefined; summary: string };
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
	if (env.retention === "none") reason = "prompt caching off";
	else if (env.warmingMode === "off") reason = "warming off";
	else if (declared === undefined || nextWarmAt === undefined) reason = "model declares no cache lifetime";
	else if (t.stopped && t.stopped.at >= last.at) reason = t.stopped.reason;
	else if (t.decision && t.decision.at >= last.at && t.decision.action === "stop") reason = "refresh not worth it";
	else if (env.agentRunning) {
		if (nextWarmAt > last.at + RUN_LIMIT_MS) reason = "past the 1 h limit";
	} else if (env.warmingMode === "streaming") reason = "streaming mode stops when idle";
	else if (delay !== undefined && delay >= IDLE_WINDOW_MS) reason = "idle warming covers 5m entries only";
	else if (nextWarmAt > last.at + IDLE_WINDOW_MS) reason = "past the 30 min idle window";
	const scheduled = reason === undefined && !compacted && nextWarmAt !== undefined && nextWarmAt > env.now;
	let summary: string;
	if (scheduled && delay !== undefined) {
		summary = `warming at ${clock((ttlMs - delay) / 1000)} left`;
		const d = t.decision;
		if (d && d.at >= last.at) summary += ` · refresh $${d.warmCost.toFixed(2)} vs miss $${d.missCost.toFixed(2)}`;
	} else {
		summary = compacted ? "old prefix dropped by /compact" : `not warmed: ${reason ?? "refresh window passed"}`;
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
		warming: { scheduled, nextWarmAt, summary },
		stage,
		advice,
		compacted: compacted && { tokensBefore: compacted.tokensBefore, tokensAfter: compacted.tokensAfter },
		cachingOff: env.retention === "none",
	};
}

// ── formatting ─────────────────────────────────────────────────────────────
// Renderers build Lines of Spans once; toAnsi paints them for the terminal TUI with the omp theme, toTsp
// describes them for native hosts such as Tern, which paint them with their own theme.

export type Tone = "success" | "warning" | "error" | "accent" | "muted" | "strong";
export interface Span {
	text: string;
	tone?: Tone;
}
/** Spans kept together; when a line is too wide, whole trailing groups are dropped. */
export type Group = Span[];
export type Line = Group[];

export function tokens(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(Math.round(n));
}

export function clock(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const GAP = "   "; // between groups on a line

/**
 * A thin stacked bar of `cells` cells; parts are [fraction, tone]; the rest is a muted track. Line glyphs
 * keep stacked rows from merging into one block, unlike full blocks.
 */
function bar(cells: number, parts: [number, Tone][]): Group {
	const out: Group = [];
	let used = 0;
	for (const [frac, tone] of parts) {
		const n = Math.min(cells - used, Math.round(frac * cells));
		if (n > 0) out.push({ text: "━".repeat(n), tone });
		used += n;
	}
	if (cells > used) out.push({ text: "─".repeat(cells - used), tone: "muted" });
	return out;
}

/** The colour of a stage: the meter's edge, countdown and advice. */
export function stageTone(stage: Stage): Tone {
	return stage === "cold" ? "error" : stage === "expiring" ? "warning" : stage === "compacted" ? "accent" : "success";
}

/** The 0–3 line meter above the composer; empty when settings hide it now. */
export function renderMeter(s: Snapshot, settings: MeterSettings): Line[] {
	const show = settings.meter.show;
	if (show === "off" || (show === "near-expiry" && (s.stage === "warm" || s.stage === "compacted"))) return [];
	if (s.cachingOff) return [[[{ text: "prompt caching off · providers.cacheRetention: none", tone: "muted" }]]];
	const tone = stageTone(s.stage);
	const left = clock(s.leftMs / 1000);
	const cost = `$${s.rewriteCost.toFixed(2)}`;
	const rewrite = `${tokens(s.prefixTokens)} tokens ≈ ${cost}`;

	if (s.compacted) {
		const after = s.compacted.tokensAfter;
		if (settings.meter.size === "compact") return [[[{ text: `⛁ cache reset by /compact${after === undefined ? "" : ` · new prefix ≈ ${cost}`}`, tone }], [{ text: "✓ keep going", tone }]]];
		const sizes = after === undefined ? `was ${tokens(s.compacted.tokensBefore)} tokens` : `${tokens(s.compacted.tokensBefore)} → ${tokens(after)} tokens`;
		const next: Group = [{ text: "next request writes the new prefix", tone: "muted" }];
		if (after !== undefined) next.push({ text: " " }, { text: rewrite });
		return [
			[[{ text: "⛁ prompt cache reset by /compact", tone }], [{ text: sizes, tone: "muted" }]],
			[next, [{ text: "✓ keep going", tone: "success" }]],
		];
	}

	if (settings.meter.size === "compact") {
		const head = s.stage === "cold" ? `⛁ cache cold · rewrite ≈ ${cost}` : `⛁ ${s.last.hitPct.toFixed(1)}% hit · ${left}`;
		const advice = s.advice === "compact" ? "→ /compact" : s.advice === "send now" ? "→ send now" : "✓ keep going";
		return [[[{ text: head, tone }], [{ text: advice, tone }]]];
	}
	if (s.stage === "cold") {
		const options: Line = [];
		if (s.coldAdvice === "compact") options.push([{ text: "/compact", tone: "accent" }, { text: " shrink first (recommended)", tone: "muted" }]);
		options.push([{ text: "/new", tone: "accent" }, { text: " task done", tone: "muted" }]);
		options.push([{ text: "keep going", tone: "accent" }, { text: ` pay ${cost} once${s.coldAdvice === "keep going" ? " (recommended)" : ""}`, tone: "muted" }]);
		return [
			[[{ text: "✕ prompt cache cold", tone: "error" }], [{ text: `expired ${clock(-s.leftMs / 1000)} ago`, tone: "muted" }], [{ text: "next request rewrites " , tone: "muted" }, { text: rewrite }]],
			options,
			[[{ text: s.warming.summary, tone: "muted" }], [{ text: "thresholds: /cache settings", tone: "muted" }]],
		];
	}

	const frac = (n: number) => (s.last.total > 0 ? n / s.last.total : 0);
	const value = (label: string, n: number): Span[] => [{ text: `${label} `, tone: "muted" }, { text: tokens(n) }];
	const line1: Line = [
		[{ text: "⛁ prompt cache", tone: "strong" }],
		[{ text: `${s.last.hitPct.toFixed(1)}% hit`, tone: "success" }],
		bar(12, [[frac(s.last.read), "success"], [frac(s.last.write), "accent"], [frac(s.last.uncached), "warning"]]),
		[...value("read", s.last.read), { text: " · ", tone: "muted" }, ...value("write", s.last.write), { text: " · ", tone: "muted" }, ...value("uncached", s.last.uncached)],
	];
	const expiring = s.stage === "expiring";
	const line2: Line = [[{ text: expiring ? "⚠ expires in " : "  expires in ", tone: expiring ? "warning" : "muted" }, { text: left, tone }]];
	if (settings.meter.countdownBar) line2.push(bar(12, [[Math.max(0, s.leftMs) / s.ttlMs, tone]]));
	line2.push([{ text: s.tierLabel, tone: "muted" }]);
	// A planned refresh is worth showing; why a cache won't be warmed only matters once it is about to expire.
	if (s.warming.scheduled) line2.push([{ text: s.warming.summary, tone: "muted" }]);
	if (!expiring) line2.push([{ text: "✓ keep going", tone: "success" }]);
	const lines = [line1, line2];
	if (expiring) {
		lines.push([[{ text: "→ send now to keep it", tone: "warning" }], [{ text: "or the next turn rewrites ", tone: "muted" }, { text: rewrite }], [{ text: s.warming.summary, tone: "muted" }]]);
	}
	return lines;
}

/** The `/cache` panel: session totals and the latest requests, in blank-line separated sections. */
export function renderPanel(t: Tracker, s: Snapshot | undefined, model: Model | undefined, mode: WarmingMode): Line[] {
	const about = [model ? `${model.provider} · ${model.id}` : undefined, s?.tierLabel, `warming ${mode}`].filter(Boolean).join(" · ");
	const header: Line = [[{ text: "⛁ Prompt cache · this session", tone: "strong" }], [{ text: about, tone: "muted" }]];
	if (!s) return [header, [], [[{ text: "No requests yet.", tone: "muted" }]]];
	let read = 0;
	let all = 0;
	for (const r of t.history) {
		read += r.read;
		all += r.read + r.write + r.uncached;
	}
	const k = t.totals;
	const kpis: Line = [
		[{ text: `${all > 0 ? ((100 * read) / all).toFixed(1) : "0.0"}%`, tone: "success" }, { text: " session hit", tone: "muted" }],
		[{ text: `$${k.saved.toFixed(2)}` }, { text: " saved by the cache", tone: "muted" }],
		[{ text: `$${k.warmCost.toFixed(2)}` }, { text: ` warming · ${k.warms} refreshes`, tone: "muted" }],
		[{ text: String(k.misses), tone: k.misses > 0 ? "warning" : undefined }, { text: ` misses · $${k.missCost.toFixed(2)} rewrites`, tone: "muted" }],
	];
	const col = (text: string, width: number, right = true): Span => ({ text: right ? text.padStart(width) : text.padEnd(width) });
	const rows: Line[] = [
		[[{ text: `${"time".padEnd(10)}${"request".padEnd(11)}${"split".padEnd(12)}${"read".padStart(9)}${"write".padStart(9)}${"uncached".padStart(10)}${"hit".padStart(8)}${"cost".padStart(9)}`, tone: "muted" }]],
	];
	const recent = t.history.slice(-8);
	let turn = t.history.filter(r => r.kind === "turn").length - recent.filter(r => r.kind === "turn").length;
	for (const [i, r] of recent.entries()) {
		const total = r.read + r.write + r.uncached;
		const miss = !r.afterCompact && (i > 0 || t.history.length > recent.length) && r.read === 0 && r.write > 0;
		const row: Group = [
			col(new Date(r.at).toTimeString().slice(0, 8), 10, false),
			r.kind === "warm" ? { text: "warm".padEnd(11), tone: "accent" } : col(`turn ${++turn}`, 11, false),
			...bar(10, [[r.read / total, "success"], [r.write / total, "accent"], [r.uncached / total, "warning"]]),
			{ text: "  " },
			col(tokens(r.read), 9),
			col(tokens(r.write), 9),
			col(tokens(r.uncached), 10),
			{ text: `${((100 * r.read) / total).toFixed(1)}%`.padStart(8), tone: r.read / total >= 0.9 ? undefined : "warning" },
			col(`$${r.cost.toFixed(2)}`, 9),
		];
		if (r.afterCompact) row.push({ text: "   after /compact", tone: "accent" });
		else if (miss) row.push({ text: "   miss", tone: "error" });
		rows.push([row]);
	}
	const footer: Line = ["/cache closes", "/cache settings", "/compact", "/new"].map(text => [{ text, tone: "muted" }]);
	return [header, [], kpis, [], ...rows, [], footer];
}

/**
 * Paints lines for the terminal: an edge mark and a space, whole groups while they fit `width`, and a
 * blank row after the block so it doesn't touch the composer.
 */
export function toAnsi(lines: Line[], theme: Theme, width: number, edgeTone: Tone): string[] {
	if (lines.length === 0) return [];
	const edge = theme.fg(edgeTone === "strong" ? "accent" : edgeTone, "▌");
	const painted = lines.map(line => {
		let out = `${edge} `;
		let used = 2;
		for (const [i, group] of line.entries()) {
			const len = group.reduce((n, sp) => n + sp.text.length, 0) + (i > 0 ? GAP.length : 0);
			if (used + len > width) break;
			out += (i > 0 ? GAP : "") + group.map(sp => (sp.tone && sp.tone !== "strong" ? theme.fg(sp.tone, sp.text) : sp.text)).join("");
			used += len;
		}
		return out;
	});
	return [...painted, ""];
}

/**
 * A native-surface node for the same lines (the `{k, p, c, key}` wire format omp's describe() uses). Each
 * line is a row of its groups, so a narrow pane wraps between groups instead of inside one.
 */
export function toTsp(lines: Line[], role: string, edgeTone: Tone): unknown {
	const span = (sp: Span) => (sp.tone ? { t: sp.text, s: sp.tone } : { t: sp.text });
	return {
		k: "col",
		p: { role, gap: "xs", tone: edgeTone === "strong" ? "accent" : edgeTone },
		c: [
			...lines.map((line, i) =>
				line.length === 0
					? { k: "text", p: { text: " " }, key: `l${i}` }
					: {
							k: "row",
							p: { gap: "md", wrap: true, align: "center" },
							c: line.map((group, g) => ({ k: "text", p: { spans: group.map(span) }, key: `g${g}` })),
							key: `l${i}`,
						},
			),
			{ k: "text", p: { text: " " }, key: "pad" },
		],
	};
}
