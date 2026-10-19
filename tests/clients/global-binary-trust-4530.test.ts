/**
 * #4530: global binary lookups honour project trust.
 *
 * pi-lens finds tools outside the project in three ways: the package
 * managers' global bin dirs (`findGlobalBinary`, the installer's npm-global
 * rung), PATH (the installer's PATH rung), and the package manager itself
 * (installs, managed refresh). Under pi trust `unknown` or `untrusted`, none
 * of them may run a binary that lives inside the project, and project
 * configuration may not redirect them; a trusted project behaves as before.
 *
 * Every case drives the production lookup against real files: the project
 * fixtures are shell scripts that leave a marker when they run, and the real
 * package manager on PATH answers the global-bin queries. Recurrence guarded:
 * a lookup outside the project-local walk (#4248, #4515) still reaching into
 * the project.
 */
import https from "node:https";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import {
	installTool,
	checkProbeCache,
	isCommandAvailable,
	isSpawnableCommand,
	verifyToolBinary,
	ensureTool,
	getAllToolStatuses,
	getInstallAttempt,
	getToolEnvironment,
	getToolPath,
	refreshManagedTool,
	resetProbeCacheStateForTesting,
	resetResolvedPathCache,
	flushProbeCache,
	updateProbeCache,
} from "../../clients/installer/index.js";
import {
	resolveAndLaunch,
	TypeScriptServer,
	tryDotnetToolInstall,
	tryGemInstall,
	tryGoInstallGopls,
} from "../../clients/lsp/server.js";
import {
	_resetPackageManagerCache,
	findGlobalBinary,
	allAvailableGlobalBinDirs,
	normalizeSearchPath,
	commandResolvesIntoProject,
	findNodeToolBinary,
	resolveNodePackageManager,
	trustScopedPath,
} from "../../clients/package-manager.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	resetLazyInstallAttempts,
	tryLazyInstall,
	tryLazyInstallForFormatter,
} from "../../clients/dispatch/runners/utils/lazy-installer.js";
import {
	admitSpawnExecutable,
	isCommandAvailableAsync,
	isAcceptedCommandFile,
	findCommandAsync,
} from "../../clients/safe-spawn.js";
import { trustScopedSpawnEnv } from "../../clients/package-manager.js";
import {
	resolveJavaRuntimeEnv,
	_resetJvmRuntimeCacheForTests,
} from "../../clients/lsp/jvm-runtime.js";
import { removeTempDirSync } from "./test-utils.js";

const FIXTURE_TOOL = "pi-lens-4530-fixture-ls";
const SAVED_ENV = [
	"PATH",
	"HOME",
	"npm_config_prefix",
	"NPM_CONFIG_PREFIX",
	"PI_LENS_DISABLE_TOOL_INSTALL",
	"PI_LENS_TEST_MODE",
] as const;
const savedEnv: NodeJS.ProcessEnv = {};
const originalCwd = process.cwd();
const dirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A project root; `marker` exists once any fixture planted in it has run. */
function makeProject() {
	const root = tempDir("pi-lens-4530-project-");
	fs.writeFileSync(path.join(root, "package.json"), "{}\n");
	const marker = path.join(root, "executed.marker");
	return {
		root,
		marker,
		bin: path.join(root, "node_modules", ".bin"),
		ran: (): string =>
			fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "",
	};
}

function writeScript(file: string, body: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body, { mode: 0o755 });
	return file;
}

/** A shell fixture that appends its argv to `marker` and prints a version. */
function plant(file: string, marker: string): string {
	return writeScript(
		file,
		`#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\necho 1.0.0\n`,
	);
}

function dirOf(command: string): string {
	const found = (savedEnv["PATH"] ?? "")
		.split(path.delimiter)
		.find((dir) => dir && fs.existsSync(path.join(dir, command)));
	if (!found) throw new Error(`${command} is not on PATH`);
	return found;
}

function trustRows(fragment: string) {
	return getDegradationSummary()
		.filter((group) => group.kind === "trust-refusal")
		.flatMap((group) => group.latestReasons)
		.filter((row) => row.subject.includes(fragment));
}

/** A probe-cache entry for `toolId`, as a past discovery pass leaves it. */
function rememberToolPath(toolId: string, file: string): void {
	const stat = fs.statSync(file);
	fs.mkdirSync(getGlobalPiLensDir(), { recursive: true });
	fs.writeFileSync(
		path.join(getGlobalPiLensDir(), "probe-cache.json"),
		JSON.stringify({
			[toolId]: {
				path: file,
				mtimeMs: stat.mtimeMs,
				sizeBytes: stat.size,
				cachedAt: Date.now(),
			},
		}),
	);
	resetProbeCacheStateForTesting();
}

function clearStore(): void {
	for (const name of ["tools", "pip-tools", "pip-user", "probe-cache.json"]) {
		fs.rmSync(path.join(getGlobalPiLensDir(), name), {
			recursive: true,
			force: true,
		});
	}
}

beforeEach(() => {
	for (const key of SAVED_ENV) savedEnv[key] = process.env[key];
	// The host's own npm prefix variable would answer for the global query.
	delete process.env.npm_config_prefix;
	delete process.env.NPM_CONFIG_PREFIX;
	resetProjectTrust();
	resetDegradationLedger();
	_resetPackageManagerCache();
	resetProbeCacheStateForTesting();
	clearStore();
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetProjectTrust();
	_resetPackageManagerCache();
	resetProbeCacheStateForTesting();
	clearStore();
	while (dirs.length) removeTempDirSync(dirs.pop() as string);
});

// lane: Linux and macOS unit shards; the fixtures are POSIX shell scripts.
describe.skipIf(process.platform === "win32")(
	"global bin dirs honour project trust (#4530)",
	() => {
		it("keeps project configuration from redirecting the global lookup under unknown trust", async () => {
			const project = makeProject();
			const elsewhere = tempDir("pi-lens-4530-elsewhere-");
			const planted = plant(
				path.join(elsewhere, "bin", FIXTURE_TOOL),
				project.marker,
			);
			fs.writeFileSync(
				path.join(project.root, ".npmrc"),
				`prefix=${elsewhere}\n`,
			);
			process.chdir(project.root);

			setProjectTrustState("unknown");
			expect(await findGlobalBinary(FIXTURE_TOOL)).toBeUndefined();

			// A trusted project behaves as before: its configuration counts.
			setProjectTrustState("trusted");
			expect(await findGlobalBinary(FIXTURE_TOOL)).toBe(planted);
		});

		it("drops a global bin dir inside the project and records it once", async () => {
			const project = makeProject();
			const prefix = path.join(project.root, "prefix");
			const planted = plant(
				path.join(prefix, "bin", FIXTURE_TOOL),
				project.marker,
			);
			process.env.npm_config_prefix = prefix;
			process.chdir(project.root);

			setProjectTrustState("unknown");
			expect(await findGlobalBinary(FIXTURE_TOOL)).toBeUndefined();
			expect(await findGlobalBinary(FIXTURE_TOOL)).toBeUndefined();
			expect(trustRows(`project-path-entry:${prefix}`)).toEqual([
				expect.objectContaining({
					reason:
						"lookup dir inside the project ignored: pi project trust is unknown",
				}),
			]);

			setProjectTrustState("trusted");
			expect(await findGlobalBinary(FIXTURE_TOOL)).toBe(planted);
		});

		it("never runs a PATH lookup helper from a project bin dir", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "which"), project.marker);
			process.env.PATH = [project.bin, savedEnv["PATH"]].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await findGlobalBinary(FIXTURE_TOOL);

			expect(project.ran()).toBe("");
		});

		it("never runs a package manager from a project bin dir", async () => {
			const project = makeProject();
			for (const manager of ["npm", "pnpm", "yarn"]) {
				plant(path.join(project.bin, manager), project.marker);
			}
			process.env.PATH = [project.bin, savedEnv["PATH"]].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await findGlobalBinary(FIXTURE_TOOL);

			expect(project.ran()).toBe("");
			const outside = tempDir("pi-lens-global-");
			for (const manager of ["npm", "pnpm", "yarn"]) {
				fs.symlinkSync(
					path.join(project.bin, manager),
					path.join(outside, manager),
				);
			}
			process.env.PATH = [outside, savedEnv["PATH"]].join(path.delimiter);
			_resetPackageManagerCache();
			await findGlobalBinary(FIXTURE_TOOL);
			expect(project.ran()).toBe("");
		});

		it("resolves the package manager's own runtime outside a project bin dir", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "node"), project.marker);
			process.env.PATH = [project.bin, savedEnv["PATH"]].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await findGlobalBinary(FIXTURE_TOOL);

			expect(project.ran()).toBe("");
		});
	},
);

// lane: Linux and macOS unit shards; the fixtures are POSIX shell scripts.
describe.skipIf(process.platform === "win32")(
	"installer lookups honour project trust (#4530)",
	() => {
		it("skips a PATH entry inside the project in the PATH rung", async () => {
			const project = makeProject();
			const direnvBin = path.join(project.root, "bin");
			plant(path.join(direnvBin, "stylelint"), project.marker);
			process.env.PATH = [direnvBin, path.dirname(process.execPath)].join(
				path.delimiter,
			);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			// A bare-name answer would later resolve through the same PATH, to the
			// project's copy.
			expect(await getToolPath("stylelint")).not.toBe("stylelint");
			expect(project.ran()).toBe("");
			expect(
				getDegradationSummary().filter(
					(group) => group.kind === "installer-path-candidate-unrunnable",
				),
			).toEqual([]);
		});

		it("verifies a PATH candidate with a runtime from outside the project", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "node"), project.marker);
			const outside = tempDir("pi-lens-4530-outside-");
			writeScript(
				path.join(outside, "stylelint"),
				'#!/usr/bin/env node\nconsole.log("16.0.0");\n',
			);
			process.env.PATH = [
				project.bin,
				outside,
				path.dirname(process.execPath),
				savedEnv["PATH"],
			].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			expect(await getToolPath("stylelint")).toBe(
				path.join(outside, "stylelint"),
			);
			expect(project.ran()).toBe("");
		});

		it("never verifies a global-rung binary inside the project", async () => {
			const project = makeProject();
			const prefix = path.join(project.root, "tools-prefix");
			plant(path.join(prefix, "bin", "stylelint"), project.marker);
			fs.writeFileSync(path.join(project.root, ".npmrc"), `prefix=${prefix}\n`);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			expect(await getToolPath("stylelint")).toBeUndefined();
			expect(project.ran()).toBe("");
		});

		it("never asks a project interpreter where user tools live", async () => {
			const project = makeProject();
			const venvBin = path.join(project.root, ".venv", "bin");
			for (const python of ["python3", "python"]) {
				plant(path.join(venvBin, python), project.marker);
			}
			const outside = tempDir("pi-lens-4530-outside-");
			process.env.PATH = [venvBin, outside].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await getToolPath("mypy");

			expect(project.ran()).toBe("");
		});

		it("installs through a package manager from outside the project", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "npm"), project.marker);
			const outside = tempDir("pi-lens-4530-outside-");
			const outsideMarker = path.join(outside, "npm.marker");
			// The outside manager fails at once, so nothing is downloaded.
			writeScript(
				path.join(outside, "npm"),
				`#!/bin/sh\necho "$*" >> ${JSON.stringify(outsideMarker)}\nexit 1\n`,
			);
			process.env.PATH = [project.bin, outside, dirOf("which")].join(
				path.delimiter,
			);
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";
			process.chdir(project.root);
			setProjectTrustState("unknown");

			expect(await ensureTool("stylelint")).toBeUndefined();

			expect(project.ran()).toBe("");
			expect(fs.readFileSync(outsideMarker, "utf8")).toContain("install");
			expect(getInstallAttempt("stylelint")).toMatchObject({
				outcome: "failed",
			});
		});

		it("installs pip tools without a project interpreter", async () => {
			const project = makeProject();
			const venvBin = path.join(project.root, ".venv", "bin");
			for (const name of ["python3", "python", "pip3", "pip", "pipx"]) {
				plant(path.join(venvBin, name), project.marker);
			}
			const outside = tempDir("pi-lens-4530-outside-");
			const userBase = tempDir("pi-lens-4530-user-base-");
			// The outside python accepts every pip rung and names a user base
			// that holds no tool, so the install ends without a download.
			writeScript(
				path.join(outside, "python3"),
				`#!/bin/sh\ncase "$*" in *site*) echo ${JSON.stringify(userBase)};; esac\nexit 0\n`,
			);
			process.env.PATH = [venvBin, outside].join(path.delimiter);
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await ensureTool("mypy");

			expect(project.ran()).toBe("");
		});

		it("runs the private-prefix pip rung without a project interpreter", async () => {
			const project = makeProject();
			const venvBin = path.join(project.root, ".venv", "bin");
			for (const name of ["pip3", "pip", "python3", "python"]) {
				plant(path.join(venvBin, name), project.marker);
			}
			const outside = tempDir("pi-lens-4530-outside-");
			const privateMarker = path.join(outside, "private-rung.argv");
			// Refusing the venv rung and reporting PEP 668 for the --user rung is
			// the only way into the private-prefix rung.
			writeScript(
				path.join(outside, "pip3"),
				`#!/bin/sh\ncase "$*" in *--break-system-packages*) echo "$*" >> ${JSON.stringify(privateMarker)};; esac\necho "error: externally-managed-environment" >&2\nexit 1\n`,
			);
			writeScript(path.join(outside, "python3"), "#!/bin/sh\nexit 1\n");
			process.env.PATH = [venvBin, outside].join(path.delimiter);
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";
			process.chdir(project.root);
			setProjectTrustState("unknown");

			expect(await ensureTool("mypy")).toBeUndefined();

			// The rung ran the OUTSIDE interpreter...
			expect(fs.readFileSync(privateMarker, "utf8")).toContain(
				"--break-system-packages",
			);
			// ...and the project's own pip3 never did.
			expect(project.ran()).toBe("");
		});

		it("installs gems without a project gem", async () => {
			const project = makeProject();
			const vendorBin = path.join(project.root, "vendor", "bin");
			plant(path.join(vendorBin, "gem"), project.marker);
			process.env.PATH = [vendorBin, tempDir("pi-lens-4530-outside-")].join(
				path.delimiter,
			);
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await ensureTool("rubocop");

			expect(project.ran()).toBe("");
		});

		it("never lists a project binary as an installed global tool", async () => {
			const project = makeProject();
			const direnvBin = path.join(project.root, "bin");
			plant(path.join(direnvBin, "stylelint"), project.marker);
			process.env.PATH = [direnvBin, path.dirname(process.execPath)].join(
				path.delimiter,
			);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			const status = (await getAllToolStatuses()).find(
				(entry) => entry.id === "stylelint",
			);

			expect(status?.source).not.toBe("global-path");
			expect(project.ran()).toBe("");
		});

		it("reads a listed global tool's version with a runtime from outside the project", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "node"), project.marker);
			const outside = tempDir("pi-lens-4530-outside-");
			writeScript(
				path.join(outside, "stylelint"),
				'#!/usr/bin/env node\nconsole.log("16.0.0");\n',
			);
			process.env.PATH = [
				project.bin,
				outside,
				path.dirname(process.execPath),
			].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			const status = (await getAllToolStatuses()).find(
				(entry) => entry.id === "stylelint",
			);

			expect(status).toMatchObject({
				source: "global-path",
				version: "16.0.0",
			});
			expect(project.ran()).toBe("");
		});

		it("re-checks a remembered tool with a runtime from outside the project", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "node"), project.marker);
			const outside = tempDir("pi-lens-4530-outside-");
			const remembered = writeScript(
				path.join(outside, "sg"),
				'#!/usr/bin/env node\nconsole.log("ast-grep 0.39.0");\n',
			);
			rememberToolPath("ast-grep", remembered);
			process.env.PATH = [project.bin, path.dirname(process.execPath)].join(
				path.delimiter,
			);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			expect(await checkProbeCache("ast-grep")).toBe(remembered);
			expect(project.ran()).toBe("");
		});

		it(
			"reads a refreshed tool's version with a runtime from outside the project",
			// `refreshManagedTool` runs a real `pip install -U` for this tool, so
			// the default 5s budget is too tight on a cold pip cache (#4530 r7).
			{ timeout: 30_000 },
			async () => {
				const project = makeProject();
				plant(path.join(project.bin, "node"), project.marker);
				const outside = tempDir("pi-lens-4530-outside-");
				const versionMarker = path.join(outside, "version.marker");
				const remembered = writeScript(
					path.join(outside, "mypy"),
					`#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(versionMarker)}, "ran\\n");\nconsole.log("mypy 1.0.0");\n`,
				);
				rememberToolPath("mypy", remembered);
				process.env.PATH = [
					project.bin,
					outside,
					path.dirname(process.execPath),
				].join(path.delimiter);
				delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
				process.env.PI_LENS_TEST_MODE = "0";
				process.chdir(project.root);
				setProjectTrustState("unknown");

				await refreshManagedTool("mypy");

				// The version probe ran, through a runtime outside the project.
				expect(fs.readFileSync(versionMarker, "utf8")).toContain("ran");
				expect(project.ran()).toBe("");
			},
		);

		it("keeps project PATH entries out of the managed tool environment", async () => {
			const project = makeProject();
			const outside = tempDir("pi-lens-4530-outside-");
			process.env.PATH = [project.bin, outside].join(path.delimiter);
			process.chdir(project.root);

			setProjectTrustState("unknown");
			const scoped = (await getToolEnvironment()).PATH?.split(path.delimiter);
			await getToolEnvironment();
			expect(scoped).toContain(outside);
			expect(scoped).not.toContain(project.bin);
			expect(trustRows(`project-path-entry:${project.bin}`)).toHaveLength(1);

			setProjectTrustState("trusted");
			expect(
				(await getToolEnvironment()).PATH?.split(path.delimiter),
			).toContain(project.bin);
		});
	},
);

// R18-R1 class sweep: install strategies must retain executable admission.
describe.skipIf(process.platform === "win32")(
	"r19 installer strategy links",
	() => {
		for (const [id, commands] of [
			["prettier", ["npm", "pnpm", "yarn", "bun"]],
			["mypy", ["pip3", "pip", "python3", "python", "pipx"]],
			["rubocop", ["gem"]],
		] as const) {
			it(`r19 ${id} install runs an outside package manager`, async () => {
				const project = makeProject();
				const outside = tempDir("pi-lens-4530-outside-");
				const marker = path.join(outside, "executed.marker");
				for (const name of commands) plant(path.join(outside, name), marker);
				process.env.PATH = outside;
				delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
				process.env.PI_LENS_TEST_MODE = "0";
				process.chdir(project.root);
				setProjectTrustState("unknown");

				await installTool(id);

				expect(fs.readFileSync(marker, "utf8")).toContain("install");
			});
			it(`r19 ${id} install refuses project-linked package managers`, async () => {
				const project = makeProject();
				const target = path.join(project.root, "runtime");
				plant(target, project.marker);
				const outside = tempDir("pi-lens-4530-outside-");
				for (const name of commands)
					fs.symlinkSync(target, path.join(outside, name));
				process.env.PATH = outside;
				delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
				process.env.PI_LENS_TEST_MODE = "0";
				process.chdir(project.root);
				setProjectTrustState("unknown");

				await installTool(id);

				expect(project.ran()).toBe("");
			});
		}
	},
);

const RUNTIME_INSTALLS = [
	["go", () => tryGoInstallGopls()],
	["dotnet", () => tryDotnetToolInstall("pi-lens-4530-fixture-tool")],
	["gem", () => tryGemInstall("pi-lens-4530-fixture-gem")],
] as const;

/** An outside runtime that records the directory it ran in, then fails. */
function outsideRuntime(name: string): { dir: string; ranIn: () => string } {
	const dir = tempDir("pi-lens-4530-outside-");
	const marker = path.join(dir, `${name}.cwd`);
	writeScript(
		path.join(dir, name),
		`#!/bin/sh\npwd -P >> ${JSON.stringify(marker)}\nexit 1\n`,
	);
	return {
		dir,
		ranIn: () =>
			fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "",
	};
}

// lane: Linux and macOS unit shards; the fixtures are POSIX shell scripts.
describe.skipIf(process.platform === "win32")(
	"LSP runtime installs honour project trust (#4530)",
	() => {
		for (const [name, install] of RUNTIME_INSTALLS) {
			for (const trust of ["unknown", "untrusted", "trusted"] as const) {
				it(`r19 ${name} install judges a project-linked runtime under ${trust} trust`, async () => {
					// R18-R1: an outside PATH directory can link to project bytes.
					const project = makeProject();
					const target = path.join(project.root, name);
					plant(target, project.marker);
					const outside = tempDir("pi-lens-4530-outside-");
					fs.symlinkSync(target, path.join(outside, name));
					process.env.PATH = [outside, dirOf("sh")].join(path.delimiter);
					process.chdir(project.root);
					setProjectTrustState(trust);

					await install();

					if (trust === "trusted") expect(project.ran()).toContain("install");
					else {
						expect(project.ran()).toBe("");
						expect(trustRows("global-command-target:")).toHaveLength(1);
					}
				});
			}
			it(`runs the ${name} install from outside an untrusted project`, async () => {
				const project = makeProject();
				const direnvBin = path.join(project.root, "bin");
				plant(path.join(direnvBin, name), project.marker);
				const outside = outsideRuntime(name);
				process.env.PATH = [direnvBin, outside.dir, dirOf("sh")].join(
					path.delimiter,
				);
				process.chdir(project.root);
				setProjectTrustState("unknown");

				expect(await install()).toBe(false);

				expect(project.ran()).toBe("");
				const ranIn = outside.ranIn().split("\n");
				expect(ranIn.length).toBeGreaterThan(0);
				for (const dir of ranIn) {
					expect(dir).toBe(fs.realpathSync(os.homedir()));
				}
			});
		}

		it("runs a runtime install in the session project when it is trusted", async () => {
			const project = makeProject();
			const direnvBin = path.join(project.root, "bin");
			plant(path.join(direnvBin, "go"), project.marker);
			process.env.PATH = [direnvBin, dirOf("sh")].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("trusted");

			await tryGoInstallGopls();

			expect(project.ran()).toContain("install");
		});
	},
);

describe("trustScopedPath (#4530)", () => {
	it("keeps HOME's own tool dirs when the session runs at HOME", () => {
		const home = tempDir("pi-lens-4530-home-");
		const homeBin = path.join(home, "bin");
		fs.mkdirSync(homeBin);
		process.env.HOME = home;
		process.chdir(home);
		setProjectTrustState("unknown");

		expect(trustScopedPath(homeBin)).toBe(homeBin);
	});

	it("keeps every entry for a trusted project", () => {
		const project = makeProject();
		const pathValue = [project.bin, "relative", ""].join(path.delimiter);
		process.chdir(project.root);
		setProjectTrustState("trusted");

		expect(trustScopedPath(pathValue)).toBe(pathValue);
	});

	it("drops entries that reach the launch root, not only the session cwd", () => {
		const session = makeProject();
		const other = makeProject();
		const outside = tempDir("pi-lens-4530-outside-");
		const otherBin = path.join(other.root, "bin");
		process.chdir(session.root);
		setProjectTrustState("untrusted");

		expect(
			trustScopedPath(
				[session.bin, otherBin, outside].join(path.delimiter),
				other.root,
			),
		).toBe(outside);
	});
});

describe.skipIf(process.platform === "win32")(
	"round 2 real lookup regressions",
	() => {
		it("resolves symlink identities without dropping outside links", () => {
			const project = makeProject();
			fs.mkdirSync(project.bin, { recursive: true });
			const outside = tempDir("pi-lens-4530-links-");
			const insideLink = path.join(outside, "inside");
			const outsideLink = path.join(outside, "outside");
			fs.symlinkSync(project.bin, insideLink);
			fs.symlinkSync(outside, outsideLink);
			process.chdir(project.root);
			const input = [insideLink, outsideLink].join(path.delimiter);
			setProjectTrustState("untrusted");
			expect(trustScopedPath(input)).toBe(outsideLink);
			expect(trustRows(`project-path-entry:${insideLink}`)).toHaveLength(1);
			setProjectTrustState("trusted");
			expect(trustScopedPath(input)).toBe(input);
		});
		it("defaults availability to scoped PATH while trusted and MCP retain ambient PATH", async () => {
			const project = makeProject();
			plant(path.join(project.bin, FIXTURE_TOOL), project.marker);
			const outside = tempDir("pi-lens-4530-available-");
			plant(path.join(outside, "outside-tool"), project.marker);
			process.env.PATH = [project.bin, outside].join(path.delimiter);
			process.chdir(project.root);
			for (const trust of [
				"trusted",
				"unknown",
				"untrusted",
				"trusted",
			] as const) {
				setProjectTrustState(trust);
				expect(await isCommandAvailable(FIXTURE_TOOL)).toBe(
					trust === "trusted",
				);
				expect(await isSpawnableCommand(FIXTURE_TOOL)).toBe(
					trust === "trusted",
				);
				expect(await isCommandAvailable("outside-tool")).toBe(true);
			}
			expect(await isCommandAvailable(FIXTURE_TOOL, [], project.bin)).toBe(
				true,
			);
		});
	},
);

// lane: Linux/macOS existing real-child fixture lane; every child exits immediately.
describe.skipIf(process.platform === "win32")("round 2 child lookups", () => {
	it("checks LSP runtime availability with a scoped finder", async () => {
		const project = makeProject();
		plant(path.join(project.bin, FIXTURE_TOOL), project.marker);
		plant(path.join(project.bin, "which"), project.marker);
		process.env.PATH = [project.bin, dirOf("which")].join(path.delimiter);
		process.chdir(project.root);
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "0";
		const install = vi.fn(async () => false);
		for (const trust of ["unknown", "trusted"] as const) {
			setProjectTrustState(trust);
			await resolveAndLaunch(
				{
					candidates: [],
					args: [],
					cwd: project.root,
					runtimeInstall: { runtimeCommand: FIXTURE_TOOL, install },
				},
				true,
			);
			expect(install).toHaveBeenCalledTimes(trust === "trusted" ? 1 : 0);
			if (trust === "unknown") expect(project.ran()).toBe("");
		}
	});
	// #4566 round 11: the availability probe answers for the root being served,
	// not `process.cwd()`. An adopted root outside the session kept that root's
	// own PATH entries, so a probe asked about a foreign root reported the
	// project's tool as available. Recurrence guarded: a trust question answered
	// against the wrong root.
	it("scopes LSP runtime availability to the served root, not process.cwd()", async () => {
		const project = makeProject();
		plant(path.join(project.bin, FIXTURE_TOOL), project.marker);
		plant(path.join(project.bin, "which"), project.marker);
		process.env.PATH = [project.bin, dirOf("which")].join(path.delimiter);
		// No chdir: the session stays outside `project.root`, an adopted root.
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "0";
		setProjectTrustState("unknown");
		const install = vi.fn(async () => false);

		await resolveAndLaunch(
			{
				candidates: [],
				args: [],
				cwd: project.root,
				runtimeInstall: { runtimeCommand: FIXTURE_TOOL, install },
			},
			true,
		);

		expect(install).not.toHaveBeenCalled();
		expect(project.ran()).toBe("");
	});
	it("extracts GitHub archives through an outside utility until trusted", async () => {
		const project = makeProject();
		const outside = tempDir("pi-lens-4530-extractor-");
		const outsideMarker = path.join(outside, "ran");
		plant(path.join(project.bin, "tar"), project.marker);
		writeScript(
			path.join(outside, "tar"),
			`#!/bin/sh\necho ran >> ${JSON.stringify(outsideMarker)}\nexit 1\n`,
		);
		const { resolveGitHubAsset } =
			await import("../../clients/installer/index.js");
		const name = `shellcheck-${resolveGitHubAsset("shellcheck", process.platform, process.arch)}`;
		// SAFETY: httpsGet only consumes the response events and request timeout/error methods supplied below.
		vi.spyOn(https, "get").mockImplementation(((
			url: string,
			_opts: unknown,
			callback?: (response: EventEmitter) => void,
		) => {
			const response = Object.assign(new EventEmitter(), {
				statusCode: 200,
				headers: {},
			});
			const req = Object.assign(new EventEmitter(), {
				setTimeout: () => req,
				destroy: () => req,
			});
			queueMicrotask(() => {
				callback?.(response);
				response.emit(
					"data",
					Buffer.from(
						new URL(String(url)).hostname === "api.github.com"
							? JSON.stringify({
									tag_name: "v-fixture",
									assets: [
										{
											name,
											browser_download_url: "https://fixture.invalid/archive",
										},
									],
								})
							: "fixture bytes",
					),
				);
				response.emit("end");
			});
			return req;
		}) as unknown as typeof https.get);
		process.env.PATH = [project.bin, outside].join(path.delimiter);
		process.chdir(project.root);
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "0";
		process.env.PI_LENS_TEST_MODE = "0";
		setProjectTrustState("unknown");
		await ensureTool("shellcheck", { forceReinstall: true });
		expect(project.ran()).toBe("");
		expect(fs.readFileSync(outsideMarker, "utf8")).toContain("ran");
		setProjectTrustState("trusted");
		await ensureTool("shellcheck", { forceReinstall: true });
		expect(project.ran()).toContain("tar");
	});
});

describe.skipIf(process.platform === "win32")(
	"round 2 finder environments",
	() => {
		it("passes scoped environments to boolean and path-returning finders", async () => {
			const project = makeProject();
			plant(path.join(project.bin, FIXTURE_TOOL), project.marker);
			plant(path.join(project.bin, "which"), project.marker);
			process.env.PATH = [project.bin, dirOf("which")].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");
			expect(
				await isCommandAvailableAsync(FIXTURE_TOOL, trustScopedSpawnEnv()),
			).toBe(false);
			expect(
				await findCommandAsync(FIXTURE_TOOL, trustScopedSpawnEnv()),
			).toBeNull();
			expect(project.ran()).toBe("");
			setProjectTrustState("trusted");
			expect(
				await isCommandAvailableAsync(FIXTURE_TOOL, trustScopedSpawnEnv()),
			).toBe(true);
			expect(
				await findCommandAsync(FIXTURE_TOOL, trustScopedSpawnEnv()),
			).not.toBeNull();
		});
		it("scopes the JVM PATH finder before consulting installed JDKs", async () => {
			const project = makeProject();
			plant(path.join(project.bin, "which"), project.marker);
			process.env.PATH = [project.bin, dirOf("which")].join(path.delimiter);
			process.chdir(project.root);
			_resetJvmRuntimeCacheForTests();
			setProjectTrustState("unknown");
			await resolveJavaRuntimeEnv();
			expect(project.ran()).toBe("");
			_resetJvmRuntimeCacheForTests();
			setProjectTrustState("trusted");
			await resolveJavaRuntimeEnv();
			expect(project.ran()).toContain("which");
			_resetJvmRuntimeCacheForTests();
		});
		it("compares a symlinked root using the same filesystem identity as its entries", () => {
			const session = makeProject();
			const project = makeProject();
			const links = tempDir("pi-lens-4530-root-link-");
			const alias = path.join(links, "root");
			fs.symlinkSync(project.root, alias);
			fs.mkdirSync(project.bin, { recursive: true });
			process.chdir(session.root);
			setProjectTrustState("unknown");
			expect(trustScopedPath(project.bin, alias)).toBe("");
		});
	},
);

describe.skipIf(process.platform === "win32")("round 2 compiler lookup", () => {
	it("resolves a discovered bare compiler through the scoped path finder", async () => {
		const project = makeProject();
		const outside = tempDir("pi-lens-4530-compiler-");
		plant(path.join(project.bin, "which"), project.marker);
		writeScript(
			path.join(outside, "typescript-language-server"),
			"#!/bin/sh\necho 5.3.0\n",
		);
		writeScript(path.join(outside, "tsc"), '#!/bin/sh\necho "Version 5.9.3"\n');
		process.env.PATH = [project.bin, outside, dirOf("which")].join(
			path.delimiter,
		);
		process.chdir(project.root);
		setProjectTrustState("unknown");
		expect(
			await TypeScriptServer.spawn(project.root, { allowInstall: false }),
		).toBeUndefined();
		expect(project.ran()).toBe("");
	});
});

// lane: Linux and macOS unit shards; the fixtures are POSIX shell scripts and
// real `which`/`spawn` children.
describe.skipIf(process.platform === "win32")(
	"round 9: scoped PATH, command targets, and the availability latch (#4530)",
	() => {
		it("omits PATH rather than leaving an empty one when every entry is refused", async () => {
			const project = makeProject();
			// F1: cover both empty-PATH cwd search and revival of the refused
			// ambient project.bin during the shared spawn environment merge.
			plant(path.join(project.root, "which"), project.marker);
			plant(path.join(project.bin, "which"), project.marker);
			plant(path.join(project.bin, FIXTURE_TOOL), project.marker);
			process.env.PATH = project.bin;
			process.chdir(project.root);
			setProjectTrustState("unknown");

			expect(trustScopedSpawnEnv()?.PATH).toBeUndefined();

			await findGlobalBinary(FIXTURE_TOOL);

			expect(project.ran()).toBe("");
		});

		it("composes the managed tool PATH without an empty entry", async () => {
			const project = makeProject();
			// Only reachable through the child's cwd, never through a real dir.
			plant(path.join(project.root, FIXTURE_TOOL), project.marker);
			process.env.PATH = project.bin;
			process.chdir(project.root);
			setProjectTrustState("unknown");

			// The composed env is what managed tools and language servers get, so
			// the assertion is on the value itself: a zero-length entry is the
			// child's cwd for the kernel (measured outside this suite — `PATH=""`
			// ran `./pnpm-shim`, a removed PATH did not), and no spawn here would
			// prove more than a second reading of the same string.
			const env = await getToolEnvironment();
			expect((env.PATH ?? "").split(path.delimiter)).not.toContain("");
		});

		it("refuses a global bin link whose target is inside the project", async () => {
			const project = makeProject();
			const prefix = path.join(tempDir("pi-lens-4530-prefix-"), "prefix");
			const planted = plant(
				path.join(project.bin, FIXTURE_TOOL),
				project.marker,
			);
			const link = path.join(prefix, "bin", FIXTURE_TOOL);
			fs.mkdirSync(path.dirname(link), { recursive: true });
			fs.symlinkSync(planted, link);
			process.env.npm_config_prefix = prefix;
			// F2: an adopted root differs from the ambient session cwd.
			setProjectTrustState("unknown");
			expect(
				await findNodeToolBinary(FIXTURE_TOOL, project.root),
			).toBeUndefined();
			const { resolveLocalFirstAsync } =
				await import("../../clients/dispatch/runners/utils/runner-helpers.js");
			expect(
				(await resolveLocalFirstAsync(FIXTURE_TOOL, project.root)).cmd,
			).toBe("npx");
			expect(trustRows("global-command-target:")).toHaveLength(1);

			setProjectTrustState("trusted");
			expect(await findGlobalBinary(FIXTURE_TOOL)).toBe(link);
		});

		it("keeps the POSIX PATH distinct from Path (#4566 G1)", () => {
			const previous = process.env.Path;
			const actualPath = process.env.PATH;
			try {
				delete process.env.PATH;
				process.env.Path = "/old/bin";
				process.env.PATH = "/usr/bin:/bin";
				setProjectTrustState("unknown");
				const env = trustScopedSpawnEnv();
				expect(env?.PATH).toBe("/usr/bin:/bin");
				expect(env?.Path).toBe("/old/bin");
			} finally {
				if (previous === undefined) delete process.env.Path;
				else process.env.Path = previous;
				if (actualPath === undefined) delete process.env.PATH;
				else process.env.PATH = actualPath;
			}
		});

		it("bounds caller-root availability and global-directory evidence (#4566 F2)", async () => {
			const { clearLatencyLog, flushLatencyLog, getLatencyLogPath } =
				await import("../../clients/latency-logger.js");
			process.env.PI_LENS_TEST_MODE = "0";
			clearLatencyLog();
			await flushLatencyLog();
			const outside = tempDir("pi-lens-4530-cache-bound-");
			const queries = path.join(outside, "queries");
			writeScript(
				path.join(outside, "npm"),
				`#!/bin/sh\nprintf x >> ${JSON.stringify(queries)}\nprintf '%s\\n' ${JSON.stringify(outside)}\n`,
			);
			process.env.PATH = [outside, "/usr/bin", "/bin"].join(path.delimiter);
			setProjectTrustState("unknown");
			const roots = Array.from({ length: 9 }, () => makeProject().root);
			for (const root of roots)
				await allAvailableGlobalBinDirs(undefined, root);
			await flushLatencyLog();
			const beforeQueries = fs.readFileSync(queries, "utf8").length;
			const records = () =>
				fs
					.readFileSync(getLatencyLogPath(), "utf8")
					.split("\n")
					.filter(
						(line) =>
							line.includes('"phase":"availability_decision"') &&
							line.includes('"tool":"npm"'),
					).length;
			const beforeRecords = records();
			expect(beforeQueries).toBe(9);
			expect(beforeRecords).toBe(9);
			// Root-bearing keys must not turn the previous eight-key domain
			// into unbounded process state; revisiting an evicted root probes again.
			await allAvailableGlobalBinDirs(undefined, roots[0]);
			await flushLatencyLog();
			expect(fs.readFileSync(queries, "utf8").length).toBe(beforeQueries + 1);
			expect(records()).toBe(beforeRecords + 1);
		});

		it("normalizes the Python environment PATH (#4566 F4)", async () => {
			const { augmentPythonEnvironment } =
				await import("../../clients/python-environment.js");
			const env = augmentPythonEnvironment(
				{ PATH: "/usr/bin:" },
				{
					root: "/venv",
					binDir: "/venv/bin",
					pythonPath: "/venv/bin/python",
					source: "virtual-env",
				},
			);
			expect(env.PATH?.split(path.delimiter)).not.toContain("");
		});

		it("joins a search path without a zero-length entry", () => {
			// Recurrence: a zero-length entry is the child's cwd for the kernel,
			// so a joined value that keeps one re-opens the lookup trust closed.
			expect(normalizeSearchPath(["/a", "", "/b::/c"], ":")).toBe("/a:/b:/c");
			expect(normalizeSearchPath(["/a", ""], ":")).toBe("/a");
			expect(normalizeSearchPath(["", ""], ":")).toBe("");
		});

		it("never composes a managed tool environment with an empty PATH entry", async () => {
			// No directories at all: the pre-#4530-round-9 join emitted a trailing
			// separator, and a child then searched its own cwd.
			process.env.PATH = "";
			setProjectTrustState("trusted");
			const cwd = tempDir("pi-lens-4530-managed-");
			const { getManagedToolEnvironment } =
				await import("../../clients/dispatch/runners/utils/runner-helpers.js");

			const managed = await getManagedToolEnvironment("knip", cwd);
			const entries = (managed.PATH ?? "").split(path.delimiter);
			expect(entries).not.toContain("");
			// The project's bin dir is still FIRST; nothing empty follows it.
			expect(entries[0]).toBe(path.join(cwd, "node_modules", ".bin"));

			const tools = await getToolEnvironment();
			expect((tools.PATH ?? "").split(path.delimiter)).not.toContain("");
		});

		it("re-probes package-manager availability when trust changes mid-session", async () => {
			const project = makeProject();
			// The manager the project declares lives only in the project's own
			// bin dir, so its availability is exactly what trust decides.
			fs.writeFileSync(
				path.join(project.root, "package.json"),
				JSON.stringify({ packageManager: "pnpm@9.0.0" }),
			);
			plant(path.join(project.bin, "pnpm"), project.marker);
			process.env.PATH = [project.bin, savedEnv["PATH"]].join(path.delimiter);
			// F2: judge the adopted root, not process.cwd().
			setProjectTrustState("unknown");
			expect(await resolveNodePackageManager(project.root)).toBe("npm");

			// turn_start re-adopts the host's answer; the old verdict is not it.
			setProjectTrustState("trusted");
			expect(await resolveNodePackageManager(project.root)).toBe("pnpm");
			expect(project.ran()).toBe("");
		});
	},
);

it("isolates availability by the caller root (#4566 F2)", async () => {
	const project = makeProject();
	const other = makeProject();
	for (const root of [project.root, other.root]) {
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ packageManager: "pnpm@9.0.0" }),
		);
	}
	plant(
		path.join(project.bin, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
		project.marker,
	);
	process.env.PATH = [project.bin, savedEnv["PATH"]].join(path.delimiter);
	setProjectTrustState("unknown");
	expect(await resolveNodePackageManager(project.root)).toBe("npm");
	expect(await resolveNodePackageManager(other.root)).toBe("pnpm");
	expect(await resolveNodePackageManager(project.root)).toBe("npm");
});

// R18: the maintainer scopes admission to the executable realpath.
it.each(["unknown", "untrusted", "trusted"] as const)(
	"r18 installer judges linked command realpaths under %s trust",
	async (trust) => {
		const project = makeProject();
		const outside = tempDir("pi-lens-global-");
		const suffix = process.platform === "win32" ? ".cmd" : "";
		const body =
			process.platform === "win32"
				? `@echo off\r\necho ran >> "${project.marker}"\r\necho 1.0.0\r\n`
				: `#!/bin/sh\necho ran >> ${JSON.stringify(project.marker)}\necho 1.0.0\n`;
		const target = writeScript(path.join(project.root, `tool${suffix}`), body);
		const command = path.join(outside, `stylelint${suffix}`);
		fs.symlinkSync(target, command);
		process.env.PATH = outside;
		process.chdir(project.root);
		setProjectTrustState(trust);
		expect(await isCommandAvailable("stylelint")).toBe(trust === "trusted");
		expect(await isSpawnableCommand("stylelint")).toBe(trust === "trusted");
		setProjectTrustState("trusted");
		expect(await isSpawnableCommand("stylelint")).toBe(true);
		setProjectTrustState(trust);
		expect(await verifyToolBinary(command)).toBe(trust === "trusted");
		expect(Boolean(project.ran())).toBe(trust === "trusted");
		const fallback = tempDir("pi-lens-global-");
		const admitted = writeScript(
			path.join(fallback, `stylelint${suffix}`),
			body,
		);
		process.env.PATH = [outside, fallback].join(path.delimiter);
		expect(await getToolPath("stylelint")).toBe(
			trust === "trusted" ? "stylelint" : admitted,
		);
	},
);
it.each(["cmd", "ps1", "sh", "bat", "py"])(
	"r18 outside wrapper admission ignores script content: %s",
	(extension) => {
		const project = makeProject();
		const shim = path.join(tempDir("pi-lens-wrapper-"), `tool.${extension}`);
		fs.writeFileSync(shim, "#!/usr/bin/env python3\nunknown wrapper\n");
		setProjectTrustState("unknown");
		expect(commandResolvesIntoProject(shim, project.root)).toBe(false);
	},
);

// R18-V4: filesystem resolution must precede lexical normalization.
it.runIf(process.platform !== "win32")(
	"r18 judges symlink parent traversal by filesystem resolution",
	() => {
		const project = makeProject();
		const outside = tempDir("pi-lens-global-");
		fs.mkdirSync(path.join(project.root, "sub"));
		fs.writeFileSync(path.join(project.root, "server"), "fixture");
		fs.writeFileSync(path.join(outside, "server"), "decoy");
		fs.symlinkSync(path.join(project.root, "sub"), path.join(outside, "link"));
		setProjectTrustState("unknown");
		expect(
			commandResolvesIntoProject(`${outside}/link/../server`, project.root),
		).toBe(true);
	},
);
it("r18 records an unavailable command realpath", () => {
	const project = makeProject();
	const missing = path.join(tempDir("pi-lens-global-"), "missing");
	setProjectTrustState("unknown");
	expect(commandResolvesIntoProject(missing, project.root)).toBe(true);
	expect(trustRows("global-command-realpath:")).toEqual([
		expect.objectContaining({
			subject: `global-command-realpath:${missing}`,
			reason: "resolved command realpath unavailable",
		}),
	]);
});

// R18-V2: the filesystem acceptance catch publishes its own bounded decision.
it.runIf(process.platform !== "win32")(
	"r18 records executable access refusal once",
	() => {
		const file = path.join(tempDir("pi-lens-global-"), "not-executable");
		fs.writeFileSync(file, "fixture", { mode: 0o644 });
		expect(isAcceptedCommandFile(file)).toBe(false);
		expect(isAcceptedCommandFile(file)).toBe(false);
		expect(
			getDegradationSummary()
				.filter((row) => row.kind === "command-file-not-executable")
				.flatMap((row) => row.latestReasons),
		).toEqual([
			expect.objectContaining({
				subject: file,
				reason: "command file failed executable access check",
			}),
		]);
	},
);

// R18-V3: cached discovery evidence never carries an earlier trust grant.
it.runIf(process.platform !== "win32").each([
	["unknown", "session"],
	["untrusted", "session"],
	["unknown", "disk"],
	["untrusted", "disk"],
] as const)(
	"r18 rejudges %s installer %s cache results",
	async (trust, cache) => {
		const project = makeProject();
		const outside = tempDir("pi-lens-global-");
		const target = plant(path.join(project.root, "stylelint"), project.marker);
		fs.symlinkSync(target, path.join(outside, "stylelint"));
		process.env.PATH = [outside, savedEnv["PATH"]].join(path.delimiter);
		process.chdir(project.root);
		resetResolvedPathCache();
		setProjectTrustState("trusted");
		try {
			expect(await ensureTool("stylelint", { allowInstall: false })).toBe(
				"stylelint",
			);
			if (cache === "disk")
				await updateProbeCache("stylelint", path.join(outside, "stylelint"));
			await flushProbeCache();
			if (cache === "disk") resetResolvedPathCache();
			setProjectTrustState(trust);
			expect(
				await ensureTool("stylelint", { allowInstall: false }),
			).toBeUndefined();
			const fallback = tempDir("pi-lens-global-");
			const admitted = plant(path.join(fallback, "stylelint"), project.marker);
			process.env.PATH = [outside, fallback].join(path.delimiter);
			expect(await ensureTool("stylelint", { allowInstall: false })).toBe(
				admitted,
			);
		} finally {
			resetResolvedPathCache();
		}
	},
);

// ==========================================================================
// Round 20: the spawn chokepoint (#4530 / PR #4566)
//
// Round 19 left four HIGH members green because their caller bound the command
// as a bare name and trusted the PATH it inherited: a lazy `gem install`, the
// two `rustup component add` installs, the Python user-base discovery probe,
// and the pip user-base follow-up after a successful `--user` install. Each
// member is driven through its PRODUCTION entry point below, with the runtime
// reachable only as a link from an outside PATH directory into project bytes —
// the shape that made every earlier round's directory check pass and the
// program still run project code.
// ==========================================================================

/** An outside PATH directory whose `name` is a link to project bytes. */
function linkedIntoProject(
	project: ReturnType<typeof makeProject>,
	name: string,
) {
	const outside = tempDir("pi-lens-4530-linked-");
	const target = writeScript(
		path.join(project.root, `runtime-${name}`),
		`#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(project.marker)}\nexit 0\n`,
	);
	fs.symlinkSync(target, path.join(outside, name));
	return outside;
}

describe.skipIf(process.platform === "win32")(
	"r20 lazy installs judge the runtime they run (#4530)",
	() => {
		beforeEach(() => {
			resetLazyInstallAttempts();
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";
		});
		afterEach(() => {
			resetLazyInstallAttempts();
		});

		const LAZY: Array<{
			label: string;
			runtime: string;
			run: (cwd: string) => Promise<boolean>;
		}> = [
			{
				label: "rubocop gem install",
				runtime: "gem",
				run: (cwd) => tryLazyInstallForFormatter("rubocop", cwd),
			},
			{
				label: "rustfmt rustup install",
				runtime: "rustup",
				run: (cwd) => tryLazyInstallForFormatter("rustfmt", cwd),
			},
			{
				label: "rust-clippy rustup install",
				runtime: "rustup",
				run: (cwd) => tryLazyInstall("rust-clippy", cwd),
			},
		];

		for (const { label, runtime, run } of LAZY) {
			for (const trust of ["unknown", "untrusted"] as const) {
				it(`refuses a project-linked ${label} runtime under ${trust} trust`, async () => {
					const project = makeProject();
					const outside = linkedIntoProject(project, runtime);
					process.env.PATH = [outside, dirOf("sh")].join(path.delimiter);
					process.chdir(project.root);
					setProjectTrustState(trust);

					await run(project.root);

					expect(project.ran()).toBe("");
					// Under `untrusted` the install gate refuses before the spawn, so the
					// chokepoint record belongs to the `unknown` cell: an older host
					// leaves install policy compatible and the seam is the only judgment.
					expect(trustRows("global-command-target:")).toHaveLength(
						trust === "unknown" ? 1 : 0,
					);
				});
			}

			it(`runs an outside ${label} runtime until trusted`, async () => {
				const project = makeProject();
				const outside = tempDir("pi-lens-4530-lazy-");
				const marker = path.join(outside, "ran");
				writeScript(
					path.join(outside, runtime),
					`#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\nexit 0\n`,
				);
				process.env.PATH = [outside, dirOf("sh")].join(path.delimiter);
				process.chdir(project.root);
				setProjectTrustState("unknown");

				await run(project.root);

				expect(fs.readFileSync(marker, "utf8")).toContain(runtime);
				expect(project.ran()).toBe("");
			});
		}
	},
);

describe.skipIf(process.platform === "win32")(
	"r20 interpreter user-base discovery judges the interpreter (#4530)",
	() => {
		it("never runs a project-linked interpreter to discover the user base", async () => {
			const project = makeProject();
			const outside = linkedIntoProject(project, "python3");
			fs.symlinkSync(
				path.join(project.root, "runtime-python3"),
				path.join(outside, "python"),
			);
			process.env.PATH = [outside, dirOf("sh")].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await getToolPath("black");

			expect(project.ran()).toBe("");
		});

		it("still reads an outside interpreter's user base", async () => {
			const project = makeProject();
			const outside = tempDir("pi-lens-4530-userbase-");
			const marker = path.join(outside, "ran");
			const userBase = path.join(outside, "userbase");
			writeScript(
				path.join(outside, "python3"),
				`#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\necho ${JSON.stringify(userBase)}\n`,
			);
			process.env.PATH = [outside, dirOf("sh")].join(path.delimiter);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			await getToolPath("black");

			expect(fs.readFileSync(marker, "utf8")).toContain("--user-base");
			expect(project.ran()).toBe("");
		});
	},
);

describe.skipIf(process.platform === "win32")(
	"r20 pip user-base follow-up judges the interpreter (#4530)",
	() => {
		it("never runs a project-linked pip for the post-install user-base probe", async () => {
			// The rung the run loop picks is the OUTSIDE pip3 (it succeeds), so the
			// follow-up's bare-name spawn is the one that could reach project bytes
			// through the ambient PATH — which is exactly what it used to do.
			const project = makeProject();
			const outside = tempDir("pi-lens-4530-pip-");
			writeScript(path.join(outside, "pip3"), "#!/bin/sh\nexit 0\n");
			plant(path.join(project.bin, "pip3"), project.marker);
			process.env.PATH = [project.bin, outside, dirOf("sh")].join(
				path.delimiter,
			);
			process.chdir(project.root);
			setProjectTrustState("unknown");
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";

			await installTool("mypy");

			expect(project.ran()).toBe("");
		});

		it("runs a trusted project's pip follow-up probe", async () => {
			const project = makeProject();
			const outside = tempDir("pi-lens-4530-pip-trusted-");
			writeScript(path.join(outside, "pip3"), "#!/bin/sh\nexit 0\n");
			plant(path.join(project.bin, "pip3"), project.marker);
			process.env.PATH = [project.bin, outside, dirOf("sh")].join(
				path.delimiter,
			);
			process.chdir(project.root);
			setProjectTrustState("trusted");
			delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
			process.env.PI_LENS_TEST_MODE = "0";

			await installTool("mypy");

			expect(project.ran()).toContain("--user-base");
		});
	},
);

// ==========================================================================
// Round 21: the admission judges a LOOKUP, not a file the caller named
// (#4530 / PR #4566)
//
// #4530's acceptance covers "global binary and package-manager lookups": the
// environment's search is where a project substitutes its own bytes for a
// system tool (PATH shadowing, an npm `prefix` redirect, a global bin dir that
// holds a link into the tree). A caller that SPELLS a path has already chosen
// that file, and refusing it refused the project toolchain runs pi-lens makes
// on purpose: the stryker driver probes a project's tests through its own
// `.bin` path, and round 20's admission turned that probe off
// (`tests/scripts/stryker-diff.test.ts`, two cases, branch-caused).
// ==========================================================================

describe.skipIf(process.platform === "win32")(
	"r21 the admission judges a lookup, not a named file (#4530)",
	() => {
		it("admits a named project binary and refuses the same bytes as a lookup", () => {
			const project = makeProject();
			const planted = plant(path.join(project.bin, "vitest"), project.marker);
			process.chdir(project.root);
			setProjectTrustState("unknown");

			// The driver's own shape: a relative path the kernel resolves against the
			// child's cwd, naming the project's binary deliberately.
			expect(admitSpawnExecutable("node_modules/.bin/vitest")).toEqual({
				admitted: true,
			});
			// A path spelling that a PATH walk would ALSO find stays admitted: the
			// rule is about who chose the bytes, not only about what the walk returns
			// (the mutation that judges every spelling refuses this one).
			expect(
				admitSpawnExecutable("node_modules/.bin/vitest", {
					env: { PATH: project.root },
				}),
			).toEqual({ admitted: true });
			// The same bytes as a bare name: the environment chose them.
			expect(
				admitSpawnExecutable("vitest", { env: { PATH: project.bin } }),
			).toMatchObject({ admitted: false, executable: planted });
			expect(trustRows("global-command-target:")).toHaveLength(1);
		});
	},
);
