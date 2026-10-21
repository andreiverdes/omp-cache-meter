// A small layout model for the meter and the /cache panel, and its two painters: toAnsi pads it into aligned
// terminal lines with the omp theme; toTsp describes it as native nodes (rows, spacers, badges, tables) for
// hosts such as Tern, which lay it out and paint it with their own theme.
import type { Theme } from "./host";

export type Tone = "success" | "warning" | "error" | "accent" | "muted" | "strong";

export interface Span {
	text: string;
	tone?: Tone;
}
/** One item of a bar: spans kept together, or a badge (a chip natively, toned text in a terminal). */
export type Item = Span[] | { badge: string; tone: Tone };
/** A table cell: text, or a thin stacked bar of [fraction, tone] parts. */
export type Cell = Span[] | { bar: [number, Tone][] };

export interface Column {
	/** Header text; a table with no heads has no header row. */
	head?: string;
	align?: "start" | "end";
	/** Takes the spare width and is cut first when the table is too wide. */
	grow?: boolean;
	/** Columns with the lowest priority hide first when narrow (default 0). */
	priority?: number;
}

export type Block =
	/** `left` items from the left edge, `right` items flush right. */
	| { kind: "bar"; left: Item[]; right: Item[] }
	| { kind: "table"; cols: Column[]; rows: Cell[][] }
	| { kind: "gap" };

export interface View {
	/** The edge colour: the meter's stage, or accent for the panel. */
	tone: Tone;
	blocks: Block[];
}

const GAP = 3; // columns between items and between table columns in a terminal
const BAR_CELLS = 12; // width of a bar cell in a terminal

const isBar = (c: Cell): c is { bar: [number, Tone][] } => !Array.isArray(c);
const spansText = (spans: Span[]): string => spans.map(s => s.text).join("");

// ── terminal ───────────────────────────────────────────────────────────────

function paintSpans(spans: Span[], theme: Theme): string {
	return spans.map(s => (s.tone && s.tone !== "strong" ? theme.fg(s.tone, s.text) : s.text)).join("");
}

function paintItem(it: Item, theme: Theme): string {
	return Array.isArray(it) ? paintSpans(it, theme) : theme.fg(it.tone === "strong" ? "accent" : it.tone, it.badge);
}

/** Cuts spans to `width` columns, ending in `…` when anything was cut. */
function clip(spans: Span[], width: number): Span[] {
	if (spansText(spans).length <= width) return spans;
	const out: Span[] = [];
	let left = Math.max(0, width - 1);
	for (const s of spans) {
		if (left <= 0) break;
		out.push({ ...s, text: s.text.slice(0, left) });
		left -= s.text.length;
	}
	out.push({ text: "…", tone: "muted" });
	return out;
}

function barGlyphs(parts: [number, Tone][], theme: Theme): string {
	let out = "";
	let used = 0;
	for (const [frac, tone] of parts) {
		const n = Math.min(BAR_CELLS - used, Math.round(frac * BAR_CELLS));
		if (n > 0) out += theme.fg(tone === "strong" ? "accent" : tone, "━".repeat(n));
		used += Math.max(0, n);
	}
	return BAR_CELLS > used ? out + theme.fg("muted", "─".repeat(BAR_CELLS - used)) : out;
}

/** Left items, then right items flush right; trailing items drop (right first) when they don't fit. */
function paintBar(left: Item[], right: Item[], theme: Theme, width: number): string {
	const widthOf = (items: Item[]) => items.reduce((n, it, i) => n + (Array.isArray(it) ? spansText(it) : it.badge).length + (i > 0 ? GAP : 0), 0);
	const l = [...left];
	const r = [...right];
	while (r.length > 0 && widthOf(l) + GAP + widthOf(r) > width) r.pop();
	while (l.length > 1 && widthOf(l) > width) l.pop();
	// A lone item still too wide is cut rather than overflowing the line.
	const lone = l[0];
	if (l.length === 1 && Array.isArray(lone) && widthOf(l) > width) l[0] = clip(lone, width);
	const pad = " ".repeat(GAP);
	let out = l.map(it => paintItem(it, theme)).join(pad);
	if (r.length > 0) out += " ".repeat(width - widthOf(l) - widthOf(r)) + r.map(it => paintItem(it, theme)).join(pad);
	return out;
}

/** Columns sized to their widest cell; when too wide, low-priority columns hide, then the grow column is cut. */
function paintTable(cols: Column[], rows: Cell[][], theme: Theme, width: number): string[] {
	const heads = cols.some(c => c.head);
	const widths = cols.map((c, i) =>
		Math.max(heads ? (c.head ?? "").length : 0, ...rows.map(r => (r[i] === undefined ? 0 : isBar(r[i]) ? BAR_CELLS : spansText(r[i]).length))),
	);
	const shown = cols.map((_, i) => i);
	const total = () => shown.reduce((n, i, k) => n + widths[i] + (k > 0 ? GAP : 0), 0);
	const byPriority = [...shown].sort((a, b) => (cols[a].priority ?? 0) - (cols[b].priority ?? 0));
	for (const i of byPriority) {
		if (total() <= width || (cols[i].priority ?? 0) >= 0) break;
		shown.splice(shown.indexOf(i), 1);
	}
	const grow = shown.find(i => cols[i].grow);
	if (grow !== undefined && total() > width) widths[grow] = Math.max(4, widths[grow] - (total() - width));

	const line = (cells: (i: number) => { text: string; painted: string }): string =>
		shown
			.map((i, k) => {
				const { text, painted } = cells(i);
				const pad = " ".repeat(Math.max(0, widths[i] - text.length));
				const last = k === shown.length - 1;
				return cols[i].align === "end" ? pad + painted : last ? painted : painted + pad;
			})
			.join(" ".repeat(GAP))
			.replace(/ +$/, ""); // an empty last column leaves only padding
	const out: string[] = [];
	if (heads) {
		out.push(line(i => {
			const h = (cols[i].head ?? "").slice(0, widths[i]);
			return { text: h, painted: theme.fg("muted", h) };
		}));
	}
	for (const row of rows) {
		out.push(line(i => {
			const c = row[i] ?? [];
			if (isBar(c)) return { text: "".padEnd(BAR_CELLS), painted: barGlyphs(c.bar, theme) };
			const cut = clip(c, widths[i]);
			return { text: spansText(cut), painted: paintSpans(cut, theme) };
		}));
	}
	return out;
}

/** Terminal lines: an edge mark and a space before each, and a blank row after so it doesn't touch the composer. */
export function toAnsi(view: View, theme: Theme, width: number): string[] {
	if (view.blocks.length === 0) return [];
	const edge = `${theme.fg(view.tone === "strong" ? "accent" : view.tone, "▌")} `;
	const inner = Math.max(10, width - 2);
	const out: string[] = [];
	for (const b of view.blocks) {
		if (b.kind === "gap") out.push(edge);
		else if (b.kind === "bar") out.push(edge + paintBar(b.left, b.right, theme, inner));
		else for (const l of paintTable(b.cols, b.rows, theme, inner)) out.push(edge + l);
	}
	return [...out, ""];
}

// ── native (TSP) ───────────────────────────────────────────────────────────

function tspItem(it: Item, key: string): unknown {
	if (!Array.isArray(it)) return { k: "badge", p: { text: it.badge, tone: it.tone }, key };
	return { k: "text", p: { spans: it.map(s => (s.tone ? { t: s.text, s: s.tone } : { t: s.text })) }, key };
}

function tspBlock(b: Block, key: string): unknown {
	if (b.kind === "gap") return { k: "spacer", p: { size: "sm" }, key };
	if (b.kind === "bar") {
		return {
			k: "row",
			p: { gap: "md", wrap: true, align: "center" },
			c: [
				...b.left.map((it, i) => tspItem(it, `l${i}`)),
				{ k: "spacer", p: { grow: 1 }, key: "fill" },
				...b.right.map((it, i) => tspItem(it, `r${i}`)),
			],
			key,
		};
	}
	return {
		k: "table",
		p: {
			cols: b.cols.map((c, i) => ({
				id: `c${i}`,
				// A head on any column turns on the header row; a headless table sends none.
				...(c.head !== undefined ? { head: c.head } : {}),
				align: c.align ?? "start",
				grow: c.grow ? 1 : 0,
				priority: c.priority ?? 0,
				truncate: "end",
			})),
			rows: b.rows.map((row, r) => ({
				id: `r${r}`,
				cells: Object.fromEntries(
					row.map((c, i) => [
						`c${i}`,
						isBar(c) ? { meter: { parts: c.bar.map(([value, token]) => ({ value, token })) } } : c.map(s => (s.tone ? { t: s.text, s: s.tone } : { t: s.text })),
					]),
				),
			})),
		},
		key,
	};
}

/** A native-surface node for the view (the `{k, p, c, key}` wire format omp's describe() uses). */
export function toTsp(view: View, role: string): unknown {
	return {
		k: "col",
		p: { role, gap: "xs", tone: view.tone === "strong" ? "accent" : view.tone },
		c: [...view.blocks.map((b, i) => tspBlock(b, `b${i}`)), { k: "spacer", p: { size: "md" }, key: "pad" }],
	};
}
