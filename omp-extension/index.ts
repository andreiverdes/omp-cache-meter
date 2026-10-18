// cache-meter: prompt-cache meter above omp's composer, the /cache panel and settings, and the per-pane
// state file the Tern plugin of the same name reads.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { ExtensionAPI, ExtensionContext, ExtensionUI, Model, Tui } from "./host";
import { type Env, type Line, type Retention, renderMeter, renderPanel, requestedTier, snapshot, stageTone, type Tone, Tracker, toAnsi, toTsp, type WarmingMode } from "./meter";
import { ADVICE_RULE, DEFAULTS, loadSettings, METER_SHOW, METER_SIZE, type MeterSettings, SETTINGS_FILE, saveSettings, TERN_PUBLISH } from "./settings";

const PANE = process.env.TERN_PANE;
const TERN_DIR = process.env.TERN_CONFIG_DIR ?? path.join(os.homedir(), "Library", "Application Support", "Tern");
const STATE_DIR = path.join(TERN_DIR, "plugin-data", "cache-meter", "panes");
const STATE_FILE = PANE ? path.join(STATE_DIR, `${PANE}.json`) : undefined;

const RULE_LABEL: Record<MeterSettings["advice"]["rule"], string> = {
	either: "either threshold is passed",
	tokens: "prefix ≥ token threshold",
	dollars: "rewrite ≥ dollar threshold",
};

export default function cacheMeter(pi: ExtensionAPI): void {
	const tracker = new Tracker();
	let settings = loadSettings();
	let model: Model | undefined;
	let agentRunning = false;
	let ui: ExtensionUI | undefined;
	let tui: Tui | undefined;
	let meterShown = false;
	let panelOpen = false;
	let published = "";
	let timer: unknown;
	let cwd = process.cwd();

	const env = (): Env => {
		const retention = lookup("providers.cacheRetention")?.get(pi.pi.settings);
		const mode = lookup("providers.cacheWarming")?.get(pi.pi.settings);
		return {
			now: Date.now(),
			settings,
			model,
			retention: retention === "short" || retention === "long" || retention === "none" ? (retention satisfies Retention) : "auto",
			warmingMode: mode === "off" || mode === "streaming" ? (mode satisfies WarmingMode) : "idle",
			agentRunning,
		};
	};

	// Seeds history from the session so a resumed session shows its real countdown.
	const rebuild = (ctx: ExtensionContext): void => {
		tracker.reset();
		model = ctx.model;
		cwd = ctx.cwd;
		for (const e of ctx.sessionManager.getBranch()) {
			const at = Date.parse(e.timestamp);
			if (e.type === "message" && e.message.role === "assistant" && e.message.usage) tracker.record("turn", e.message.usage, at, model);
			else if (e.type === "model_usage" && e.purpose.startsWith("cache-warm")) tracker.record("warm", e.usage, at, model);
		}
		published = "";
	};

	// Only the interactive session owns the pane's file: subagent and print-mode sessions have no UI and
	// would otherwise overwrite or delete it.
	const publish = (): void => {
		if (!STATE_FILE || !ui || settings.tern.publish === "off") return;
		const s = snapshot(tracker, env());
		if (!s) return;
		const body = {
			v: 1,
			pane: Number(PANE),
			label: path.basename(cwd),
			model: model ? `${model.provider}/${model.id}` : undefined,
			ttlMs: s.ttlMs,
			expiresAt: s.expiresAt,
			tierLabel: s.tierLabel,
			prefixTokens: s.prefixTokens,
			rewriteCost: s.rewriteCost,
			warnLeadSeconds: settings.meter.warnLeadSeconds,
			coldAdvice: s.coldAdvice,
			last: { read: s.last.read, write: s.last.write, uncached: s.last.uncached, total: s.last.total, hitPct: s.last.hitPct },
			warming: s.warming,
			totals: tracker.totals,
			history: tracker.history.slice(-20).map(r => ({ kind: r.kind, hitPct: (100 * r.read) / (r.read + r.write + r.uncached) })),
		};
		const json = JSON.stringify(body);
		if (json === published) return;
		published = json;
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify({ ...body, updatedAt: Date.now() }));
		fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE); // atomic: Tern never reads a half-written file
	};

	// The meter widget exists only while it has something to show, so a hidden meter leaves no blank row.
	const syncMeter = (): void => {
		if (!ui) return;
		const s = snapshot(tracker, env());
		const show = settings.meter.show;
		const want = s !== undefined && show !== "off" && !(show === "near-expiry" && s.stage === "warm");
		if (want && !meterShown) {
			// Lines are rebuilt on every paint so the countdown moves; describe() feeds native hosts (Tern).
			const lines = (): { lines: Line[]; tone: Tone } => {
				const now = snapshot(tracker, env());
				return now ? { lines: renderMeter(now, settings), tone: stageTone(now.stage) } : { lines: [], tone: "muted" };
			};
			ui.setWidget(
				"cache-meter",
				(t, theme) => {
					tui = t;
					return {
						render: width => {
							const m = lines();
							return toAnsi(m.lines, theme, width, m.tone);
						},
						describe: () => {
							const m = lines();
							return toTsp(m.lines, "omp.widget.cache-meter", m.tone);
						},
						invalidate() {},
					};
				},
				{ placement: "aboveEditor" },
			);
		} else if (!want && meterShown) {
			ui.setWidget("cache-meter", undefined);
		}
		meterShown = want;
	};

	const showPanel = (): void => {
		const lines = () => renderPanel(tracker, snapshot(tracker, env()), model, env().warmingMode);
		ui?.setWidget(
			"cache-panel",
			panelOpen
				? (t, theme) => {
						tui = t;
						return {
							render: width => toAnsi(lines(), theme, width, "accent"),
							describe: () => toTsp(lines(), "omp.widget.cache-panel", "accent"),
							invalidate() {},
						};
					}
				: undefined,
			{ placement: "aboveEditor" },
		);
	};

	const refresh = (): void => {
		syncMeter();
		tui?.requestRender();
		publish();
	};

	pi.on("session_start", (_e, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		rebuild(ctx);
		if (timer === undefined) timer = ctx.setInterval(refresh, 1000);
		refresh();
	});
	for (const event of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(event, (_e, ctx) => {
			rebuild(ctx);
			refresh();
		});
	}
	pi.on("agent_start", () => {
		agentRunning = true;
	});
	pi.on("agent_end", () => {
		agentRunning = false;
		refresh();
	});

	pi.on("message_end", (e, ctx) => {
		if (e.message.role !== "assistant" || !e.message.usage) return;
		model = ctx.model ?? model;
		if (tracker.record("turn", e.message.usage, Date.now(), model)) refresh();
	});

	pi.on("before_provider_request", e => {
		tracker.requestedTier = requestedTier(e.payload) ?? tracker.requestedTier;
		return undefined; // observe only; the payload goes out unchanged
	});

	pi.on("cache_warming_decision", e => {
		tracker.decision = { at: Date.now(), action: e.action, warmCost: e.warmCost, missCost: e.missCost };
		refresh();
		return undefined; // observe only; omp's own decision stands
	});
	pi.on("cache_warming_end", e => {
		if (e.usage) tracker.record("warm", e.usage, Date.now(), model);
		if (e.warmingStopReason) tracker.stopped = { at: Date.now(), reason: e.warmingStopReason };
		refresh();
	});

	pi.on("session_shutdown", () => {
		if (STATE_FILE && ui) fs.rmSync(STATE_FILE, { force: true });
	});

	const editSettings = async (ctx: ExtensionContext): Promise<void> => {
		for (;;) {
			const s = settings;
			const omp = (id: string) => `${id}: ${String(lookup(id)?.get(pi.pi.settings) ?? "?")} (change in /settings)`;
			const entries: [string, () => Promise<MeterSettings | undefined>][] = [
				[`Show meter: ${s.meter.show}`, async () => {
					const v = await ctx.ui.select("Show meter", [...METER_SHOW]);
					return v ? { ...s, meter: { ...s.meter, show: v as MeterSettings["meter"]["show"] } } : undefined;
				}],
				[`Meter size: ${s.meter.size === "full" ? "full (2–3 lines)" : "compact (1 line)"}`, async () => {
					const v = await ctx.ui.select("Meter size", [...METER_SIZE]);
					return v ? { ...s, meter: { ...s.meter, size: v as MeterSettings["meter"]["size"] } } : undefined;
				}],
				[`Warn before expiry: ${s.meter.warnLeadSeconds} s`, async () => {
					const n = Number(await ctx.ui.input("Warn this many seconds before expiry", String(s.meter.warnLeadSeconds)));
					return Number.isFinite(n) && n >= 0 ? { ...s, meter: { ...s.meter, warnLeadSeconds: n } } : undefined;
				}],
				[`Countdown bar: ${s.meter.countdownBar ? "on" : "off"}`, async () => ({ ...s, meter: { ...s.meter, countdownBar: !s.meter.countdownBar } })],
				[`Suggest /compact when: ${RULE_LABEL[s.advice.rule]}`, async () => {
					const v = await ctx.ui.select("Suggest /compact on a cold cache when", ADVICE_RULE.map(r => RULE_LABEL[r]));
					const rule = ADVICE_RULE.find(r => RULE_LABEL[r] === v);
					return rule ? { ...s, advice: { ...s.advice, rule } } : undefined;
				}],
				[`Token threshold: ${s.advice.tokenThreshold.toLocaleString("en-US")} (0 = off)`, async () => {
					const n = Number((await ctx.ui.input("Token threshold (0 = off)", String(s.advice.tokenThreshold)))?.replace(/[,_\s]/g, ""));
					return Number.isFinite(n) && n >= 0 ? { ...s, advice: { ...s.advice, tokenThreshold: Math.round(n) } } : undefined;
				}],
				[`Dollar threshold: $${s.advice.dollarThreshold.toFixed(2)} (0 = off)`, async () => {
					const n = Number((await ctx.ui.input("Dollar threshold (0 = off)", String(s.advice.dollarThreshold)))?.replace("$", ""));
					return Number.isFinite(n) && n >= 0 ? { ...s, advice: { ...s.advice, dollarThreshold: n } } : undefined;
				}],
				[`Publish state for Tern: ${s.tern.publish}${PANE ? ` (TERN_PANE=${PANE})` : " (not in a Tern pane)"}`, async () => {
					const v = await ctx.ui.select("Publish state for Tern", [...TERN_PUBLISH]);
					return v ? { ...s, tern: { publish: v as MeterSettings["tern"]["publish"] } } : undefined;
				}],
				[omp("providers.cacheRetention"), async () => undefined],
				[omp("providers.cacheWarming"), async () => undefined],
				[omp("display.cacheMissMarker"), async () => undefined],
				["Reset to defaults", async () => DEFAULTS],
				["Done", async () => undefined],
			];
			const choice = await ctx.ui.select(`Prompt cache · settings (${SETTINGS_FILE.replace(os.homedir(), "~")})`, entries.map(([label]) => label));
			if (!choice || choice === "Done") return;
			if (choice.startsWith("providers.") || choice.startsWith("display.")) {
				ctx.ui.notify("That is an omp setting: change it in /settings.", "info");
				continue;
			}
			const next = await entries.find(([label]) => label === choice)?.[1]();
			if (!next) continue;
			settings = next;
			saveSettings(settings);
			if (settings.tern.publish === "off" && STATE_FILE) fs.rmSync(STATE_FILE, { force: true });
			published = "";
			refresh();
		}
	};

	pi.registerCommand("cache", {
		description: "Prompt cache: toggle the history panel; `/cache settings` changes the meter.",
		getArgumentCompletions: prefix =>
			"settings".startsWith(prefix.trim()) ? [{ label: "settings", value: "settings", description: "Meter, advice and Tern settings" }] : null,
		handler: async (args, ctx) => {
			ui = ctx.hasUI ? ctx.ui : ui;
			if (args.trim() === "settings") {
				await editSettings(ctx);
				return;
			}
			panelOpen = !panelOpen;
			showPanel();
		},
	});
}
