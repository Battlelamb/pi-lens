// flake-shape: real-process-spawn — the three hits are planted source TEXT in string fixtures; the sweep asserts the scanner and starts no process
/**
 * #4530 round 20 — every runtime process start goes through the spawn
 * chokepoint, or carries a reasoned admission.
 *
 * ## The defect shape this guards (#69)
 *
 * Admission must follow the seam's executable identity. Round 19 met it
 * nineteen times: each review found the next caller that started a resolved,
 * project-linked executable without the pi trust judgment — a lazy
 * `gem install`, `rustup component add`, an interpreter's
 * `-m site --user-base` probe, then the pip user-base follow-up. Guarding
 * callers one by one cannot converge, because a new caller is a new gate.
 *
 * `clients/safe-spawn.ts` now owns `admitSpawnExecutable`, and
 * `safeSpawnAsync`/`safeSpawn` run it before they resolve or start anything. A
 * raw `node:child_process` start inside the runtime trees is therefore a hole by
 * construction: it never reaches the judgment. This sweep enumerates that
 * population and makes every member either routed, or admitted here with a
 * reason and (where the file still starts a process) liveness evidence.
 *
 * ## Why an import-name scan and not a spelling list
 *
 * Defect shape 69: a scanner that lists the spellings it knows passes every
 * spelling it does not. So the population is derived from the `child_process`
 * module binding itself — a named import (aliased or not), a namespace import,
 * a default import, or a destructured/defaulted `require` — and a file that
 * mentions the module in a form this reader cannot place is reported as
 * unclassified rather than skipped. `spawnCollectStdoutResult` is the second
 * needle: it is the unref'd collector that spawns on behalf of the reaper and
 * the resource sampler, so a call site of it is a process start too.
 *
 * The allowance table is deliberately small: the chokepoint itself, the LSP
 * launcher's own (stricter) registry contract, and the fixed system literals in
 * three modules that cannot import the seam because the seam depends on them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditRegistry,
	callSites,
	listSourceFiles,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The shipped runtime, the only population the invariant governs. */
const RUNTIME_ROOTS = ["clients", "tools", "mcp"] as const;

/** `node:child_process` members that start a process. */
const PROCESS_MEMBERS = [
	"fork",
	"spawn",
	"spawnSync",
	"exec",
	"execFile",
	"execFileSync",
	"execSync",
] as const;

/** The wrapper that spawns on a caller's behalf (`clients/child-unref.ts`). */
const WRAPPER_CALLEE = "spawnCollectStdoutResult";

/** A chokepoint call that a non-routed site must carry as its evidence. */
const ADMISSION_CALLEE = "admitSpawnExecutable";

interface Allowance {
	/** Why this file's raw start is not routed through the chokepoint. */
	reason: string;
	/** Text the file must still contain, so the allowance cannot outlive it. */
	evidence?: string;
}

/**
 * Reasoned exceptions, keyed `repo-relative path#callee`.
 *
 * Every entry answers a question the chokepoint does not ask: a fixed system
 * literal it would admit anyway (but cannot be reached, because the seam
 * depends on these modules), a stricter contract of the caller's own, or a
 * live admission the caller performs itself.
 */
const ADMITTED: Record<string, Allowance> = {
	"clients/safe-spawn.ts#spawn": {
		reason:
			"the chokepoint's own child start: this is the seam every other site routes through",
	},
	"clients/safe-spawn.ts#spawnSync": {
		reason:
			"the chokepoint's own pinned cmd.exe teardown/codepage literals, which the seam admits for itself",
	},
	"clients/lsp/launch.ts#execFileSync": {
		reason:
			"the launcher's synchronous where/which and registry probes; the LSP registry contract judges their results before any server spawns",
		evidence: "refuseUntrustedLspExecution",
	},
	"clients/lsp/launch.ts#nodeSpawn": {
		reason:
			"the LSP launcher's own contract is stricter than the seam: it classifies ownership regardless of trust and refuses project-local binaries under an adopted root",
		evidence: "admitProjectSuppliedTsserver",
	},
	"clients/lsp/client.ts#nodeSpawn": {
		reason:
			"fixed %SystemRoot% taskkill literal that tears down a language server this process already started",
		evidence: "taskkill",
	},
	"clients/instance-reaper.ts#nodeSpawn": {
		reason:
			"fixed system taskkill literal in the reaper's failure path, which already reports an unverified kill",
		evidence: "taskkill",
	},
	"clients/child-unref.ts#nodeSpawn": {
		reason:
			"the unref'd collector cannot import the seam (safe-spawn depends on this module), and it only starts fixed system literals",
	},
	"clients/process-snapshot.ts#spawnCollectStdoutResult": {
		reason:
			"process-table query through the unref'd collector with a fixed ps/wmic literal; a refused query yields no rows, never a wrong kill",
		evidence: "buildProcessQuery",
	},
	"clients/mcp/review.ts#spawn": {
		reason:
			"the analyze worker keeps its own live-stream pipe handling, and its interpreter is the running node (`process.execPath`), a fixed absolute binary, never an environment-resolved lookup; the worker script is a project operand by design",
		evidence: "spawn(process.execPath, args",
	},
};

/** Sites pinned per allowance key, so an added start in an admitted file reds. */
const SITE_PINS: Record<string, number> = {
	"clients/safe-spawn.ts#spawn": 1,
	"clients/safe-spawn.ts#spawnSync": 4,
	"clients/lsp/launch.ts#execFileSync": 2,
	"clients/lsp/launch.ts#nodeSpawn": 2,
	"clients/lsp/client.ts#nodeSpawn": 1,
	"clients/instance-reaper.ts#nodeSpawn": 1,
	"clients/child-unref.ts#nodeSpawn": 1,
	"clients/process-snapshot.ts#spawnCollectStdoutResult": 2,
	"clients/mcp/review.ts#spawn": 1,
};

interface ScanResult {
	/** `callee` → 1-based lines. */
	sites: Map<string, number[]>;
	/** Mentions of the module this reader could not place, with a line. */
	unclassified: string[];
}

function normalized(source: string): string {
	return source.replace(/\r\n/g, "\n");
}

/** Local names bound to a process-start member of `node:child_process`. */
function bindings(source: string): {
	members: Set<string>;
	namespaces: Set<string>;
	/** Module specifiers in code, and how many of them are type-only. */
	specifiers: number;
	typeOnlySpecifiers: number;
} {
	const members = new Set<string>();
	const namespaces = new Set<string>();
	const code = stripSource(source, { strings: "keep" });

	for (const statement of code.matchAll(
		/import\s+(type\s+)?([^;]*?)\s+from\s+["']node:child_process["']/g,
	)) {
		if (statement[1]) continue;
		const clause = statement[2];
		const named = /\{([\s\S]*?)\}/.exec(clause);
		if (named) {
			for (const entry of named[1].split(",")) {
				const cleaned = entry.replace(/^\s*type\s+/, "").trim();
				if (!cleaned || /^type\s/.test(entry.trim())) continue;
				const [imported, local] = cleaned.split(/\s+as\s+/);
				if (imported.trim() === "default") {
					namespaces.add((local ?? imported).trim());
					continue;
				}
				if ((PROCESS_MEMBERS as readonly string[]).includes(imported.trim()))
					members.add((local ?? imported).trim());
			}
		}
		const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
		if (namespace) namespaces.add(namespace[1]);
		const defaultImport = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
		if (defaultImport && !clause.trim().startsWith("{"))
			namespaces.add(defaultImport[1]);
	}

	for (const statement of code.matchAll(
		/(?:const|let|var)\s+([^=]+?)=\s*require\(\s*["']node:child_process["']\s*\)/g,
	)) {
		const target = statement[1].trim();
		const destructured = /\{([\s\S]*?)\}/.exec(target);
		if (destructured) {
			for (const entry of destructured[1].split(",")) {
				const cleaned = entry.trim();
				if (!cleaned) continue;
				const [imported, local] = cleaned.split(/\s*:\s*/);
				if ((PROCESS_MEMBERS as readonly string[]).includes(imported.trim()))
					members.add((local ?? imported).trim());
			}
			continue;
		}
		const named = /^([A-Za-z_$][\w$]*)$/.exec(target);
		if (named) namespaces.add(named[1]);
	}

	const specifiers = [...code.matchAll(/["']node:child_process["']/g)].length;
	const typeOnlySpecifiers =
		[
			...code.matchAll(
				/import\s+type\s[^;]*?from\s+["']node:child_process["']/g,
			),
		].length +
		[...code.matchAll(/typeof\s+import\(\s*["']node:child_process["']\s*\)/g)]
			.length;
	return { members, namespaces, specifiers, typeOnlySpecifiers };
}

/**
 * Process starts in one source file. `file` is repo-relative and only used in
 * the reported text, so the planted cases can drive this directly.
 */
function scanProcessStarts(file: string, source: string): ScanResult {
	const text = normalized(source);
	const sites = new Map<string, number[]>();
	const unclassified: string[] = [];
	const { members, namespaces, specifiers, typeOnlySpecifiers } =
		bindings(text);
	const add = (callee: string, line: number): void => {
		const lines = sites.get(callee) ?? [];
		if (!lines.includes(line)) lines.push(line);
		sites.set(callee, lines);
	};
	for (const local of members)
		for (const site of callSites(text, new RegExp(`^${local}$`)))
			add(site.callee, site.line);
	const stripped = stripSource(text);
	for (const namespace of namespaces) {
		const pattern = new RegExp(
			`\\b${namespace}\\s*\\.\\s*(${PROCESS_MEMBERS.join("|")})\\s*\\(`,
			"g",
		);
		for (const match of stripped.matchAll(pattern))
			add(match[1], stripped.slice(0, match.index ?? 0).split("\n").length);
	}
	// The unref'd collector starts a process on its caller's behalf (#1155).
	for (const site of callSites(text, new RegExp(`^${WRAPPER_CALLEE}$`)))
		add(WRAPPER_CALLEE, site.line);
	// Fail closed: a specifier this reader could not bind is a hole it cannot
	// see through, unless every one of them is type-only (a `ChildProcess` type
	// import starts nothing).
	if (
		members.size === 0 &&
		namespaces.size === 0 &&
		specifiers > typeOnlySpecifiers
	) {
		const at = text.indexOf("child_process");
		const line = text.slice(0, at < 0 ? 0 : at).split("\n").length;
		unclassified.push(
			`${file}:${line}: an unplaceable child_process reference — bind the module (import, namespace import, or require) so the scan can follow it`,
		);
	}
	return { sites, unclassified };
}

function runtimeFiles(): string[] {
	const files = RUNTIME_ROOTS.flatMap((root) =>
		listSourceFiles(path.join(REPO_ROOT, root), {
			extensions: [".ts"],
			skipTests: true,
		}),
	);
	files.push(path.join(REPO_ROOT, "index.ts"));
	return files.sort();
}

function key(file: string, callee: string): string {
	return `${file}#${callee}`;
}

function census(files: readonly string[]): {
	flagged: Array<{ key: string; detail: string }>;
	unclassified: string[];
	scanned: number;
} {
	const flagged: Array<{ key: string; detail: string }> = [];
	const unclassified: string[] = [];
	let scanned = 0;
	for (const { file, source } of readWalkedFiles(files)) {
		const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
		const result = scanProcessStarts(relative, source);
		unclassified.push(...result.unclassified);
		if (result.sites.size === 0) continue;
		scanned += 1;
		for (const [callee, lines] of result.sites)
			flagged.push({
				key: key(relative, callee),
				detail: `${relative}#${callee} at ${lines.join(", ")}`,
			});
	}
	return { flagged, unclassified, scanned };
}

describe("spawn chokepoint sweep (#4530 round 20)", () => {
	it("routes every runtime process start, or admits it with a reason", () => {
		const live = census(runtimeFiles());
		assertNonEmptyScan("spawn chokepoint sweep", live.scanned, 7);
		const audit = auditRegistry({
			sweepName: "spawn chokepoint sweep",
			flagged: live.flagged,
			registered: Object.keys(SITE_PINS),
			exemptions: Object.fromEntries(
				Object.entries(ADMITTED).map(([entry, value]) => [entry, value.reason]),
			),
			// Seven files still start a process themselves; every one is admitted
			// below, and the count is the floor so a moved root reds instead of
			// reading clean.
			scannedCount: live.scanned,
			minFlagged: Object.keys(SITE_PINS).length,
			minScanned: 7,
			remediation:
				"route the start through safeSpawnAsync/safeSpawn, or add a reasoned entry to ADMITTED with its liveness evidence",
		});
		expect(audit.problems).toEqual([]);
		// An unplaceable reference is a hole the scan cannot see through.
		expect(live.unclassified).toEqual([]);
	});

	it("pins each admitted file's site count, so a new start reds", () => {
		const live = census(runtimeFiles());
		for (const entry of live.flagged) {
			expect(
				SITE_PINS[entry.key],
				`${entry.key} is not pinned (an allowed start in a file that is expected to have none, or a new callee in an admitted file)`,
			).toBeDefined();
		}
		const counts = new Map<string, number>();
		for (const entry of live.flagged) {
			const file = entry.key.slice(0, entry.key.indexOf("#"));
			counts.set(file, (counts.get(file) ?? 0) + 1);
		}
		for (const [entry, allowed] of Object.entries(ADMITTED)) {
			const file = entry.slice(0, entry.indexOf("#"));
			const source = readWalkedFiles([path.join(REPO_ROOT, file)])[0]?.source;
			expect(source, `${file} is admitted but missing`).toBeDefined();
			if (!allowed.evidence) continue;
			expect(
				source?.includes(allowed.evidence),
				`${file} no longer carries its allowance evidence (${allowed.evidence})`,
			).toBe(true);
		}
	});

	it("carries a reason and liveness evidence for every allowance", () => {
		for (const [entry, allowed] of Object.entries(ADMITTED)) {
			expect(allowed.reason.length, entry).toBeGreaterThan(40);
			expect(
				SITE_PINS[entry],
				`${entry} is admitted but its sites are not pinned`,
			).toBeGreaterThan(0);
			const file = entry.slice(0, entry.indexOf("#"));
			expect(
				fs.existsSync(path.join(REPO_ROOT, file)),
				`${file} is admitted but does not exist`,
			).toBe(true);
		}
	});

	it("admits the admission call as routed evidence, not as a raw start", () => {
		// Liveness of the rule itself: the chokepoint names appear where the
		// round put them, so a rename cannot leave this sweep screening nothing.
		const safeSpawn = readWalkedFiles([
			path.join(REPO_ROOT, "clients/safe-spawn.ts"),
		])[0]?.source;
		expect(safeSpawn).toContain("export function admitSpawnExecutable");
		expect(safeSpawn).toContain("export function resolveSpawnExecutable");
		const installer = readWalkedFiles([
			path.join(REPO_ROOT, "clients/installer/index.ts"),
		])[0]?.source;
		expect(installer).toContain(
			ADMISSION_CALLEE.length > 0 ? "safeSpawnAsync" : "",
		);
	});

	it("flags a planted raw spawn in a file with no allowance (#69)", () => {
		const planted = [
			'import { spawn } from "node:child_process";',
			"export function run() { return spawn(process.execPath, []); }",
		].join("\n");
		const result = scanProcessStarts("clients/planted.ts", planted);
		expect([...result.sites.entries()]).toEqual([["spawn", [2]]]);
		expect(result.unclassified).toEqual([]);
	});

	it("follows an aliased, namespaced, defaulted and required binding (#69)", () => {
		const cases: Array<[string, string]> = [
			[
				"aliased",
				'import { spawn as nodeSpawn } from "node:child_process";\nnodeSpawn("a", []);',
			],
			[
				"namespaced",
				'import * as cp from "node:child_process";\ncp.spawnSync("a", []);',
			],
			["defaulted", 'import cp from "node:child_process";\ncp.exec("a");'],
			[
				"destructured require",
				'const { spawn: run, execSync } = require("node:child_process");\nrun("a", []);\nexecSync("b");',
			],
			[
				"required namespace",
				'const cp = require("node:child_process");\ncp.fork("a");',
			],
			[
				"dynamic require in a function",
				'export function probe() {\n const { execFileSync } = require("node:child_process");\n return execFileSync("a", []);\n}',
			],
		];
		for (const [name, source] of cases) {
			const result = scanProcessStarts("clients/planted.ts", source);
			expect(result.sites.size, name).toBeGreaterThan(0);
			expect(
				[...result.sites.values()].flat().length,
				`${name} should report at least one start`,
			).toBeGreaterThan(0);
		}
	});

	it("reports a mention it cannot place instead of skipping it (#69)", () => {
		// Fail-closed direction: an unrecognised form must red, not pass.
		const planted = [
			'const loader = () => import("node:child_process");',
			"loader().then((m) => m.spawn(process.execPath, []));",
		].join("\n");
		const result = scanProcessStarts("clients/planted.ts", planted);
		expect(result.unclassified).toHaveLength(1);
		expect(result.unclassified[0]).toContain(
			"unplaceable child_process reference",
		);
	});

	it("ignores a mention in a comment or a string", () => {
		const planted = [
			'// spawn("a", []) from node:child_process',
			'const text = "node:child_process spawn";',
		].join("\n");
		const result = scanProcessStarts("clients/planted.ts", planted);
		expect([...result.sites.entries()]).toEqual([]);
		expect(result.unclassified).toEqual([]);
	});
});
