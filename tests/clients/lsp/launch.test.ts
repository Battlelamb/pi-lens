import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	removeTempDirSync,
	setupTestEnvironment,
	useTrackedTempDirs,
} from "../test-utils.js";

// These launch tests use fake timers and don't exercise Windows Ruby drive-root
// discovery. Stub the #1137 drive-root readers so `buildAugmentedPath`'s async
// `fs.promises.readdir("C:\\")` (real threadpool I/O, not fake-timer driven)
// can't stall the spawn sequence under `vi.useFakeTimers()`. Ruby-dir behavior
// is covered by tests/clients/lsp/ruby-drive-dirs.test.ts.
vi.mock("../../../clients/lsp/ruby-drive-dirs.js", () => ({
	getRubyVersionDirNamesSync: () => [],
	getRubyVersionDirNamesAsync: async () => [],
}));

// Single parameterized fake for the six near-identical `MockChildProcess`
// classes this file used to declare inline, one per `vi.doMock("node:child_
// process", ...)` factory. `vi.doMock` (unlike `vi.mock`) isn't hoisted, so
// its factory can close over a module-scope class like this one.
class MockStream extends EventEmitter {}
class MockChildProcess extends EventEmitter {
	stdin = new MockStream();
	stdout = new MockStream();
	stderr = new MockStream();
	exitCode: number | null = null;
	killed = false;
	constructor(public pid: number) {
		super();
	}
}

/**
 * Build the mocked `spawn`. A fire-and-forget PROBE (`stdio[0]` is "ignore":
 * `clients/process-snapshot.ts`'s process-table query) must settle itself.
 * Its real seam arms a 2 s timeout and then TREE-KILLS a child that never
 * closes, so a fabricated pid left open here was signalled by the resource
 * sampler at file teardown and the #2042 kill guard failed the file at shuffle
 * seed 202 (`kill of unowned pid -9876`, R14-V3). The launch child keeps the
 * old never-closing shape, which is what the launch assertions expect.
 */
function mockSpawn(
	create: (
		command: string,
		args: string[],
		options?: { stdio?: unknown },
	) => MockChildProcess,
) {
	return (command: string, args: string[], options?: { stdio?: unknown }) => {
		const proc = create(command, args, options);
		if (Array.isArray(options?.stdio) && options.stdio[0] === "ignore")
			queueMicrotask(() => proc.emit("close", 0, null));
		return proc;
	};
}

describe("lsp launch", () => {
	afterEach(() => {
		vi.useRealTimers();
		// resetModules does not clear the mock registry (#2883).
		vi.doUnmock("node:child_process");
		vi.resetModules();
		vi.clearAllMocks();
	});
	// Spawns are mocked, so nothing but this file owns the fixture roots.
	useTrackedTempDirs("pi-lens-shim-", "pi-lens-ps1-", "pi-lens-launch-");

	it.runIf(process.platform !== "win32")(
		"spawns LSP servers in their own process group on POSIX",
		async () => {
			const spawnMock = vi.fn(mockSpawn(() => new MockChildProcess(2468)));

			vi.doMock("node:child_process", () => ({
				execFileSync: vi.fn(() => ""),
				spawn: spawnMock,
			}));

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			await launchLSP("vscode-html-language-server", ["--stdio"], {
				cwd: "/tmp/project",
			});

			expect(spawnMock).toHaveBeenCalledWith(
				"vscode-html-language-server",
				["--stdio"],
				expect.objectContaining({ detached: true }),
			);
		},
	);

	it("isolates concurrent adopted and owned launch permission (#4299 R2-F1)", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-launch-scope-"),
		);
		const command = path.join(root, "node_modules", ".bin", "language-server");
		fs.mkdirSync(path.dirname(command), { recursive: true });
		fs.writeFileSync(command, "");
		const spawnMock = vi.fn(mockSpawn(() => new MockChildProcess(2468)));
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: spawnMock,
		}));
		const { launchLSP, withLspProjectCodePermission } =
			await import("../../../clients/lsp/launch.js");
		const { setProjectTrustState, resetProjectTrust } =
			await import("../../../clients/project-trust.js");
		setProjectTrustState("trusted");
		try {
			// Both continuations resume after the other scope has been installed;
			// a process-global flag borrows the owned permission and executes twice.
			const launch = () =>
				Promise.resolve().then(() => launchLSP(command, [], { cwd: root }));
			const results = await Promise.allSettled([
				withLspProjectCodePermission(false, launch),
				withLspProjectCodePermission(true, launch),
			]);
			expect(results[0].status).toBe("rejected");
			expect(results[1].status).toBe("fulfilled");
			expect(spawnMock).toHaveBeenCalledTimes(1);
			// Outside any scope there is no root permission, so a project-local
			// launcher is refused even under trusted trust (#4296 R3-F1).
			await expect(launch()).rejects.toThrow();
			expect(spawnMock).toHaveBeenCalledTimes(1);
		} finally {
			resetProjectTrust();
			removeTempDirSync(root);
		}
	});
	it("redacts secrets in crash-adjacent session-start writes", async () => {
		// #4566 r14: CI shard 2 leaked `pi-lens-launch-log-*` from this fixture.
		// A raw `mkdtempSync` root is only swept when a sample saw it absent, and
		// this test doubles both log-dir resolvers, so a queued writer that
		// recreates the root between the test's removal and the next sample leaves
		// it for the hygiene owner. A `registered` root (`setupTestEnvironment`) is
		// removed whenever it still exists at file teardown and on SIGTERM, and this
		// file's `useTrackedTempDirs("pi-lens-launch-")` afterEach drains the known
		// writers and removes every matching root again over three ticks.
		const fixture = setupTestEnvironment("pi-lens-launch-log-");
		const tempDir = fixture.tmpDir;
		const token = `ghp_${"a".repeat(36)}`;
		const command = path.join(
			tempDir,
			process.platform === "win32" ? "server.exe" : "server",
		);

		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(mockSpawn(() => new MockChildProcess(8642))),
		}));
		vi.doMock("../../../clients/env-utils.js", () => ({
			isTestMode: () => false,
		}));
		vi.doMock("../../../clients/file-utils.js", () => ({
			getGlobalPiLensDir: () => tempDir,
		}));
		// #2506: sessionstart.log resolves through the LOG dir, so the double
		// must move that too — the assertion below reads
		// `<tempDir>/sessionstart.log`, which is only where launch.ts writes if
		// this resolver points at tempDir as well. #2516 round 2 moved the log
		// resolver off `file-utils.ts` onto the cycle-free `probe-home-state.ts`
		// leaf, so this doubles THAT module; doubling file-utils.js alone leaves
		// launch.ts writing to the real (vitest-pinned) log root.
		vi.doMock("../../../clients/probe-home-state.js", () => ({
			getGlobalPiLensLogDir: () => tempDir,
		}));

		try {
			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			await launchLSP(command, [token], {
				cwd: tempDir,
				startupFailureWindowMs: 1,
			});

			// No drain needed (#4381 sweep): launch.ts keeps its own
			// `logSessionStart`, which writes with `fs.appendFileSync`, so the
			// line is on disk before `launchLSP` returns.
			const log = fs.readFileSync(
				path.join(tempDir, "sessionstart.log"),
				"utf8",
			);
			expect(log).not.toContain(token);
			expect(log).toContain("[REDACTED:github-token]");
		} finally {
			vi.doUnmock("../../../clients/env-utils.js");
			vi.doUnmock("../../../clients/file-utils.js");
			vi.doUnmock("../../../clients/probe-home-state.js");
			// Keeps the root tracked so the harness sweep still owns it.
			fixture.cleanup();
		}
	});

	it("leaves probe-home-state.js un-truncated for later cases in this file", async () => {
		// Regression for the previous test's `vi.doMock("../../../clients/
		// probe-home-state.js", ...)` double, which stubbed only
		// `getGlobalPiLensLogDir`. `vi.resetModules()` in `afterEach` clears the
		// real-module cache but NOT the doMock registry, so a missing
		// `vi.doUnmock` for that module leaves every later dynamic import of it
		// (direct, or transitive through degradation-ledger.js) seeing the
		// truncated fake instead of the real module.
		const probeHomeState = await import("../../../clients/probe-home-state.js");
		expect(typeof probeHomeState.getProbeHomeRedirectEvent).toBe("function");
		expect(typeof probeHomeState.getProbeHomeResolution).toBe("function");
	});

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"treats delayed shell-backed startup failure as launch failure",
		async () => {
			vi.useFakeTimers();

			vi.doMock("node:child_process", () => {
				return {
					execFileSync: vi.fn(() => ""),
					spawn: vi.fn(() => {
						const proc = new MockChildProcess(4321);
						setTimeout(() => {
							proc.exitCode = 1;
							proc.emit("exit", 1, null);
							proc.emit("close", 1, null);
						}, 120);
						return proc;
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP(
				"C:\\fake\\bash-language-server.cmd",
				["start"],
				{
					cwd: "C:\\fake",
				},
			);
			const rejection = expect(launchPromise).rejects.toThrow(
				/exited immediately with code 1/i,
			);

			await vi.advanceTimersByTimeAsync(150);

			await rejection;
		},
	);

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"resolves bare commands through where before spawning",
		async () => {
			const tempDir = setupTestEnvironment("pi-lens-launch-").tmpDir;
			const resolvedBinary = path.join(tempDir, "taplo.exe");
			fs.writeFileSync(resolvedBinary, "");
			vi.doMock("node:child_process", () => {
				return {
					execFileSync: vi.fn((command: string, args: string[]) => {
						if (command === "where" && args[0] === "taplo") {
							return `${resolvedBinary}\r\n`;
						}
						return "";
					}),
					spawn: vi.fn(mockSpawn(() => new MockChildProcess(9876))),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launched = await launchLSP("taplo", ["lsp", "stdio"], {
				cwd: "C:\\fake",
			});

			expect(launched.pid).toBe(9876);
		},
	);

	it.each(["unknown", "untrusted", "trusted"] as const)(
		"classifies targets independently of %s trust (#4566 r13)",
		async (trust) => {
			// #4566: outside spellings and npm shims must obey root ownership too.
			// #4566 r14: the project-path input is defence in depth. Under unknown
			// or untrusted trust the scoped PATH drops that entry before the finder
			// runs, so the launch route reports tool-not-found and the classifier
			// never sees a project path; this cell pins the classifier itself.
			const dir = setupTestEnvironment("pi-lens-launch-").tmpDir;
			const root = path.join(dir, "project");
			fs.mkdirSync(root);
			const script = path.join(root, "cli.js");
			fs.writeFileSync(script, "");
			const direct = path.join(root, "node_modules", ".bin", "direct.exe");
			fs.mkdirSync(path.dirname(direct), { recursive: true });
			fs.writeFileSync(direct, "", { mode: 0o755 });
			const link = path.join(dir, "link.exe");
			fs.symlinkSync(direct, link);
			const venv = path.join(root, ".venv", "bin", "server.exe");
			fs.mkdirSync(path.dirname(venv), { recursive: true });
			fs.writeFileSync(venv, "", { mode: 0o755 });
			const venvLink = path.join(dir, "venv.exe");
			fs.symlinkSync(venv, venvLink);
			const cmd = path.join(dir, "shim.cmd");
			const ps1 = path.join(dir, "shim.ps1");
			fs.writeFileSync(cmd, '@"%dp0%/project/cli.js"', { mode: 0o755 });
			fs.writeFileSync(ps1, '"$basedir/project/cli.js"', { mode: 0o755 });
			const global = path.join(dir, "global.exe");
			fs.writeFileSync(global, "", { mode: 0o755 });
			let selected = direct;
			const spawn = vi.fn(
				mockSpawn(
					(_command: string, _args: string[]) => new MockChildProcess(9876),
				),
			);
			vi.doMock("node:child_process", () => ({
				execFileSync: vi.fn(() => selected),
				spawn,
			}));
			const { launchLSP, withLspProjectCodePermission } =
				await import("../../../clients/lsp/launch.js");
			const { setProjectTrustState, resetProjectTrust } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState(trust);
			try {
				for (const allowed of [false, true]) {
					for (const target of [direct, link, venvLink, cmd, ps1, global]) {
						selected = target;
						spawn.mockClear();
						const call = withLspProjectCodePermission(allowed, () =>
							launchLSP("r13-server", [], { cwd: root }),
						);
						if (target === global || (trust === "trusted" && allowed)) {
							await expect(
								call,
								`${trust}/${allowed}/${target}`,
							).resolves.toHaveProperty("pid", 9876);
						} else {
							await expect(
								call,
								`${trust}/${allowed}/${target}`,
							).rejects.toMatchObject({ kind: "trust-refused" });
						}
					}
				}
			} finally {
				resetProjectTrust();
			}
		},
	);

	// #4566 r14 (Greptile r4303887682): an npm `cmd` shim may name an
	// extensionless launcher script. R17 retains that admission through complete
	// upstream captures; the target still decides for an adopted root.
	it.each(["unknown", "trusted"] as const)(
		"spawns a global npm shim whose target is an extensionless script under %s trust (#4566 r14)",
		async (trust) => {
			const dir = setupTestEnvironment("pi-lens-launch-").tmpDir;
			const root = path.join(dir, "project");
			fs.mkdirSync(root);
			const globalDir = path.join(dir, "global");
			const target = path.join(
				globalDir,
				"yaml-language-server",
				"bin",
				"yaml-language-server",
			);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
			const shim = path.join(globalDir, "yaml-language-server.cmd");
			// R17: use complete upstream bytes; the target must actually exist.
			fs.writeFileSync(
				shim,
				fs
					.readFileSync(
						path.resolve("tests/fixtures/global-command-wrappers/npm-node.cmd"),
						"utf8",
					)
					.replaceAll(
						"__TARGET__",
						"yaml-language-server\\bin\\yaml-language-server",
					),
				{ mode: 0o755 },
			);
			const spawn = vi.fn(
				mockSpawn(
					(_command: string, _args: string[]) => new MockChildProcess(9876),
				),
			);
			vi.doMock("node:child_process", () => ({
				execFileSync: vi.fn(() => shim),
				spawn,
			}));
			const { launchLSP, withLspProjectCodePermission } =
				await import("../../../clients/lsp/launch.js");
			const { setProjectTrustState, resetProjectTrust } =
				await import("../../../clients/project-trust.js");
			setProjectTrustState(trust);
			try {
				const launched = await withLspProjectCodePermission(false, () =>
					launchLSP("yaml-language-server", [], { cwd: root }),
				);
				expect(launched.pid).toBe(9876);
				// R14-V1: on win32 a `.cmd` goes through `computeNeedsShell`, so
				// the launcher's own `spawn` receives the QUOTED command string
				// `"<shim>" ` — quoted with a TRAILING SPACE, so trim before
				// unwrapping the quotes — with `shell: true`. Other probe spawns
				// share this mock, so the launcher call is the one naming the shim,
				// not call[0] (GH 117502987225 measured that).
				const launchCall = spawn.mock.calls.find(
					([command]) => command.trim().replace(/^"(.*)"$/, "$1") === shim,
				);
				expect(launchCall, "the shim is what was spawned").toBeDefined();
				expect(launchCall?.[2]).toMatchObject(
					process.platform === "win32" ? { shell: true } : {},
				);
			} finally {
				resetProjectTrust();
			}
		},
	);

	it("refuses a global npm shim whose extensionless target is the project's script (#4566 r14)", async () => {
		const dir = setupTestEnvironment("pi-lens-launch-").tmpDir;
		const root = path.join(dir, "project");
		const target = path.join(root, "bin", "yaml-language-server");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
		const globalDir = path.join(dir, "global");
		fs.mkdirSync(globalDir);
		const shim = path.join(globalDir, "yaml-language-server.cmd");
		fs.writeFileSync(
			shim,
			'endLocal & "%_prog%"  "%dp0%\\..\\project\\bin\\yaml-language-server" %*',
			{ mode: 0o755 },
		);
		const spawn = vi.fn(
			mockSpawn(
				(_command: string, _args: string[]) => new MockChildProcess(9876),
			),
		);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => shim),
			spawn,
		}));
		const { launchLSP, withLspProjectCodePermission } =
			await import("../../../clients/lsp/launch.js");
		const { setProjectTrustState, resetProjectTrust } =
			await import("../../../clients/project-trust.js");
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../clients/degradation-ledger.js");
		setProjectTrustState("unknown");
		resetDegradationLedger();
		try {
			await expect(
				withLspProjectCodePermission(false, () =>
					launchLSP("yaml-language-server", [], { cwd: root }),
				),
			).rejects.toMatchObject({ kind: "trust-refused" });
			expect(spawn.mock.calls.map(([command]) => command)).not.toContain(shim);
			expect(
				getDegradationSummary()
					.filter((row) => row.kind === "lsp-registry-decision")
					.flatMap((row) => row.latestReasons),
			).toEqual([
				expect.objectContaining({
					subject: expect.stringContaining("project-local-binary:"),
				}),
			]);
		} finally {
			resetProjectTrust();
		}
	});

	// #4566 r14 R14-V3: a probe-shaped fake child (stdin "ignore") used to stay
	// open, so the seam's own 2 s timeout tree-killed a pid this process does
	// not own and the #2042 kill guard failed the file at shuffle seed 202
	// (`kill of unowned pid -9876`). `mockSpawn` settles such a fake; this cell
	// pins the settle through the production seam that tree-kills it.
	it("settles a probe-shaped child so its timeout never signals a fake pid (#4566 r14)", async () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => ""),
			spawn: vi.fn(mockSpawn(() => new MockChildProcess(9876))),
		}));
		try {
			const { queryProcessTable } =
				await import("../../../clients/process-snapshot.js");
			const { terminateScannerChild } =
				await import("../../../clients/instance-reaper.js");
			const result = await queryProcessTable(
				{ fields: ["pid"] },
				{
					timeoutMs: 20,
					onTimeout: (child) =>
						terminateScannerChild(child, {
							kind: "resource-sampler-scanner-escalated",
							timeoutMs: 20,
						}),
				},
			);
			expect(kill.mock.calls).toEqual([]);
			expect(result.status).toBe("ok");
		} finally {
			kill.mockRestore();
		}
	});

	// #4530 r7: finder output is evidence, not command-file acceptance.
	it("skips a directory returned by the command finder", async () => {
		const dir = setupTestEnvironment("pi-lens-launch-").tmpDir;
		const invalid = path.join(dir, "directory");
		// Windows shell-wraps an extensionless command (`computeNeedsShell`), so a
		// spawn there receives a quoted command string instead of the path. The
		// fixture carries a PATHEXT executable suffix so the assertion below
		// observes the selected path itself. `.cmd` would enter the script-target
		// check instead, and its target cannot be parsed under unknown trust.
		const valid = path.join(
			dir,
			process.platform === "win32" ? "valid.exe" : "valid",
		);
		fs.mkdirSync(invalid);
		fs.writeFileSync(valid, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), {
			mode: 0o755,
		});
		const spawnMock = vi.fn(
			mockSpawn(
				(_command: string, _args: string[]) => new MockChildProcess(9876),
			),
		);
		vi.doMock("node:child_process", () => ({
			execFileSync: vi.fn(() => `${invalid}\n${valid}\n`),
			spawn: spawnMock,
		}));
		const { launchLSP } = await import("../../../clients/lsp/launch.js");
		// #4566 F1: finder acceptance is exercised outside the untrusted project.
		const project = path.join(dir, "project");
		fs.mkdirSync(project);
		await launchLSP("fixture-server", [], { cwd: project });
		expect(spawnMock.mock.calls.map(([command]) => command)).toContain(valid);
		expect(spawnMock.mock.calls.map(([command]) => command)).not.toContain(
			invalid,
		);
	});

	// #4530 r7: npm PS1 bypasses may select only files; scripts need no X_OK.
	it.each(["cmd-directory", "script-directory", "script-file"])(
		"validates PS1 bypass targets: %s",
		async (kind) => {
			const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
			Object.defineProperty(process, "platform", { value: "win32" });
			try {
				vi.resetModules();
				const dir = setupTestEnvironment("pi-lens-ps1-").tmpDir;
				const ps1 = path.join(dir, "bin", "test.ps1");
				const cmd = path.join(dir, "bin", "test.cmd");
				const script = path.join(dir, "pkg", "cli.js");
				fs.mkdirSync(path.dirname(ps1), { recursive: true });
				fs.mkdirSync(path.dirname(script), { recursive: true });
				fs.writeFileSync(ps1, '"$basedir/../pkg/cli.js"');
				if (kind === "script-directory") fs.mkdirSync(script);
				else fs.writeFileSync(script, "fixture", { mode: 0o644 });
				if (kind === "cmd-directory") fs.mkdirSync(cmd);
				const spawnMock = vi.fn(
					mockSpawn(
						(_command: string, _args: string[], _options: unknown) =>
							new MockChildProcess(5678),
					),
				);
				vi.doMock("node:child_process", () => ({
					execFileSync: vi.fn(() => ""),
					spawn: spawnMock,
				}));
				const { launchLSP } = await import("../../../clients/lsp/launch.js");
				await launchLSP(ps1, ["start"], { cwd: dir });
				const commands = spawnMock.mock.calls.map(([command]) => command);
				expect(commands).not.toContain(cmd);
				if (kind === "script-directory")
					expect(commands).not.toContain(process.execPath);
				else
					expect(spawnMock.mock.calls).toContainEqual([
						process.execPath,
						[script, "start"],
						expect.anything(),
					]);
			} finally {
				Object.defineProperty(process, "platform", descriptor);
			}
		},
	);

	describe("isCmdShimValid", () => {
		it("returns true when the shim target exists", async () => {
			const dir = setupTestEnvironment("pi-lens-shim-").tmpDir;
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			const target = path.join(shimDir, "..", "pkg", "bin", "cli.js");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(true);
		});

		it("returns false when the shim target is missing", async () => {
			const dir = setupTestEnvironment("pi-lens-shim-").tmpDir;
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(false);
		});

		it("returns true for non-npm shims", async () => {
			const dir = setupTestEnvironment("pi-lens-shim-").tmpDir;
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			fs.writeFileSync(shim, `@echo off\necho hello`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(true);
		});

		it("returns true when the file cannot be read", async () => {
			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(
				isCmdShimValid(path.join(os.tmpdir(), "nonexistent-shim.cmd")),
			).toBe(true);
		});

		it("handles .mjs targets", async () => {
			const dir = setupTestEnvironment("pi-lens-shim-").tmpDir;
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			const target = path.join(shimDir, "..", "pkg", "bin", "cli.mjs");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.mjs" %*`);

			const { isCmdShimValid } = await import("../../../clients/lsp/launch.js");
			expect(isCmdShimValid(shim)).toBe(true);
		});
	});

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"rejects immediately for an invalid .cmd shim without spawning",
		async () => {
			const dir = setupTestEnvironment("pi-lens-shim-").tmpDir;
			const shimDir = path.join(dir, "bin");
			fs.mkdirSync(shimDir, { recursive: true });
			const shim = path.join(shimDir, "test.cmd");
			fs.writeFileSync(shim, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			const spawnSpy = vi.fn(() => {
				throw new Error("spawn should not be called");
			});
			vi.doMock("node:child_process", () => {
				return {
					execFileSync: vi.fn(() => ""),
					spawn: spawnSpy,
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			await expect(launchLSP(shim, ["start"], { cwd: dir })).rejects.toThrow(
				/LSP \.cmd shim target not found/i,
			);
			expect(spawnSpy).not.toHaveBeenCalled();
		},
	);

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"bypasses .ps1 to .cmd sibling on Windows",
		async () => {
			vi.useFakeTimers();
			const dir = setupTestEnvironment("pi-lens-ps1-").tmpDir;
			const ps1 = path.join(dir, "test.ps1");
			const cmd = path.join(dir, "test.cmd");
			fs.writeFileSync(ps1, `"$basedir/../pkg/bin/cli.js" "$@"`);
			fs.writeFileSync(cmd, `@"%~dp0\\..\\pkg\\bin\\cli.js" %*`);

			let spawnedCommand: string | undefined;
			vi.doMock("node:child_process", () => {
				return {
					execFileSync: vi.fn(() => ""),
					spawn: vi.fn((command: string) => {
						spawnedCommand = command;
						return new MockChildProcess(1234);
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP(ps1, ["start"], { cwd: dir });
			await vi.advanceTimersByTimeAsync(600);
			const result = await launchPromise;

			expect(spawnedCommand).toContain("test.cmd");
			expect(result.pid).toBe(1234);
		},
	);

	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"bypasses .ps1 to direct node execution when .cmd sibling is missing",
		async () => {
			vi.useFakeTimers();
			const dir = setupTestEnvironment("pi-lens-ps1-").tmpDir;
			// The wrapper resolves `$basedir/../pkg/bin/cli.js`: keep both under the
			// fixture root. `path.join(dir, "..", "pkg")` put the package directly in
			// the shared tmpdir, outside the root `useTrackedTempDirs` removes, so it
			// outlived the file (#4019).
			const ps1 = path.join(dir, "bin", "test.ps1");
			const jsTarget = path.join(dir, "pkg", "bin", "cli.js");
			fs.mkdirSync(path.dirname(ps1), { recursive: true });
			fs.mkdirSync(path.dirname(jsTarget), { recursive: true });
			fs.writeFileSync(jsTarget, "console.log('hello')");
			fs.writeFileSync(ps1, `"$basedir/../pkg/bin/cli.js" "$@"`);

			let spawnedCommand: string | undefined;
			let spawnedArgs: string[] | undefined;
			vi.doMock("node:child_process", () => {
				return {
					execFileSync: vi.fn(() => ""),
					spawn: vi.fn((command: string, args: string[]) => {
						spawnedCommand = command;
						spawnedArgs = args;
						return new MockChildProcess(5678);
					}),
				};
			});

			const { launchLSP } = await import("../../../clients/lsp/launch.js");
			const launchPromise = launchLSP(ps1, ["start"], { cwd: dir });
			await vi.advanceTimersByTimeAsync(100);
			const result = await launchPromise;

			expect(spawnedCommand).toBe(process.execPath);
			expect(spawnedArgs).toContain(jsTarget);
			expect(spawnedArgs).toContain("start");
			expect(result.pid).toBe(5678);
		},
	);
});
