/**
 * #4476: disk changes pi-lens learns about only by looking.
 *
 * pi-lens advertises `workspace.didChangeWatchedFiles.dynamicRegistration`, so
 * a server may hand file watching to it: TypeScript 7's native server
 * registers `<root>/**` and its `node_modules` as client watchers and then
 * re-reads a closed file only when a watched-files event names that exact
 * file, or when it restarts (measured with a raw JSON-RPC probe of
 * `tsc --lsp --stdio`, TS 7.0.2; directory and manifest events change
 * nothing). pi-lens reports its own writes and the bash writes it recovers,
 * but not a file a command writes into a gitignored directory (codegen), a
 * change made outside pi, or a dependency install. The server then kept the
 * old declarations for its whole life, and the diagnostics cache served
 * entries whose ambient scope had changed under them.
 *
 * At each #4493 look (a bash tool_result, every tool_call) this module:
 * - compares the root's install stamps (lockfiles and package-manager install
 *   markers): a change is an install no event can enumerate, so the root's
 *   live primary clients restart, and every cache entry scanned before it is
 *   refused;
 * - compares a bounded walk of the root's declaration files: each one created,
 *   edited or deleted goes to the live clients as an exact-URI watched-files
 *   event, and the cache refuses the entries whose scope holds it.
 *
 * The records are process-wide per root, as the servers are (two sessions on
 * one root share them, so one install restarts once). They describe the disk,
 * not a session, so a session boundary keeps them: an install made between
 * sessions is still seen. A root's first look records and changes nothing.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { isExcludedDirName } from "./file-utils.js";
import { logLatency } from "./latency-logger.js";
import { peekLSPService } from "./lsp/capabilities.js";
import {
	noteWorkspaceDependenciesChanged,
	noteWorkspaceFilesChangedOnDisk,
} from "./lsp/workspace-diagnostics-session.js";
import { normalizeMapKey } from "./path-utils.js";
import { createSingleFlight } from "./single-flight.js";

/**
 * Files an install rewrites at the root: the lockfiles, and the markers a
 * package manager writes into its install tree (npm rewrites
 * `node_modules/.package-lock.json` on `npm install` and `npm ci`, measured;
 * `npm ci` leaves the lockfile and the `node_modules` inode alone). The
 * `node_modules` directory itself is not one: a tool's cache directory under
 * it would restart the servers.
 */
const INSTALL_LOCKFILES = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"pdm.lock",
	"go.sum",
	"Cargo.lock",
];
/** The install markers, under `node_modules`. */
const INSTALL_MARKERS = [
	".package-lock.json",
	".modules.yaml",
	".yarn-state.yml",
	".yarn-integrity",
];

/** Directories one declaration walk reads before it stops (degraded). */
const DECLARATION_WALK_MAX_DIRS = 4096;
/** Declaration files one walk records before it stops (degraded). */
const DECLARATION_WALK_MAX_FILES = 2048;
/** Directory reads in flight during one walk. */
const DECLARATION_WALK_CONCURRENCY = 16;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;
/** Roots kept; the oldest is dropped (its next look is a first look). */
const MAX_ROOTS = 64;

/** Least time between two tool_call walks of one root (bash results always walk). */
function declarationLookIntervalMs(): number {
	const raw = Number(process.env.PI_LENS_DECLARATION_LOOK_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

interface RootRecord {
	stamp: string;
	/** path -> `ino:size:mtimeMs`; undefined until a walk completes uncapped. */
	declarations: Map<string, string> | undefined;
	walkedAt: number;
}

const records = new BoundedFifoMap<string, RootRecord>(MAX_ROOTS);
/**
 * One look per root at a time: a look that arrives mid-flight joins it and
 * gets one trailing look, which compares against the record the flight left,
 * so two sessions' looks after one install restart once. The trailing look
 * carries the first caller's trigger.
 */
const looks = createSingleFlight<void>({ coalesceTrailing: true });

const fingerprint = (stat: {
	ino: number;
	size: number;
	mtimeMs: number;
}): string => `${stat.ino}:${stat.size}:${stat.mtimeMs}`;

/**
 * The root's install stamp: one listing of the root, then a stat of each
 * lockfile it holds and, when it holds `node_modules`, of each install marker
 * (a tool call pays a listing and a few stats, not one stat per name). A name
 * that appears, changes or goes away changes the stamp.
 */
async function readInstallStamp(root: string): Promise<string> {
	let listed: Set<string>;
	try {
		listed = new Set(await fsp.readdir(root));
	} catch {
		return "-";
	}
	const names: string[] = [];
	for (const name of INSTALL_LOCKFILES) if (listed.has(name)) names.push(name);
	if (listed.has("node_modules"))
		for (const marker of INSTALL_MARKERS) names.push(`node_modules/${marker}`);
	const parts = await Promise.all(
		names.map(async (name) => {
			try {
				return `${name}=${fingerprint(await fsp.stat(join(root, name)))}`;
			} catch {
				return `${name}=-`;
			}
		}),
	);
	return parts.join("|");
}

/**
 * The declaration files under `root`, outside the shared excluded directories
 * (gitignored ones included: codegen writes there), in a deterministic order;
 * `undefined` when the walk hit a cap.
 */
async function walkDeclarations(
	root: string,
): Promise<Map<string, string> | undefined> {
	const found: string[] = [];
	const queue = [root];
	let next = 0;
	let capped = false;
	const worker = async () => {
		while (!capped && next < queue.length) {
			if (next >= DECLARATION_WALK_MAX_DIRS) {
				capped = true;
				return;
			}
			const dir = queue[next++] as string;
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (!isExcludedDirName(entry.name)) queue.push(join(dir, entry.name));
				} else if (entry.isFile() && DECLARATION_FILE.test(entry.name)) {
					found.push(join(dir, entry.name));
				}
			}
			if (found.length > DECLARATION_WALK_MAX_FILES) capped = true;
		}
	};
	// The queue grows while workers drain it; a worker that finds it empty
	// returns, so the walk re-arms until every directory was read.
	while (!capped && next < queue.length)
		await Promise.all(
			Array.from({ length: DECLARATION_WALK_CONCURRENCY }, worker),
		);
	if (capped) return undefined;
	found.sort();
	const declarations = new Map<string, string>();
	await Promise.all(
		found.map(async (filePath) => {
			try {
				declarations.set(filePath, fingerprint(await fsp.stat(filePath)));
			} catch {
				// Gone between the listing and the stat: absent.
			}
		}),
	);
	return declarations;
}

function diffDeclarations(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
): Array<{ filePath: string; type: number }> {
	const changes: Array<{ filePath: string; type: number }> = [];
	for (const [filePath, print] of after) {
		const prior = before.get(filePath);
		if (prior === undefined) changes.push({ filePath, type: 1 });
		else if (prior !== print) changes.push({ filePath, type: 2 });
	}
	for (const filePath of before.keys())
		if (!after.has(filePath)) changes.push({ filePath, type: 3 });
	return changes;
}

/**
 * Look at `root` for an install or a declaration-file change since its last
 * look, and act on what changed (see the module doc). Looks of one root run
 * one at a time, each against the record the previous one left (`looks`).
 */
export function lookForOutOfBandChanges(
	root: string,
	trigger: "tool_call" | "tool_result",
): Promise<void> {
	const key = normalizeMapKey(root);
	return looks.run(key, () => lookOnce(root, key, trigger));
}

async function lookOnce(
	root: string,
	key: string,
	trigger: "tool_call" | "tool_result",
): Promise<void> {
	const started = Date.now();
	const prior = records.get(key);
	const walkDue =
		trigger === "tool_result" ||
		prior === undefined ||
		started - prior.walkedAt >= declarationLookIntervalMs();
	const [stamp, walked] = await Promise.all([
		readInstallStamp(root),
		walkDue ? walkDeclarations(root) : Promise.resolve(undefined),
	]);
	const declarations = walkDue ? walked : prior?.declarations;
	records.set(key, {
		stamp,
		declarations,
		walkedAt: walkDue ? started : (prior?.walkedAt ?? started),
	});
	if (walkDue && walked === undefined)
		recordDegradationOnce({
			kind: "lsp-declaration-look-capped",
			subject: key,
			reason: `the declaration-file walk passed ${DECLARATION_WALK_MAX_DIRS} directories or ${DECLARATION_WALK_MAX_FILES} files; declaration files created, edited or deleted outside pi-lens under this root reach no language server and no diagnostics-cache entry is refused for them`,
		});
	if (prior === undefined) return;
	const installed = stamp !== prior.stamp;
	const changes =
		walkDue && walked && prior.declarations
			? diffDeclarations(prior.declarations, walked)
			: [];
	if (!installed && changes.length === 0) return;
	const at = Date.now();
	const service = peekLSPService();
	let restarted = 0;
	if (installed) {
		noteWorkspaceDependenciesChanged(at);
		restarted = (await service?.restartPrimaryClientsUnder(root)) ?? 0;
	}
	if (changes.length > 0) {
		noteWorkspaceFilesChangedOnDisk(
			root,
			changes.map((change) => normalizeMapKey(change.filePath)),
			at,
		);
		service?.notifyOutOfBandFileChanges(changes);
	}
	const count = (type: number) =>
		changes.reduce((n, change) => n + (change.type === type ? 1 : 0), 0);
	logLatency({
		type: "phase",
		phase: "lsp_out_of_band_change",
		filePath: root,
		durationMs: Date.now() - started,
		result: installed
			? changes.length > 0
				? "install+declarations"
				: "install"
			: "declarations",
		metadata: {
			trigger,
			restarted,
			created: count(1),
			changed: count(2),
			deleted: count(3),
		},
	});
}
