import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	checkActionPins,
	checkInterpreterPins,
	parseActionPins,
	resolveGithubMatchingTags,
	resolveGithubTag,
	validatePins,
	workflowFiles,
} from "../../scripts/check-action-pins.mjs";
import {
	setupTestEnvironment,
	useTrackedTempDirs,
} from "../clients/test-utils.js";

// The entry-point case builds a one-file workflow root of its own.
useTrackedTempDirs("pi-lens-action-pins-entry-");

const GOOD = "0057852bfaa89a56745cba8c7296529d2fc39830";
const BAD = "6849a6489940f00c2f30c0fb92c6274307ccb58a";
const FIXTURE = readFileSync(
	join(process.cwd(), "tests/fixtures/action-pins/sample.yml"),
	"utf8",
);

describe("check-action-pins parser (#4043)", () => {
	it("finds SHA pins, preserves paths, and ignores non-pinned uses", () => {
		const pins = parseActionPins(FIXTURE, "fixture.yml");
		expect(pins).toEqual([
			{
				action: "actions/cache/restore",
				sha: GOOD,
				tag: "v4.3.0",
				file: "fixture.yml",
				line: 2,
			},
			{
				action: "local/action",
				sha: BAD,
				tag: "",
				file: "fixture.yml",
				line: 4,
			},
		]);
	});

	it("reports the missing version comment that caused #4043", async () => {
		const pins = parseActionPins(`- uses: actions/cache@${BAD}`, "fixture.yml");
		await expect(validatePins(pins, async () => GOOD)).resolves.toEqual([
			`fixture.yml:1: actions/cache@${BAD} has no version comment`,
		]);
	});

	it("rejects the stale actions/cache SHA through the resolver seam", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${BAD} # v4.3.0`,
			"fixture.yml",
		);
		await expect(validatePins(pins, async () => GOOD)).resolves.toEqual([
			`fixture.yml:1: actions/cache # v4.3.0 resolves to ${GOOD}, not ${BAD}`,
		]);
	});

	it("accepts a full semver comment only at its exact peeled release", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4.3.0`,
			"fixture.yml",
		);
		await expect(validatePins(pins, async () => GOOD)).resolves.toEqual([]);
		await expect(validatePins(pins, async () => BAD)).resolves.toEqual([
			`fixture.yml:1: actions/cache # v4.3.0 resolves to ${BAD}, not ${GOOD}`,
		]);
	});

	it("accepts a major-only comment when a release tag carries the pin", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4`,
			"fixture.yml",
		);
		await expect(
			validatePins(pins, async () => [
				{ tag: "v4.2.0", sha: GOOD },
				{ tag: "v4.3.0", sha: BAD },
			]),
		).resolves.toEqual([]);
	});

	it("rejects a major-only comment when no matching release carries the pin", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4`,
			"fixture.yml",
		);
		await expect(
			validatePins(pins, async () => [{ tag: "v4.3.0", sha: BAD }]),
		).resolves.toEqual([
			`fixture.yml:1: actions/cache@${GOOD} is not a v4 release; nearest tags: v4.3.0`,
		]);
	});

	it("accepts a minor-only comment when a matching release carries the pin", async () => {
		const pins = parseActionPins(
			`- uses: actions/cache@${GOOD} # v4.3`,
			"fixture.yml",
		);
		await expect(
			validatePins(pins, async () => [{ tag: "v4.3.0", sha: GOOD }]),
		).resolves.toEqual([]);
	});

	it("peels an annotated tag at the GitHub API process boundary", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			calls.push(String(input));
			return calls.length === 1
				? new Response(
						JSON.stringify({ object: { type: "tag", sha: "tag-object" } }),
						{ status: 200 },
					)
				: new Response(JSON.stringify({ object: { sha: GOOD } }), {
						status: 200,
					});
		};
		expect(
			await resolveGithubTag("actions/cache", "v4.3.0", fetchImpl, {}),
		).toBe(GOOD);
		expect(calls).toEqual([
			"https://api.github.com/repos/actions/cache/git/ref/tags/v4.3.0",
			"https://api.github.com/repos/actions/cache/git/tags/tag-object",
		]);
	});

	it("resolves matching release refs and peels annotated releases", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string | URL | Request) => {
			calls.push(String(input));
			return calls.length === 1
				? new Response(
						JSON.stringify([
							{ ref: "refs/tags/v6", object: { type: "commit", sha: BAD } },
							{
								ref: "refs/tags/v6.5.0",
								object: { type: "tag", sha: "tag-object" },
							},
						]),
						{ status: 200 },
					)
				: new Response(JSON.stringify({ object: { sha: GOOD } }), {
						status: 200,
					});
		};
		expect(
			await resolveGithubMatchingTags(
				"actions/setup-node",
				"v6",
				fetchImpl,
				{},
			),
		).toEqual([{ tag: "v6.5.0", sha: GOOD }]);
		expect(calls).toEqual([
			"https://api.github.com/repos/actions/setup-node/git/matching-refs/tags/v6.",
			"https://api.github.com/repos/actions/setup-node/git/tags/tag-object",
		]);
	});

	// Recurrence #4422 F3 (#4427): the three resolvers each built their own
	// header block until it moved to githubHeaders. These pin the behaviour the
	// move must keep: the token (GITHUB_TOKEN, else GH_TOKEN) goes out as a
	// Bearer header on every request of a peel, and an anonymous run sends none.
	describe("request headers", () => {
		const capture = () => {
			const seen: Array<Record<string, string>> = [];
			const fetchImpl = async (_input: unknown, init?: RequestInit) => {
				seen.push(init?.headers as Record<string, string>);
				return seen.length === 1
					? new Response(
							JSON.stringify([
								{ ref: "refs/tags/v6.5.0", object: { type: "tag", sha: "t" } },
							]),
							{ status: 200 },
						)
					: new Response(JSON.stringify({ object: { sha: GOOD } }), {
							status: 200,
						});
			};
			return { seen, fetchImpl };
		};

		it.each([
			["GITHUB_TOKEN", { GITHUB_TOKEN: "gh-tok" }, "Bearer gh-tok"],
			["GH_TOKEN", { GH_TOKEN: "cli-tok" }, "Bearer cli-tok"],
			[
				"GITHUB_TOKEN over GH_TOKEN",
				{ GITHUB_TOKEN: "gh-tok", GH_TOKEN: "cli-tok" },
				"Bearer gh-tok",
			],
		])(
			"sends %s as a Bearer header on both requests of a peel",
			async (_n, env, header) => {
				const { seen, fetchImpl } = capture();
				await resolveGithubMatchingTags(
					"actions/setup-node",
					"v6",
					fetchImpl,
					env,
				);
				expect(seen.map((headers) => headers.Authorization)).toEqual([
					header,
					header,
				]);
				expect(seen[0].Accept).toBe("application/vnd.github+json");
			},
		);

		it("sends no Authorization header without a token", async () => {
			const { seen, fetchImpl } = capture();
			await resolveGithubMatchingTags(
				"actions/setup-node",
				"v6",
				fetchImpl,
				{},
			);
			expect(seen).toHaveLength(2);
			for (const headers of seen) {
				expect(Object.keys(headers)).not.toContain("Authorization");
			}
		});

		it.each([
			["GITHUB_TOKEN", { GITHUB_TOKEN: "gh-tok" }, "Bearer gh-tok"],
			["GH_TOKEN", { GH_TOKEN: "cli-tok" }, "Bearer cli-tok"],
		])("sends %s on the single-tag resolver too", async (_n, env, header) => {
			const seen: Array<Record<string, string>> = [];
			const fetchImpl = async (_input: unknown, init?: RequestInit) => {
				seen.push(init?.headers as Record<string, string>);
				return new Response(JSON.stringify({ object: { sha: GOOD } }), {
					status: 200,
				});
			};
			await resolveGithubTag("actions/cache", "v4.3.0", fetchImpl, env);
			expect(seen[0].Authorization).toBe(header);
		});
	});
});

// #4666: `python-version: "3.x"` resolved to a CPython with no pyyaml wheel
// under `--only-binary=:all:`, so the advisory yamllint row installed nothing
// and the workflow still read green. The precondition was static text, so the
// rule lives in the walker that already reads every workflow and composite
// action. Shape 69: one positive test decides (a concrete `x.y` or `x.y.z`),
// so no list of known-bad spellings can pass an unlisted one.
const SETUP_PYTHON = "actions/setup-python";
const SETUP_PYTHON_REF = "5fda3b95a4ea91299a34e894583c3862153e4b97";
const TREE_ROOT = process.cwd();
const USE = `actions/setup-python@${SETUP_PYTHON_REF}`;

// Steps written at the repository workflows' own step indent (six spaces).
function workflow(steps: string): string {
	return `jobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n${steps
		.split("\n")
		.map((line) => `      ${line}`)
		.join("\n")}\n`;
}

// A one-step workflow whose setup-python pin is `raw`, unsplit value included.
function pinned(raw: string): string {
	return workflow(`- uses: ${USE}\n  with:\n    python-version: ${raw}`);
}

// Line 7 is the python-version line of `pinned()`; line 5 is its uses line.
const notConcrete = (value: string, line = 7) =>
	`fixture.yml:${line}: ${USE} python-version "${value}" is not a concrete x.y or x.y.z release`;
const noPin = `${USE} has no with: python-version; the interpreter channel must be a concrete x.y release`;

describe("check-action-pins interpreter pins (#4666, shape 69)", () => {
	// Every non-concrete spelling, including the ones a list of known-bad
	// strings would not carry: an unlisted float, an expression, a matrix
	// reference, an empty value, a block scalar.
	it.each([
		["the floating channel", '"3.x"', "3.x"],
		["a bare major", "3", "3"],
		["a bare minor-only float", "3.12.x", "3.12.x"],
		["the latest channel", "latest", "latest"],
		["an unquoted channel", "3.x", "3.x"],
		["a range specifier", '">=3.12"', ">=3.12"],
		["a pre-release", '"3.12-rc1"', "3.12-rc1"],
		["a wildcard", '"*"', "*"],
		["a matrix expression", "${{ matrix.python }}", "${{ matrix.python }}"],
		[
			"a matrix reference through a hyphenated key",
			"${{ matrix.python-version }}",
			"${{ matrix.python-version }}",
		],
		["an env expression", "${{ env.PYTHON }}", "${{ env.PYTHON }}"],
		[
			"a composite input expression",
			"${{ inputs.python }}",
			"${{ inputs.python }}",
		],
		["a quoted empty value", '""', ""],
		["an absent value", "", ""],
		["a block scalar", "|", "|"],
		["an unterminated quote", '"3.12', '"3.12'],
	])("refuses %s", (_label, raw, value) => {
		expect(checkInterpreterPins(pinned(raw), "fixture.yml")).toEqual([
			notConcrete(value),
		]);
	});

	// The controls: the two concrete forms the rule admits, in every spelling
	// a workflow uses for them, and a trailing comment after the value.
	it.each([
		["a quoted x.y", '"3.12"'],
		["a single-quoted x.y", "'3.12'"],
		["a bare x.y", "3.12"],
		["a quoted x.y.z", '"3.12.15"'],
		["a single-quoted x.y.z", "'3.12.15'"],
		["a bare x.y.z", "3.12.15"],
		["a quoted x.y with a trailing comment", '"3.12" # #4666: the pin'],
	])("accepts %s", (_label, raw) => {
		expect(checkInterpreterPins(pinned(raw), "fixture.yml")).toEqual([]);
	});

	it("reads the pin under a comment block and a preceding name key", () => {
		// The shape the fixed .github/workflows/lint.yml has: `- name:`, `uses:`
		// on its own line, then a three-line comment above the value.
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- name: Set up Python`,
						`  uses: ${USE}`,
						`  with:`,
						`    # #4666: the floating channel reached an interpreter with`,
						`    # no cp315 pyyaml wheel under --only-binary=:all:.`,
						`    python-version: "3.x"`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([notConcrete("3.x", 10)]);
	});

	it("reports a setup-python step that has no with: block", () => {
		expect(
			checkInterpreterPins(workflow(`- uses: ${USE}`), "fixture.yml"),
		).toEqual([`fixture.yml:5: ${noPin}`]);
	});

	it("reports a with: block that carries no python-version", () => {
		expect(
			checkInterpreterPins(
				workflow(`- uses: ${USE}\n  with:\n    cache: pip`),
				"fixture.yml",
			),
		).toEqual([`fixture.yml:5: ${noPin}`]);
	});

	it("refuses a with: it cannot read as a block mapping", () => {
		expect(
			checkInterpreterPins(
				workflow(`- uses: ${USE}\n  with: {python-version: "3.12"}`),
				"fixture.yml",
			),
		).toEqual([
			`fixture.yml:6: ${USE} with: is not a block mapping; the python-version pin cannot be read`,
		]);
	});

	it("refuses a setup-python step shape it cannot read", () => {
		// A flow-map step is not the block form the walker reads. It fails
		// closed rather than passing an unread pin (shape 69).
		expect(
			checkInterpreterPins(
				workflow(`- {uses: ${USE}, with: {python-version: "3.12"}}`),
				"fixture.yml",
			),
		).toEqual([
			`fixture.yml:5: ${SETUP_PYTHON} uses: is not a block-mapping step; the python-version pin cannot be read`,
		]);
	});

	// PRRT_kwDORt8rec6uW1l7 / PRRT_kwDORt8rec6uXCpF: a flow mapping is a step
	// wherever it stands — as the value of `steps:` as well as a list item —
	// and its `uses` key may be quoted. Round 3 read only a line the block
	// reader did not classify as a key, and let the quote branch consume a
	// quoted key, so both spellings passed a floating pin. Shape 69: the
	// walker does not read a flow step's `with:` keys, so it refuses the step.
	it.each([
		[
			"a one-line flow sequence under steps:",
			`jobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps: [{uses: ${USE}, with: {python-version: "3.x"}}]`,
			4,
		],
		[
			"a flow step whose uses key is double-quoted",
			workflow(`- {"uses": ${USE}, with: {python-version: "3.x"}}`),
			5,
		],
		[
			"a flow step whose uses key is single-quoted",
			workflow(`- {'uses': ${USE}, with: {python-version: "3.x"}}`),
			5,
		],
	])("refuses %s", (_label, text, line) => {
		expect(checkInterpreterPins(text, "fixture.yml")).toEqual([
			`fixture.yml:${line}: ${SETUP_PYTHON} uses: is not a block-mapping step; the python-version pin cannot be read`,
		]);
	});

	// PRRT_kwDORt8rec6uXCpP: a flow step's `with:` mapping holds the action's
	// own inputs, and `uses` is one of them for a wrapper action. Only a key of
	// the step's own mapping is its action, so the nested one is not read as a
	// step and does not fail CI.
	it("reads the step's own uses, not another action's nested input", () => {
		const wrapper = `owner/action@${SETUP_PYTHON_REF}`;
		expect(
			checkInterpreterPins(
				workflow(`- {uses: ${wrapper}, with: {uses: ${USE}}}`),
				"fixture.yml",
			),
		).toEqual([]);
		expect(
			checkInterpreterPins(
				workflow(`- {uses: ${wrapper}, with: {shell: bash}}`),
				"fixture.yml",
			),
		).toEqual([]);
		// The step's own key still decides when the nested input repeats it.
		expect(
			checkInterpreterPins(
				workflow(`- {uses: ${USE}, with: {uses: ${USE}}}`),
				"fixture.yml",
			),
		).toEqual([
			`fixture.yml:5: ${SETUP_PYTHON} uses: is not a block-mapping step; the python-version pin cannot be read`,
		]);
	});

	// PRRT_kwDORt8rec6uV23n: a value the walker has not fully read is not a
	// value it read. Shape 69 refuses the form instead of listing spellings.
	it("refuses a uses: value whose spelling it does not decode", () => {
		// `"\u0061ctions/setup-python"` is the action name; the walker decodes
		// no YAML escape, so neither pass could name the action and a floating
		// pin under it read green.
		const escaped = `"\\u0061ctions/setup-python@${SETUP_PYTHON_REF}"`;
		expect(
			checkInterpreterPins(
				workflow(`- uses: ${escaped}\n  with:\n    python-version: "3.x"`),
				"fixture.yml",
			),
		).toEqual([
			`fixture.yml:5: uses: ${escaped} is not a value this walker reads; the python-version pin cannot be read`,
		]);
	});

	it("refuses a python-version value it has not fully read", () => {
		// `'3.12''x'` closes and reopens the quote, so the value is `3.12'x`
		// and the prefix `3.12` is not the pin. The escape spelling is the same
		// gap in the value reader.
		expect(checkInterpreterPins(pinned(`'3.12''x'`), "fixture.yml")).toEqual([
			notConcrete(`'3.12''x'`),
		]);
		expect(checkInterpreterPins(pinned(`"\\u0033.12"`), "fixture.yml")).toEqual(
			[notConcrete("\\u0033.12")],
		);
		expect(checkInterpreterPins(pinned(`"3.12" 'x'`), "fixture.yml")).toEqual([
			notConcrete(`"3.12" 'x'`),
		]);
	});

	// A `uses:` value on another line is the same unread spelling: the walker
	// cannot name the action, so it must not pass the step.
	it.each([
		["no inline value", `- uses:\n  with:\n    python-version: "3.12"`, ""],
		[
			"a block scalar value",
			`- uses: |\n    ${USE}\n  with:\n    python-version: "3.x"`,
			"|",
		],
	])("refuses a uses: key with %s", (_label, steps, shown) => {
		expect(checkInterpreterPins(workflow(steps), "fixture.yml")).toEqual([
			`fixture.yml:5: uses: "${shown}" is not a value this walker reads; the python-version pin cannot be read`,
		]);
	});

	// PRRT_kwDORt8rec6uV19K: GitHub owner and repository names are
	// case-insensitive, so the spelling is not the action's identity.
	it("matches the action name in any case, in both passes", () => {
		const mixed = `Actions/Setup-Python@${SETUP_PYTHON_REF}`;
		expect(
			checkInterpreterPins(
				workflow(`- uses: ${mixed}\n  with:\n    python-version: "3.x"`),
				"fixture.yml",
			),
		).toEqual([
			`fixture.yml:7: ${mixed} python-version "3.x" is not a concrete x.y or x.y.z release`,
		]);
		// The fail-closed pass reads the same identity.
		expect(
			checkInterpreterPins(
				workflow(`- {uses: ${mixed}, with: {python-version: "3.x"}}`),
				"fixture.yml",
			),
		).toEqual([
			`fixture.yml:5: ${SETUP_PYTHON} uses: is not a block-mapping step; the python-version pin cannot be read`,
		]);
		expect(
			checkInterpreterPins(
				workflow(`- uses: ${mixed}\n  with:\n    python-version: "3.12"`),
				"fixture.yml",
			),
		).toEqual([]);
	});

	// PRRT_kwDORt8rec6uV23r, shape 43: a `run:` body is shell or prose. A
	// printed `uses:` line is text — even a whole step-shaped heredoc body — and
	// only lines that carry YAML structure are read.
	it("leaves a block scalar's body alone", () => {
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- run: |`,
						`    echo "uses: ${USE}"`,
						`    uses: ${USE}`,
						`    with:`,
						`      python-version: "3.x"`,
						`  shell: bash`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([]);
		// A one-line `run:` is prose too: `uses:` there is not a key.
		expect(
			checkInterpreterPins(
				workflow(`- run: echo uses: ${USE}\n  shell: bash`),
				"fixture.yml",
			),
		).toEqual([]);
	});

	it("leaves a block scalar inside a with: block alone", () => {
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- uses: ${USE}`,
						`  with:`,
						`    python-version: "3.12"`,
						`    args: |`,
						`      python-version: "3.x"`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([]);
	});

	// PRRT_kwDORt8rec6uXCo5: a block-scalar header carries an optional
	// indentation and chomping indicator in either order, and a trailing
	// comment beside them. Every form opens a literal block, so the shell body
	// under it — a heredoc that writes a step — stays text and does not fail
	// CI (shape 43).
	it.each([
		["a trailing comment", "| # build steps"],
		["an indentation then chomping indicator", "|2-"],
		["a chomping then indentation indicator", "|-2"],
		["an indentation then keep indicator", "|2+"],
		["a folded scalar with a comment", "> # fold the notes"],
	])("leaves a block scalar's body alone with %s", (_label, header) => {
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- run: ${header}`,
						`    cat > step.yml <<'EOF'`,
						`    uses: ${USE}`,
						`    with:`,
						`      python-version: "3.x"`,
						`    EOF`,
						`  shell: bash`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([]);
	});

	it("ends the scalar at its own key and still reads a later step", () => {
		// The protection is a bound, not a blind spot: `shell:` sits at the
		// step's column, so the body ends there and the next step is read.
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- run: | # build steps`,
						`    echo "uses: ${USE}"`,
						`  shell: bash`,
						`- uses: ${USE}`,
						`  with:`,
						`    python-version: "3.x"`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([notConcrete("3.x", 10)]);
	});

	// A blank line and a comment are not the step's keys, and a blank line's
	// column is not the step's indent: the classification is what keeps the
	// reader from ending a step at either (shape 43).
	it("reads a step whose keys are separated by a comment and a blank line", () => {
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- name: Set up Python`,
						`  # the interpreter this row's install needs`,
						`  uses: ${USE}`,
						``,
						`  with:`,
						`    python-version: "3.12"`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([]);
	});

	// PRRT_kwDORt8rec6uV230: `with: # Keep this pinned` is copy, not an inline
	// mapping, so the value below it still decides.
	it("reads a with: key that carries only a comment", () => {
		expect(
			checkInterpreterPins(
				workflow(
					`- uses: ${USE}\n  with: # Keep this pinned\n    python-version: "3.12"`,
				),
				"fixture.yml",
			),
		).toEqual([]);
		expect(
			checkInterpreterPins(
				workflow(
					`- uses: ${USE}\n  with: # Keep this pinned\n    python-version: "3.x"`,
				),
				"fixture.yml",
			),
		).toEqual([notConcrete("3.x")]);
	});

	// PRRT_kwDORt8rec6uV236: the rule must run where CI runs it — the walker's
	// entry point — and not only when a test calls the rule itself.
	it("runs the interpreter rule through checkActionPins", async () => {
		const root = setupTestEnvironment("pi-lens-action-pins-entry-").tmpDir;
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		// A tag ref, so parseActionPins pins nothing and no tag is resolved:
		// the only error this root can produce is the interpreter pin.
		const tagUse = `actions/setup-python@v7.0.0`;
		writeFileSync(
			join(root, ".github", "workflows", "lint.yml"),
			workflow(`- uses: ${tagUse}\n  with:\n    python-version: "3.x"`),
		);
		const errors = await checkActionPins({
			root,
			fetchImpl: async () => {
				throw new Error("the probe pins no tag, so the resolver must not run");
			},
		});
		expect(errors).toEqual([
			`.github/workflows/lint.yml:7: ${tagUse} python-version "3.x" is not a concrete x.y or x.y.z release`,
		]);
	});

	it("reads every python-version spelling in a step, whatever its case", () => {
		// GitHub passes action inputs as an upper-cased `INPUT_*` variable, so
		// the key is case-insensitive for the action too. A concrete value in
		// the canonical spelling does not cover a floating one beside it.
		expect(
			checkInterpreterPins(
				workflow(
					`- uses: ${USE}\n  with:\n    python-version: "3.12"\n    Python-Version: "3.x"`,
				),
				"fixture.yml",
			),
		).toEqual([notConcrete("3.x", 8)]);
	});

	it("leaves every other action's version input alone", () => {
		expect(
			checkInterpreterPins(
				workflow(
					[
						`- uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`,
						`  with:`,
						`    node-version: "22"`,
						`- uses: erlef/setup-beam@54075bcc5e249e4758d363f27d099f55d843f124 # v1`,
						`  with:`,
						`    otp-version: latest`,
					].join("\n"),
				),
				"fixture.yml",
			),
		).toEqual([]);
	});

	it("reads the steps of a composite action under .github/actions/", () => {
		expect(
			checkInterpreterPins(
				`runs:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n    - uses: ${USE}\n      with:\n        python-version: "3.x"\n`,
				".github/actions/tool-tree-cache/action.yml",
			),
		).toEqual([
			notConcrete("3.x", 8).replace(
				"fixture.yml",
				".github/actions/tool-tree-cache/action.yml",
			),
		]);
	});

	it("passes every setup-python step in the tree, and counts four of them", async () => {
		const files = await workflowFiles(TREE_ROOT);
		const repoPath = (file: string) =>
			relative(TREE_ROOT, file).split(sep).join("/");
		const errors: string[] = [];
		let uses = 0;
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			errors.push(...checkInterpreterPins(text, repoPath(file)));
			// Counted here, not through the rule: an empty walk or a parser
			// change must not pass this vacously.
			for (const line of text.split(/\r?\n/))
				if (/^\s*(?:-\s+)?uses:\s*["']?actions\/setup-python@/.test(line))
					uses += 1;
		}
		// The fixed lint.yml is the population member this PR repairs.
		const lint = readFileSync(
			join(TREE_ROOT, ".github/workflows/lint.yml"),
			"utf8",
		);
		expect(checkInterpreterPins(lint, ".github/workflows/lint.yml")).toEqual(
			[],
		);
		expect(lint).toContain('python-version: "3.12"');
		// Four `setup-python` uses, all concrete after this PR.
		expect(uses).toBe(4);
		expect(errors).toEqual([]);
		// The population the rule reads: every workflow and composite action.
		expect(files.length).toBe(26);
		// The composite actions are inside the walk the rule runs over.
		expect(files.map(repoPath)).toContain(
			".github/actions/tool-tree-cache/action.yml",
		);
	});
});
