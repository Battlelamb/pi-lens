import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { COMPLEXITY_ANALYZED_FILES_FLOOR } from "../../scripts/complexity-report.mjs";
import {
	countEvaluated,
	EVALUATED_DIR_ENV,
	EVALUATED_PRODUCERS,
} from "../../scripts/lib/assert-evaluated.mjs";
import { stripSource } from "../support/sweep-kit.js";

// Recurrence #4514 (retro P2): the four best-effort LSP producers exit 0 under
// continue-on-error, so the nightly read green while 41 captured servers fell
// to 16. A floor is a MEASURED constant: its measuring command and raw output
// are tracked (tests/fixtures/nightly-floors/measurements.json) and this file
// pins each floor between the degraded and the healthy measurement, so a floor
// raised past what a healthy runner reaches (a nightly red forever) and a
// floor lowered under the degraded night (a gate that would not have fired)
// both red here. It also pins the wiring: a producer that stops reporting, a
// floor step made continue-on-error, and a refresh PR that no longer asks
// whether the night evaluated anything.
const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const measurements = JSON.parse(
	read("tests/fixtures/nightly-floors/measurements.json"),
) as {
	producers: Record<
		string,
		Record<"healthy" | "degraded", { evaluated: number; lines: string[] }>
	>;
	lspHandshake: Record<
		"healthy" | "degraded",
		{ passed: number; line: string }
	>;
};

const lastInt = (line: string) => Number(/(\d+)\s*$/.exec(line)?.[1]);
const many = <T>(n: number, row: T) => Array.from({ length: n }, () => row);
/**
 * The value each script hands writeEvaluatedRecord, rebuilt from the raw log
 * lines of a real night, plus rows the count must NOT include (a refused or
 * unclassified row). The count itself is EVALUATED_COUNTS, the one function the
 * script also calls, so a mutation of a count expression reds the derivation
 * below (the idle count read as `counts.total`, probe-clean-signal dropping its
 * `n/a (pull)` arm, characterize-lsp counting refused rows).
 */
const INPUT: Record<string, (lines: string[]) => unknown> = {
	"characterize-lsp": (lines) => [
		...many(lastInt(lines[0]), { mode: "pull" }),
		...many(lastInt(lines[1]), { mode: "push-only" }),
		...many(3, { mode: "unknown" }),
		...many(2, { mode: "refused: project trust is unknown" }),
	],
	"probe-clean-signal": (lines) => [
		...many(lastInt(lines[0]), { behavior: "publishes-versioned" }),
		...many(lastInt(lines[1]), { behavior: "publishes-unversioned" }),
		...many(lastInt(lines[2]), { behavior: "silent" }),
		...many(lastInt(lines[3]), { behavior: "n/a (pull)" }),
		...many(4, { behavior: "unknown" }),
	],
	"server-capabilities": ([line]) =>
		many(Number(/\((\d+) servers captured/.exec(line)?.[1]), {}),
	"measure-lsp-idle-eviction": ([line]) => {
		const m =
			/(\d+) registry servers: (\d+) eligible, (\d+) vetoed, (\d+) inconclusive, (\d+) unavailable/.exec(
				line,
			);
		return {
			total: Number(m?.[1]),
			eligible: Number(m?.[2]),
			vetoed: Number(m?.[3]),
			inconclusive: Number(m?.[4]),
			unavailable: Number(m?.[5]),
		};
	},
};
/** The identifier each script passes as `input`, pinned so it cannot pass a slice. */
const SCRIPT_INPUT: Record<string, string> = {
	"characterize-lsp": "rows",
	"probe-clean-signal": "rows",
	"server-capabilities": "rows",
	"measure-lsp-idle-eviction": "counts",
};

describe("nightly evaluated floors are measured, not guessed (#4514)", () => {
	it("registers exactly the producers that have a measurement", () => {
		expect(Object.keys(EVALUATED_PRODUCERS).sort()).toEqual(
			Object.keys(measurements.producers).sort(),
		);
		expect(Object.keys(INPUT).sort()).toEqual(
			Object.keys(EVALUATED_PRODUCERS).sort(),
		);
	});

	describe.each(Object.keys(EVALUATED_PRODUCERS))("%s", (producer) => {
		const spec = EVALUATED_PRODUCERS[producer];
		const { healthy, degraded } = measurements.producers[producer];

		it("derives each measurement's count from its raw log lines", () => {
			expect(countEvaluated(producer, INPUT[producer](healthy.lines))).toBe(
				healthy.evaluated,
			);
			expect(countEvaluated(producer, INPUT[producer](degraded.lines))).toBe(
				degraded.evaluated,
			);
		});

		it("sits above the degraded night and at or below the healthy one", () => {
			expect(spec.floor).toBeGreaterThan(degraded.evaluated);
			expect(spec.floor).toBeLessThanOrEqual(healthy.evaluated);
		});

		// A doc floor of 1 is the matrix's "not emptied" guard, a different unit.
		const docFloor = spec.doc && spec.doc.floor > 1 ? spec.doc.floor : 0;
		it.skipIf(docFloor === 0)(
			"holds a doc floor in the same band where the doc count is the same unit",
			() => {
				expect(docFloor).toBeGreaterThan(degraded.evaluated);
				expect(docFloor).toBeLessThanOrEqual(healthy.evaluated);
			},
		);

		it("is reported by its own script", () => {
			const code = stripSource(read(`scripts/${producer}.mjs`), {
				strings: "keep",
			});
			// The script hands over its rows, never a count of its own: the one
			// count function (EVALUATED_COUNTS) is what the test above derives.
			expect(code).toMatch(
				new RegExp(
					`writeEvaluatedRecord\\(\\{\\s*producer:\\s*"${producer}",\\s*input:\\s*${SCRIPT_INPUT[producer]},?\\s*\\}\\)`,
				),
			);
		});
	});
});

type Step = {
	name?: string;
	id?: string;
	if?: string;
	run?: string;
	uses?: string;
	"continue-on-error"?: unknown;
	"timeout-minutes"?: unknown;
};
type Job = {
	env?: Record<string, string>;
	steps?: Step[];
	outputs?: Record<string, string>;
};
const workflow = yaml.load(read(".github/workflows/tool-smoke.yml")) as {
	jobs: Record<string, Job>;
};
const smoke = workflow.jobs["tool-smoke"];
const prs = workflow.jobs["tool-smoke-prs"];
const step = (job: Job, needle: string) => {
	const found = (job.steps ?? []).find((s) => s.name?.includes(needle));
	if (!found) throw new Error(`no step named like "${needle}"`);
	return found;
};

describe("the floor step and the refresh guard are wired and gating (#4514)", () => {
	it("runs the floor as a step that cannot be continue-on-error, after every producer and layer", () => {
		const steps = smoke.steps ?? [];
		const floor = step(smoke, "LSP evaluated floor");
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.id).toBe("evaluated_floor");
		expect(floor.run).toContain("scripts/assert-evaluated.mjs --records");
		// A doc-only loss (a matrix cell gone `unknown`) must red the step the
		// notifier reads, not only the refresh job that no tracker watches.
		expect(floor.run).toMatch(/--records "\$\w+" --docs\b/);
		expect(floor.run).toMatch(/^\s*set -o pipefail\s*$/m);
		const at = (name: string) => steps.indexOf(step(smoke, name));
		for (const earlier of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
			"Resolution layer",
		])
			expect(at("LSP evaluated floor"), earlier).toBeGreaterThan(at(earlier));
	});

	it("names the records directory once, in the job env the producers and the floor step share", () => {
		const dir = smoke.env?.[EVALUATED_DIR_ENV];
		expect(dir).toBeTruthy();
		expect(step(smoke, "LSP evaluated floor").run).toContain(
			`"$${EVALUATED_DIR_ENV}"`,
		);
	});

	it("keeps the four producers best-effort (the floor, not them, carries the verdict)", () => {
		for (const name of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
		])
			expect(step(smoke, name)["continue-on-error"], name).toBe(true);
	});

	it("gives the LSP handshake a --min-pass at or below what a healthy and a degraded night both passed", () => {
		const floor = Number(
			/--min-pass=(\d+)/.exec(
				step(smoke, "LSP handshake layer").run ?? "",
			)?.[1],
		);
		expect(floor).toBeGreaterThan(0);
		for (const night of ["healthy", "degraded"] as const)
			expect(floor).toBeLessThanOrEqual(
				measurements.lspHandshake[night].passed,
			);
		for (const night of ["healthy", "degraded"] as const)
			expect(measurements.lspHandshake[night].line).toContain(
				`${measurements.lspHandshake[night].passed} passed`,
			);
	});

	it("passes --min-pass from main() into the handshake layer (call-site pin)", () => {
		const code = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(code).toMatch(
			/runLspHandshake\(\{\s*langs,\s*install,\s*verbose,\s*minPass\s*\}\)/,
		);
	});

	it("opens no refresh PR before the regenerated docs are checked against HEAD", () => {
		const steps = prs.steps ?? [];
		const guard = step(prs, "Refuse a degraded refresh");
		expect(guard["continue-on-error"]).toBeUndefined();
		expect(guard.run).toContain("scripts/assert-evaluated.mjs --docs");
		const guardAt = steps.indexOf(guard);
		expect(guardAt).toBeGreaterThan(steps.indexOf(step(prs, "Overlay")));
		for (const open of [
			"Open/update LSP-docs refresh PR",
			"Open/update idle-eviction promotion PR",
		])
			expect(steps.indexOf(step(prs, open)), open).toBeGreaterThan(guardAt);
	});
});

// Recurrence #4518 (retro P2, the rest of the audit): five more producers sat
// under continue-on-error with no proof of work (the APFS anchors, the Swift
// crash-watch, the PR-time LSP handshake, the complexity report, plus the
// mise-repro and lint jobs that carry a stated reason instead). The floors are
// MEASURED (tests/fixtures/nightly-floors/measurements.json, nonLspFloors) and
// pinned here in both directions: at or below what a healthy run reached (a
// floor above it is a job red forever) and within half of it (a floor of 1 is
// the "did anything run" guard the job already had, not a measured one).
const nonLsp = (
	measurements as unknown as {
		nonLspFloors: {
			"apfs-anchors": { healthy: { evaluated: number; line: string } };
			"install-smoke-lsp-handshake": {
				healthy: Array<{ passed: number; line: string }>;
			};
			"swift-crash-watch": { healthy: { evaluated: number } };
			"complexity-report": { healthy: { evaluated: number } };
			"windows-vitest": { healthy: { evaluated: number; line: string } };
		};
	}
).nonLspFloors;
const withinMeasured = (floor: number, measured: number, fraction = 0.5) => {
	expect(floor).toBeGreaterThan(0);
	expect(floor).toBeLessThanOrEqual(measured);
	expect(floor).toBeGreaterThanOrEqual(measured * fraction);
};
const loadWorkflow = (file: string) =>
	yaml.load(read(`.github/workflows/${file}`)) as {
		jobs: Record<string, Job>;
	};
const floorOf = (run: string | undefined, re: RegExp) =>
	Number(re.exec(run ?? "")?.[1]);

describe("the floors outside the LSP nightly are measured and wired (#4518)", () => {
	it("floors the APFS anchors on tests executed, in a step that cannot be continue-on-error", () => {
		const job = loadWorkflow("ci.yml").jobs["install-test"];
		const anchors = step(job, "POSIX case-insensitive anchors");
		const floor = step(job, "APFS anchors evaluated floor");
		// The results stay advisory; only "nothing ran" is gating.
		expect(anchors["continue-on-error"]).toBe(true);
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.if).toContain("macos-latest");
		expect(floor.if).toContain("!cancelled()");
		const steps = job.steps ?? [];
		expect(steps.indexOf(floor)).toBeGreaterThan(steps.indexOf(anchors));
		// The reporter file the vitest step writes is the file the floor reads.
		expect(anchors.run).toContain(
			'--reporter=json --outputFile.json="$RUNNER_TEMP/apfs-anchors.json"',
		);
		expect(floor.run).toContain('"$RUNNER_TEMP/apfs-anchors.json"');
		expect(floor.run).toContain("j.numPassedTests+j.numFailedTests");
		expect(floor.run).toMatch(/--count "apfs-anchors=\$\{count\}"/);
		// 100 of the measured 223 is a decision (review r1 F5): the leg is
		// required, the step exists to catch a run that executed nothing, and a
		// 10% margin would red it on a legitimate removal of 24 tests.
		withinMeasured(
			floorOf(floor.run, /--floor (\d+)/),
			nonLsp["apfs-anchors"].healthy.evaluated,
			0.4,
		);
		expect(nonLsp["apfs-anchors"].healthy.line).toContain(
			`${nonLsp["apfs-anchors"].healthy.evaluated} passed`,
		);
	});

	it("turns exactly 'swift was not evaluated' into a red job, and says so when swift can be lifted", () => {
		const job = loadWorkflow("grammar-health.yml").jobs["swift-crash-watch"];
		const watch = step(job, "Force-load swift");
		const floor = step(job, "Swift crash-watch evaluated floor");
		expect(watch["continue-on-error"]).toBeUndefined();
		expect(floor["continue-on-error"]).toBeUndefined();
		const steps = job.steps ?? [];
		expect(steps.indexOf(floor)).toBeGreaterThan(steps.indexOf(watch));
		// check-grammar-load.mjs: 2 = runtime unavailable, 3 = grammar did not
		// load; both evaluated nothing. Exit 0 is the lift signal; any other
		// status is the known #423 crash and IS an evaluation.
		expect(watch.run).toMatch(/2\|3\)\s*\n\s*evaluated=0/);
		expect(watch.run).toMatch(/0\)\s*\n\s*evaluated=1/);
		expect(watch.run).toMatch(/\*\)\s*\n\s*evaluated=1/);
		expect(watch.run).toContain("::notice title=Swift crash-watch::");
		expect(watch.run).toContain(
			'echo "evaluated=${evaluated}" >> "$GITHUB_OUTPUT"',
		);
		expect((floor as { env?: Record<string, string> }).env?.EVALUATED).toBe(
			"${{ steps.swift.outputs.evaluated }}",
		);
		expect(floor.run).toContain(
			'--count "swift-crash-watch=${EVALUATED}" --floor',
		);
		withinMeasured(
			floorOf(floor.run, /--floor (\d+)/),
			nonLsp["swift-crash-watch"].healthy.evaluated,
		);
	});

	it("gives the PR-time LSP handshake a --min-pass at or below both measured PR runs", () => {
		const job = loadWorkflow("install-smoke.yml").jobs["lsp-handshake"];
		const floor = floorOf(
			step(job, "LSP handshake layer").run,
			/--min-pass=(\d+)/,
		);
		const passes = nonLsp["install-smoke-lsp-handshake"].healthy.map(
			(h) => h.passed,
		);
		withinMeasured(floor, Math.min(...passes));
		for (const h of nonLsp["install-smoke-lsp-handshake"].healthy)
			expect(h.line).toContain(`${h.passed} passed`);
	});

	it("hands the analysed-files floor to assertEvaluated and pins it under the measured count", () => {
		withinMeasured(
			COMPLEXITY_ANALYZED_FILES_FLOOR,
			nonLsp["complexity-report"].healthy.evaluated,
		);
	});

	it("floors the Windows subset on tests executed, in the step that already reds a failed outcome", () => {
		const job = loadWorkflow("ci.yml").jobs["unit-tests-windows"];
		const failStep = step(job, "under-executed");
		expect(failStep["continue-on-error"]).toBeUndefined();
		expect(failStep.run).toContain('--count "windows-vitest=${executed}"');
		withinMeasured(
			floorOf(failStep.run, /--floor (\d+)/),
			nonLsp["windows-vitest"].healthy.evaluated,
		);
		expect(nonLsp["windows-vitest"].healthy.line).toContain(
			`${nonLsp["windows-vitest"].healthy.evaluated} passed`,
		);
	});

	it("states why each job without a floor needs none, directly above the job", () => {
		const lint = read(".github/workflows/lint.yml");
		for (const job of ["jscpd", "strictness", "yamllint", "typos", "taplo"]) {
			const at = lint.indexOf(`\n  ${job}:\n`);
			expect(at, job).toBeGreaterThan(0);
			const above = lint.slice(Math.max(0, at - 700), at);
			expect(above, job).toMatch(/# No floor \(#4518\): /);
		}
		const install = read(".github/workflows/install-smoke.yml");
		const miseAt = install.indexOf("\n  mise-repro:\n");
		expect(miseAt).toBeGreaterThan(0);
		expect(install.slice(miseAt, miseAt + 1500)).toMatch(
			/# No floor \(#4518\): /,
		);
	});

	it("keeps the pass-floor, census-plan and file-count comparisons in the one helper (net-count rule)", () => {
		const call = /\bassertEvaluated\(/;
		for (const file of [
			"scripts/smoke-tools.mjs",
			"scripts/ci-shuffle-census.mjs",
			"scripts/complexity-report.mjs",
		]) {
			const code = stripSource(read(file), { strings: "blank" });
			expect(code, file).toMatch(call);
		}
		// The ad hoc comparison the helper replaced must not come back beside it.
		const smoke = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(smoke).not.toMatch(/passed\s*>=\s*minPass/);
		const census = stripSource(read("scripts/ci-shuffle-census.mjs"), {
			strings: "blank",
		});
		expect(census).not.toMatch(/if\s*\(\s*missing\.length\s*>\s*0\s*\)/);
	});
});
