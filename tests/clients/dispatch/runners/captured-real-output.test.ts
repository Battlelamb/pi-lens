/**
 * Replay REAL binary output through each runner's parser (#1937).
 *
 * The vale parser in #1933 read `Data.Files`; vale emits a flat map. The unit
 * tests agreed with the parser because the same author wrote both, so the runner
 * reported "succeeded, 0 findings" while the CLI exited 1 with real errors. A
 * parser that has never met its binary's bytes is the defect; a hand-authored
 * test cannot catch it.
 *
 * Every fixture under `tests/fixtures/runner-output/` holds bytes a real tool
 * actually produced (see `scripts/capture-runner-output.mjs`, which writes the
 * provenance header). This suite copies the fixture's recorded workspace to a
 * temp dir, feeds the captured stdout/stderr/exit code to the runner through the
 * `safeSpawnAsync` seam, and asserts the runner turns them into findings.
 *
 * A parser regression against a real binary now reds here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	listCapturedOutputs,
	materialize,
	WORKSPACE_TOKEN,
} from "../../../helpers/captured-runner-output.js";
import { setupTestEnvironment } from "../../test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

const { safeSpawnAsync, getLinterPolicyForCwd } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	getLinterPolicyForCwd: vi.fn(),
}));

// Partial mocks throughout: these modules keep growing exports, and a full
// replacement turns every new one into an unrelated crash in this suite.
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

// Config gates are not what this suite tests — it tests parsers. Force every
// gate open so each runner reaches its parse step.
vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLinterPolicyForCwd,
	markdownlintConfigArgs: () => [],
	hasEslintConfig: () => true,
	hasMypyConfig: () => true,
	hasPhpstanConfig: () => true,
	// Left real: sqlfluff's config presence CHANGES its argv (an unconfigured
	// project gets `--dialect ansi`), so forcing it open would make the argv
	// tie assert against an invocation the fixture never captured.
	hasSqlfluffConfig: (cwd: string) =>
		fs.existsSync(path.join(cwd, ".sqlfluff")),
	hasStylelintConfig: () => true,
	hasYamllintConfig: () => true,
	getAutofixCapability: () => ({
		toolSupportsFix: false,
		safePipelineAutofix: false,
		fixKind: "none",
	}),
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => true,
			isAvailableAsync: async () => true,
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => toolId,
		resolveAvailableOrInstall: async (_cwd: string, toolId: string) => toolId,
		// taplo and oxlint skip the CLI when the language's LSP primary already
		// covers the file. This suite exercises the CLI parser, so keep that
		// short-circuit closed.
		lspPrimaryCoversFile: () => false,
	}),
);

/**
 * How to drive one runner: its module basename and the dispatch `kind` its
 * `appliesTo` declares. Keyed by registered runner id.
 *
 * Every captured fixture must appear here — the completeness assertion below
 * fails otherwise, so a new capture cannot land unreplayed.
 */
const RUNNER_DESCRIPTORS: Record<string, { module: string; kind: string }> = {
	actionlint: { module: "actionlint", kind: "yaml" },
	"cpp-check": { module: "cpp-check", kind: "cxx" },
	"cue-vet": { module: "cue-vet", kind: "cue" },
	"dart-analyze": { module: "dart-analyze", kind: "dart" },
	"dotnet-build": { module: "dotnet-build", kind: "csharp" },
	"elixir-check": { module: "elixir-check", kind: "elixir" },
	eslint: { module: "eslint", kind: "jsts" },
	"biome-check-json": { module: "biome-check", kind: "jsts" },
	"fish-indent": { module: "fish-indent", kind: "fish" },
	"gleam-check": { module: "gleam-check", kind: "gleam" },
	"go-vet": { module: "go-vet", kind: "go" },
	"golangci-lint": { module: "golangci-lint", kind: "go" },
	hadolint: { module: "hadolint", kind: "docker" },
	"helm-lint": { module: "helm-lint", kind: "yaml" },
	htmlhint: { module: "htmlhint", kind: "html" },
	javac: { module: "javac", kind: "java" },
	ktlint: { module: "ktlint", kind: "kotlin" },
	markdownlint: { module: "markdownlint", kind: "markdown" },
	mypy: { module: "mypy", kind: "python" },
	oxlint: { module: "oxlint", kind: "jsts" },
	"php-lint": { module: "php-lint", kind: "php" },
	phpstan: { module: "phpstan", kind: "php" },
	pyright: { module: "pyright", kind: "python" },
	rubocop: { module: "rubocop", kind: "ruby" },
	"ruff-lint": { module: "ruff", kind: "python" },
	"rust-clippy": { module: "rust-clippy", kind: "rust" },
	shellcheck: { module: "shellcheck", kind: "shell" },
	shfmt: { module: "shfmt", kind: "shell" },
	spellcheck: { module: "spellcheck", kind: "markdown" },
	sqlfluff: { module: "sqlfluff", kind: "sql" },
	stylelint: { module: "stylelint", kind: "css" },
	swiftlint: { module: "swiftlint", kind: "swift" },
	taplo: { module: "taplo", kind: "toml" },
	terragrunt: { module: "terragrunt", kind: "terragrunt" },
	tflint: { module: "tflint", kind: "terraform" },
	vale: { module: "vale", kind: "markdown" },
	yamllint: { module: "yamllint", kind: "yaml" },
	"zig-check": { module: "zig-check", kind: "zig" },
};

/**
 * What a fixture's replay must produce beyond "at least one finding". Keyed
 * `<runner>/<case>`. Presence alone passed a fish-indent replay that reported a
 * merely unformatted file as a blocking parse error (#4454), and a helm-lint
 * replay whose path was built from prose (#4453): neither asserts the
 * semantic, the rule, the file or the line.
 */
interface ExpectedFinding {
	rule: string;
	semantic: string;
	/** Workspace-relative, forward slashes. */
	file: string;
	/** Absent when the tool reports the finding with no line. */
	line?: number;
}
interface ReplayExpectation {
	status: string;
	semantic: string;
	findings: ExpectedFinding[];
}
const REPLAY_EXPECTATIONS: Record<string, ReplayExpectation> = {
	// fish_indent 4.9.3 --check prints the file name on stderr and exits 1 for a
	// file that only needs formatting: a fixable warning, never a blocker.
	"fish-indent/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "fish-indent-unformatted",
				semantic: "warning",
				file: "unformatted.fish",
				line: 1,
			},
		],
	},
	"fish-indent/smoke-bad": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "fish-indent-unformatted",
				semantic: "warning",
				file: "bad.fish",
				line: 1,
			},
		],
	},
	// fish_indent --check never reports a syntax error, so the runner also asks
	// `fish --no-execute`; its real bytes for the three defects (and the fish-lsp
	// smoke fixture) must reach the agent as a blocking finding on the real file
	// and line (#4454). Each file is already formatted: only fish -n sees it.
	"fish-indent/syntax-missing-end": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "missing-end.fish",
				line: 1,
			},
		],
	},
	"fish-indent/syntax-unterminated-quote": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "unterminated-quote.fish",
				line: 1,
			},
		],
	},
	"fish-indent/syntax-stray-end": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "stray-end.fish",
				line: 2,
			},
		],
	},
	// fish 3.3.1 (Ubuntu 22.04) prints the header of an absolute argv path as `~`
	// plus that path; the attribution dropped every syntax error there (#4454).
	"fish-indent/syntax-stray-end-fish-3.3.1": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "stray-end.fish",
				line: 2,
			},
		],
	},
	"fish-indent/syntax-smoke-bad": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "bad.fish",
				line: 1,
			},
		],
	},
	"golangci-lint/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{ rule: "errcheck", semantic: "warning", file: "bad.go", line: 6 },
			{ rule: "unused", semantic: "warning", file: "bad.go", line: 9 },
		],
	},
	"golangci-lint/config-text-stdout": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{ rule: "errcheck", semantic: "warning", file: "bad.go", line: 6 },
			{ rule: "unused", semantic: "warning", file: "bad.go", line: 9 },
		],
	},
	// ktlint 1.8.0 prints its own `WARN` log line on stdout ahead of the JSON
	// report; reading that stream whole replayed as a parse error, not the
	// finding (#4522). The finding is op-spacing on Bad.kt line 3.
	"ktlint/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "standard:op-spacing",
				semantic: "warning",
				file: "Bad.kt",
				line: 3,
			},
		],
	},
	// helm 4.3.0 prefixes the chart name inside the message; the real template
	// is `templates/bad.yaml` line 5, not the prose around it.
	"helm-lint/real": {
		status: "succeeded",
		semantic: "blocking",
		findings: [
			{ rule: "info", semantic: "warning", file: "Chart.yaml" },
			{
				rule: "error",
				semantic: "blocking",
				file: "templates/bad.yaml",
				line: 5,
			},
		],
	},
	// helm does not quote the name in a template parse error, so a name with a
	// space must still resolve to the real file (#4453).
	"helm-lint/space-in-name": {
		status: "succeeded",
		semantic: "blocking",
		findings: [
			{ rule: "info", semantic: "warning", file: "Chart.yaml" },
			{
				rule: "error",
				semantic: "blocking",
				file: "templates/my file.yaml",
				line: 5,
			},
		],
	},
};

/** Version probes the toolchain clients run before the invocation under test. */
const AVAILABILITY_PROBE_ARGV: readonly (readonly string[])[] = [
	["version"],
	["--version"],
	["clippy", "--version"],
];

/**
 * True when every token of `needle` appears in `haystack` in the same relative
 * order. Membership alone is not enough: sqlfluff's #1937 argv bug reordered
 * `--dialect` into the middle of `--format json` while keeping every token.
 */
function isOrderedSubsequence(
	needle: readonly string[],
	haystack: readonly string[],
): boolean {
	let cursor = 0;
	for (const token of haystack) {
		if (cursor < needle.length && token === needle[cursor]) cursor++;
	}
	return cursor === needle.length;
}

function createCtx(kind: string, filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

const FIXTURES = listCapturedOutputs();

describe("captured real-binary output", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	it("has at least one captured fixture", () => {
		expect(
			FIXTURES.length,
			"tests/fixtures/runner-output is empty — the replay suite would pass vacuously",
		).toBeGreaterThan(0);
	});

	it("every captured fixture has a replay descriptor", () => {
		const missing = FIXTURES.filter(
			(f) => !RUNNER_DESCRIPTORS[f.provenance.runner],
		).map((f) => `${f.relPath} (runner "${f.provenance.runner}")`);
		expect(
			missing,
			`captured fixture(s) with no RUNNER_DESCRIPTORS entry — add one so the bytes are actually replayed: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every replay descriptor has a captured fixture", () => {
		const captured = new Set(FIXTURES.map((f) => f.provenance.runner));
		const orphans = Object.keys(RUNNER_DESCRIPTORS).filter(
			(id) => !captured.has(id),
		);
		expect(
			orphans,
			`descriptor(s) for a runner with no captured fixture — capture bytes or drop the entry: ${orphans.join(", ")}`,
		).toEqual([]);
	});

	for (const fixture of FIXTURES) {
		const runnerId = fixture.provenance.runner;
		const descriptor = RUNNER_DESCRIPTORS[runnerId];
		if (!descriptor) continue;

		// `vi.resetModules()` gives every case a fresh module graph, so each one
		// re-imports the whole runner tree. On a cold cache — the first run
		// after `npm run build` rewrites the compiled .js — a late case has
		// been observed taking over six seconds, which the 5s default turns
		// into a timeout that reads like a parser failure. The budget is
		// generous because this suite spawns nothing; a real assertion failure
		// still reds immediately.
		it(
			`${runnerId} (${fixture.caseName}) parses findings out of ${fixture.provenance.tool} ${fixture.provenance.version} output`,
			{
				timeout: 30000,
			},
			async () => {
				const env = setupTestEnvironment(`pi-lens-captured-${runnerId}-`);
				try {
					// The provenance names the repo workspace the bytes came from, so
					// the replay runs against the same planted violation the capture did.
					const source = path.join(repoRoot, fixture.provenance.workspace);
					fs.cpSync(source, env.tmpDir, { recursive: true });
					const filePath = path.join(env.tmpDir, fixture.file);
					expect(
						fs.existsSync(filePath),
						`${fixture.relPath}: ${fixture.provenance.workspace}/${fixture.file} is missing`,
					).toBe(true);

					// Everything except an availability probe answers with the captured
					// bytes. go-vet and rust-clippy find their toolchain through
					// goClient/rustClient, which run `<tool> version|--version` and
					// `cargo clippy --version` before the real invocation. Those are
					// different invocations whose own output nobody captured here, so
					// they report "installed" and the run under test reaches its parse
					// step; the process boundary (safeSpawnAsync) is the only thing
					// mocked.
					const captured = materialize(fixture, env.tmpDir);
					safeSpawnAsync.mockImplementation(
						async (_cmd: string, args: string[]) =>
							AVAILABILITY_PROBE_ARGV.some(
								(probe) =>
									probe.length === args.length &&
									probe.every((token, at) => token === args[at]),
							)
								? { error: null, status: 0, stdout: "probe ok", stderr: "" }
								: captured,
					);

					const runner = (
						await import(
							`../../../../clients/dispatch/runners/${descriptor.module}.js`
						)
					).default;
					const result = await runner.run(
						createCtx(descriptor.kind, filePath, env.tmpDir) as never,
					);

					// Argv tie. Captured bytes are evidence about THIS runner only
					// while the runner still asks the tool for them the same way.
					// The mock answers whatever the runner spawns, so without this
					// a flag the tool would reject — the taplo bug exactly —
					// replays green forever.
					//
					// Order matters, not just membership: sqlfluff's #1937 bug put
					// `--dialect` BETWEEN `--format` and its value, and every token
					// was still present. So the recorded argv must appear as an
					// ordered subsequence. File paths are dropped, because the
					// runner resolves them to absolute and the capture did not.
					const fileTokens = new Set([
						fixture.file,
						path.basename(fixture.file),
						fixture.file.replace(/\\/g, "/"),
					]);
					// A token the capture spawned with the workspace's absolute path
					// (helm lint `<chart root>`) maps to this replay's own workspace.
					const recorded = (fixture.provenance.argv ?? [])
						.filter((token) => !fileTokens.has(token))
						.map((token) =>
							token.split(WORKSPACE_TOKEN).join(path.resolve(env.tmpDir)),
						);
					const spawnedArgvs = safeSpawnAsync.mock.calls.map(
						(call) => (call[1] ?? []) as string[],
					);
					expect(
						spawnedArgvs.length,
						`${runnerId} never spawned anything, so the captured bytes prove nothing`,
					).toBeGreaterThan(0);
					expect(
						spawnedArgvs.some((argv) => isOrderedSubsequence(recorded, argv)),
						`${runnerId} spawned none of ${JSON.stringify(spawnedArgvs)} carrying its fixture's argv ${JSON.stringify(recorded)} in order. Either the runner's invocation drifted from \`${fixture.provenance.command}\`, or the fixture and the scripts/capture-runner-fixtures.mjs manifest need updating to the new argv.`,
					).toBe(true);

					expect(
						result.diagnostics.length,
						`${runnerId} parsed 0 diagnostics out of real ${fixture.provenance.tool} ${fixture.provenance.version} output (exit ${fixture.exitCode}). Re-capture with \`${fixture.provenance.command}\` and fix the parser.`,
					).toBeGreaterThan(0);
					expect(result.status).not.toBe("skipped");
					const expected =
						REPLAY_EXPECTATIONS[`${runnerId}/${fixture.caseName}`];
					if (expected) {
						expect(
							{ status: result.status, semantic: result.semantic },
							`${runnerId} verdict over real ${fixture.provenance.tool} ${fixture.provenance.version} output`,
						).toEqual({
							status: expected.status,
							semantic: expected.semantic,
						});
						expect(
							(result.diagnostics as Array<Record<string, unknown>>).map(
								(diagnostic) => ({
									rule: diagnostic.rule,
									semantic: diagnostic.semantic,
									file: path
										.relative(env.tmpDir, String(diagnostic.filePath))
										.replace(/\\/g, "/"),
									line: diagnostic.line,
								}),
							),
						).toEqual(expected.findings);
						return;
					}
					for (const diagnostic of result.diagnostics as Array<
						Record<string, unknown>
					>) {
						expect(
							diagnostic.message,
							`${runnerId} emitted a blank message`,
						).toBeTruthy();
						expect(
							typeof diagnostic.line === "number" &&
								(diagnostic.line as number) >= 1,
							`${runnerId} emitted a non-positive line number: ${String(diagnostic.line)}`,
						).toBe(true);
					}
				} finally {
					env.cleanup();
				}
			},
		);
	}
});
