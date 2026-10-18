import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SETTINGS_FILE = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "cache-meter.json");

export const METER_SHOW = ["always", "near-expiry", "off"] as const;
export const METER_SIZE = ["full", "compact"] as const;
export const ADVICE_RULE = ["either", "tokens", "dollars"] as const;
export const TERN_PUBLISH = ["auto", "off"] as const;

export interface MeterSettings {
	meter: {
		show: (typeof METER_SHOW)[number];
		size: (typeof METER_SIZE)[number];
		warnLeadSeconds: number;
		countdownBar: boolean;
	};
	advice: { rule: (typeof ADVICE_RULE)[number]; tokenThreshold: number; dollarThreshold: number };
	tern: { publish: (typeof TERN_PUBLISH)[number] };
}

export const DEFAULTS: MeterSettings = {
	meter: { show: "always", size: "full", warnLeadSeconds: 60, countdownBar: true },
	advice: { rule: "either", tokenThreshold: 50_000, dollarThreshold: 0.5 },
	tern: { publish: "auto" },
};

// omp's `pi.zod` is a reduced zod whose `.catch` does not cover missing keys, so the file is checked field by
// field: each missing or invalid field takes its default on its own.
const read = (obj: unknown, key: string): unknown => (typeof obj === "object" && obj !== null ? Reflect.get(obj, key) : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.find(a => a === v) ?? fallback;
const count = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);

export function parseSettings(raw: unknown): MeterSettings {
	const d = DEFAULTS;
	const meter = read(raw, "meter");
	const advice = read(raw, "advice");
	const bar = read(meter, "countdownBar");
	return {
		meter: {
			show: oneOf(read(meter, "show"), METER_SHOW, d.meter.show),
			size: oneOf(read(meter, "size"), METER_SIZE, d.meter.size),
			warnLeadSeconds: count(read(meter, "warnLeadSeconds"), d.meter.warnLeadSeconds),
			countdownBar: typeof bar === "boolean" ? bar : d.meter.countdownBar,
		},
		advice: {
			rule: oneOf(read(advice, "rule"), ADVICE_RULE, d.advice.rule),
			tokenThreshold: count(read(advice, "tokenThreshold"), d.advice.tokenThreshold),
			dollarThreshold: count(read(advice, "dollarThreshold"), d.advice.dollarThreshold),
		},
		tern: { publish: oneOf(read(read(raw, "tern"), "publish"), TERN_PUBLISH, d.tern.publish) },
	};
}

/** Reads the settings file; a missing or unparsable file yields the defaults. */
export function loadSettings(): MeterSettings {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
	} catch {
		raw = undefined;
	}
	return parseSettings(raw);
}

export function saveSettings(s: MeterSettings): void {
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(`${SETTINGS_FILE}.tmp`, `${JSON.stringify(s, null, 2)}\n`);
	fs.renameSync(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
}
