/**
 * Project reach: the one classifier for "would this command run project-owned
 * bytes?" (#4515, #4530).
 *
 * Three questions share this classifier, and until round 20 they lived inside
 * `clients/package-manager.ts`, which the spawn seam cannot import
 * (`package-manager` spawns through `safe-spawn`, so the reverse edge is a
 * cycle). The owner is here instead: it depends only on `path-utils` and
 * `project-trust`, so both `package-manager` (PATH scoping, global-bin walks)
 * and `safe-spawn` (the admission chokepoint) ask the same rule.
 *
 * The rule's shape, and why each part exists:
 *
 * - A PATH entry or global bin dir reaches the project when it IS a
 *   project-local bin layout (node_modules/.bin, vendor/bin, a venv) of `cwd`
 *   or an ancestor, lies at or under `cwd`, or is relative (a relative entry
 *   follows each spawn's cwd; on POSIX an empty entry is the cwd).
 * - A HOME-or-above `cwd` is no project — the ceiling the project-local walk
 *   already stops at — so HOME's own tool dirs stay usable there.
 * - A RESOLVED command is judged by its real target, not by the directory that
 *   names it: a global bin dir outside the project can hold a link into it (an
 *   npm-linked language server is the ordinary case), and the resolver follows
 *   that link when it spawns. The target is what runs, so the target is what
 *   the trust gate judges.
 *
 * Round 19 ran 19 rounds of per-caller guards before this moved here. The
 * maintainer's redesign (2026-10-19) put the judgment at the spawn chokepoint,
 * so a new caller cannot skip it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isAtOrAboveHomeDir,
	isUnderCanonicalDir,
	isUnderDir,
	normalizeFilePath,
	realpathOrResolve,
	walkUpDirs,
} from "./path-utils.js";
import { getProjectTrustState } from "./project-trust.js";
import { recordDegradationOnce } from "./degradation-ledger.js";

/**
 * The project-local bin-directory shapes in this repo, most-preferred first.
 * Exported so every caller passes the SAME constant instead of re-listing the
 * directory names next to its own copy of the walk — the venv list alone had
 * three independent spellings before #2544 review F1 (`formatters.ts`,
 * `runner-helpers.ts`'s `createVenvFinder`, `dead-code-client.ts`'s
 * `venvCandidates`).
 *
 * `VENV_BIN_DIRS` lists BOTH the POSIX (`bin`) and Windows (`Scripts`) layouts
 * unconditionally rather than branching on `process.platform` at module load:
 * a module-load platform constant cannot be forced per test, so the other
 * branch is never exercised on the ubuntu lane (defect shape 30). The extra
 * two `existsSync` calls per directory are the price of a testable list, and
 * a `.venv/Scripts` on Linux (or `.venv/bin` under msys) resolves correctly
 * instead of being invisible.
 */
export const NODE_MODULES_BIN_DIRS: readonly string[] = [
	path.join("node_modules", ".bin"),
];
export const VENDOR_BIN_DIRS: readonly string[] = [path.join("vendor", "bin")];
export const VENV_BIN_DIRS: readonly string[] = [
	path.join(".venv", "bin"),
	path.join("venv", "bin"),
	path.join(".venv", "Scripts"),
	path.join("venv", "Scripts"),
];

/** Every project-local bin layout supported by the canonical resolver above. */
export const PROJECT_LOCAL_BIN_DIRS: readonly string[] = [
	...NODE_MODULES_BIN_DIRS,
	...VENDOR_BIN_DIRS,
	...VENV_BIN_DIRS,
];

/** Every project-local bin dir of `cwd` and its ancestors below HOME. */
export function* projectLocalBinDirs(cwd: string): Generator<string> {
	for (const ancestor of walkUpDirs(cwd)) {
		if (isAtOrAboveHomeDir(ancestor, os.homedir())) return;
		for (const binDir of PROJECT_LOCAL_BIN_DIRS)
			yield path.join(ancestor, binDir);
	}
}

/** Keep trust classification beside the resolver's canonical directory set. */
export function isProjectLocalBinPath(
	resolvedCommand: string,
	cwd: string,
): boolean {
	for (const binDir of projectLocalBinDirs(cwd)) {
		if (isUnderDir(resolvedCommand, binDir)) return true;
	}
	return false;
}

/**
 * #4515: a test for whether one PATH entry (or a global bin dir) can resolve
 * a bare command into the project at `cwd`. See the module docstring for the
 * rule. Each directory is filesystem-resolved once per test, not per entry.
 */
export function projectReach(cwd: string): (entry: string) => boolean {
	const posix = process.platform !== "win32";
	const dirs = [
		...(isAtOrAboveHomeDir(cwd, os.homedir()) ? [] : [cwd]),
		...projectLocalBinDirs(cwd),
	].map((dir) => normalizeFilePath(realpathOrResolve(dir)));
	return (entry) => {
		if (entry === "") return posix;
		if (!path.isAbsolute(entry)) return true;
		const canonical = normalizeFilePath(realpathOrResolve(entry));
		return dirs.some((dir) => isUnderCanonicalDir(canonical, dir));
	};
}

/** #4515: whether a bare command spawned with this process's PATH can resolve into `cwd`. */
export function commandSearchReachesProject(cwd: string): boolean {
	return (process.env.PATH ?? "").split(path.delimiter).some(projectReach(cwd));
}

/**
 * #4530 round 9: whether a RESOLVED command's real target lies in the project
 * pi has not trusted. A trust check on the directory that holds the command
 * answers a different question (a global bin dir outside the project can hold
 * a link into it; the target is what runs), so this resolves first.
 *
 * `classifyRegardlessOfTrust` opts out of the trusted early return for callers
 * that ask an ownership question rather than a trust question — the LSP
 * launcher does, because session trust does not grant ownership of an adopted
 * root (#4566 r13).
 */
export function commandResolvesIntoProject(
	resolvedCommand: string,
	cwd: string = process.cwd(),
	classifyRegardlessOfTrust = false,
): boolean {
	if (!classifyRegardlessOfTrust && getProjectTrustState() === "trusted")
		return false;
	// Preserve the spelling until the filesystem resolves symlinks and `..`.
	const commandPath = path.isAbsolute(resolvedCommand)
		? resolvedCommand
		: `${cwd}${path.sep}${resolvedCommand}`;
	try {
		return projectReach(cwd)(fs.realpathSync.native(commandPath));
	} catch {
		recordDegradationOnce({
			kind: "trust-refusal",
			subject: `global-command-realpath:${commandPath}`,
			reason: "resolved command realpath unavailable",
		});
		return true;
	}
}
