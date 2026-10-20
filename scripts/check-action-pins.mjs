#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { githubHeaders } from "./lib/github-rest.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const FULL_VERSION = /^v?\d+\.\d+\.\d+$/;
const PREFIX_VERSION = /^v?\d+(?:\.\d+)?$/;
const USES = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseActionPins(text, file = "<fixture>") {
	const pins = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const match = line.match(USES);
		if (!match) continue;
		const at = match[1].lastIndexOf("@");
		if (at < 1) continue;
		const ref = match[1].slice(at + 1);
		if (!SHA.test(ref)) continue;
		const action = match[1].slice(0, at);
		const comment = match[2]?.trim() ?? "";
		pins.push({
			action,
			sha: ref.toLowerCase(),
			tag: comment,
			file,
			line: index + 1,
		});
	}
	return pins;
}

// #4666: a `setup-python` step's `python-version` is an interpreter pin, and
// its precondition is static text: a concrete `x.y` release, never a floating
// channel. `"3.x"` resolved to CPython 3.15, pyyaml publishes no cp315 wheel,
// `--only-binary=:all:` refuses the sdist, and the advisory yamllint row
// installed nothing while the workflow still read green. Shape 69: ONE positive
// test decides what is a pin, so no list of known-bad spellings can pass an
// unlisted one, and every form the reader cannot see fails closed.
const CONCRETE_PYTHON = /^\d+\.\d+(?:\.\d+)?$/;
const SETUP_PYTHON = "actions/setup-python";
// A `uses:` key in block form: `- uses:` or `uses:`, quoted or not.
const STEP_USES = /^([ \t]*)(?:-[ \t]+)?(["']?)uses\2[ \t]*:[ \t]*(.*)$/;
const STEP_KEY = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/;

// A key's scalar value: quotes stripped and a trailing comment dropped. A value
// the reader cannot close is returned as written, so it fails the rule instead
// of passing as something the walker guessed.
function scalar(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		const end = trimmed.indexOf(quote, 1);
		return end > 0 ? trimmed.slice(1, end) : trimmed;
	}
	return trimmed.replace(/[ \t]+#.*$/, "").trim();
}

function usesTarget(raw) {
	const value = scalar(raw);
	const at = value.lastIndexOf("@");
	return at < 1
		? null
		: { action: value.slice(0, at), ref: value.slice(at + 1) };
}

/**
 * The interpreter pins of every `actions/setup-python` step in one file: a
 * workflow or a composite action. `python-version` must be a concrete `x.y` or
 * `x.y.z`; a step with no readable pin is reported. Messages carry the file,
 * the step (`actions/setup-python@<ref>`) and the value read, in the same
 * `${file}:${line}: ` shape the action-pin messages use.
 */
export function checkInterpreterPins(text, file = "<fixture>") {
	const errors = [];
	const lines = String(text).split(/\r?\n/);
	const read = new Set();
	for (const [index, line] of lines.entries()) {
		const uses = STEP_USES.exec(line);
		const target = uses && usesTarget(uses[3]);
		if (!target || target.action !== SETUP_PYTHON) continue;
		read.add(index);
		const step = `${target.action}@${target.ref}`;
		// The `uses` key's column: a sibling key of the step sits at it, and
		// anything shallower ends the step.
		const keyIndent = line.search(/["']?uses["']?[ \t]*:/);
		let sawWith = false;
		let inWith = false;
		let unreadable = null;
		const values = [];
		for (let at = index + 1; at < lines.length; at += 1) {
			const raw = lines[at];
			const trimmed = raw.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const indent = raw.length - raw.trimStart().length;
			if (indent < keyIndent) break;
			if (indent === keyIndent && trimmed.startsWith("- ")) break;
			const key = STEP_KEY.exec(trimmed);
			if (!key) continue;
			const name = key[1].toLowerCase();
			if (indent === keyIndent) {
				inWith = name === "with";
				if (inWith) {
					sawWith = true;
					// An inline flow mapping: the block reader cannot see its keys.
					if (key[2].trim()) unreadable ??= at + 1;
				}
				continue;
			}
			if (inWith && name === "python-version")
				values.push({ line: at + 1, value: scalar(key[2]) });
		}
		if (unreadable !== null) {
			errors.push(
				`${file}:${unreadable}: ${step} with: is not a block mapping; the python-version pin cannot be read`,
			);
			continue;
		}
		if (!sawWith || values.length === 0) {
			errors.push(
				`${file}:${index + 1}: ${step} has no with: python-version; the interpreter channel must be a concrete x.y release`,
			);
			continue;
		}
		for (const { line: valueLine, value } of values)
			if (!CONCRETE_PYTHON.test(value))
				errors.push(
					`${file}:${valueLine}: ${step} python-version "${value}" is not a concrete x.y or x.y.z release`,
				);
	}
	// A `setup-python` mention the block reader did not parse (a flow-map step,
	// a quoted key it cannot follow) is refused rather than passed: an unread
	// spelling is never a green one.
	for (const [index, line] of lines.entries()) {
		if (read.has(index) || line.trimStart().startsWith("#")) continue;
		const bare = line.replace(/#.*$/, "");
		if (!bare.includes(SETUP_PYTHON) || !/\buses\b/.test(bare)) continue;
		errors.push(
			`${file}:${index + 1}: ${SETUP_PYTHON} uses: is not a block-mapping step; the python-version pin cannot be read`,
		);
	}
	return errors;
}

export function validatePins(pins, resolveTag, exemptions = {}) {
	return Promise.all(
		pins.map(async (pin) => {
			const key = `${pin.action}@${pin.sha}#${pin.tag}`;
			const location = `${pin.file}:${pin.line}`;
			if (exemptions[key]) return null;
			if (!pin.tag)
				return `${location}: ${pin.action}@${pin.sha} has no version comment`;
			let resolved;
			try {
				if (FULL_VERSION.test(pin.tag)) {
					resolved = await resolveTag(pin.action, pin.tag);
					if (!resolved || !SHA.test(resolved))
						throw new Error("GitHub API response has no commit SHA");
					resolved = resolved.toLowerCase();
				} else if (PREFIX_VERSION.test(pin.tag)) {
					const matches = await resolveTag(pin.action, pin.tag);
					if (!Array.isArray(matches))
						throw new Error("GitHub API response has no matching release tags");
					const matching = matches.filter(
						(match) => match.sha.toLowerCase() === pin.sha,
					);
					if (matching.length) return null;
					const nearest =
						matches.map((match) => match.tag).join(", ") || "none";
					return `${location}: ${pin.action}@${pin.sha} is not a ${pin.tag} release; nearest tags: ${nearest}`;
				} else {
					throw new Error(`unsupported version comment ${pin.tag}`);
				}
			} catch (error) {
				return `${location}: cannot resolve ${pin.action} tag ${pin.tag}: ${error.message}`;
			}
			return resolved === pin.sha
				? null
				: `${location}: ${pin.action} # ${pin.tag} resolves to ${resolved}, not ${pin.sha}`;
		}),
	).then((results) => results.filter(Boolean));
}

export async function workflowFiles(root = ROOT) {
	const found = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (
				entry.name.endsWith(".yml") ||
				entry.name.endsWith(".yaml") ||
				entry.name === "action.yml"
			)
				found.push(path);
		}
	}
	await walk(join(root, ".github", "workflows"));
	await walk(join(root, ".github", "actions"));
	return found.sort();
}

export async function resolveGithubTag(
	action,
	tag,
	fetchImpl = fetch,
	env = process.env,
) {
	const [owner, repo] = action.split("/");
	if (!owner || !repo) throw new Error(`invalid action ${action}`);
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = githubHeaders(env.GITHUB_TOKEN || env.GH_TOKEN);
	const refUrl = `${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
	const response = await fetchImpl(refUrl, { headers });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	const ref = await response.json();
	if (ref.object?.type !== "tag") return ref.object?.sha;
	const tagResponse = await fetchImpl(
		`${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/tags/${ref.object.sha}`,
		{ headers },
	);
	if (!tagResponse.ok) throw new Error(`GitHub API ${tagResponse.status}`);
	return (await tagResponse.json()).object?.sha;
}

export async function resolveGithubMatchingTags(
	action,
	prefix,
	fetchImpl = fetch,
	env = process.env,
) {
	const [owner, repo] = action.split("/");
	if (!owner || !repo) throw new Error(`invalid action ${action}`);
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = githubHeaders(env.GITHUB_TOKEN || env.GH_TOKEN);
	const url = `${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/matching-refs/tags/${encodeURIComponent(prefix + ".")}`;
	const response = await fetchImpl(url, { headers });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	const refs = await response.json();
	if (!Array.isArray(refs))
		throw new Error("GitHub API response is not a ref list");
	return Promise.all(
		refs
			.filter((ref) => ref.ref?.startsWith(`refs/tags/${prefix}.`))
			.map(async (ref) => ({
				tag: ref.ref.slice("refs/tags/".length),
				sha:
					ref.object?.type === "tag"
						? await resolveGithubTagObject(
								action,
								ref.object.sha,
								fetchImpl,
								env,
							)
						: ref.object?.sha,
			})),
	).then((tags) => {
		if (tags.some((tag) => !SHA.test(tag.sha || "")))
			throw new Error("GitHub API response has a ref without a commit SHA");
		return tags.map((tag) => ({ ...tag, sha: tag.sha.toLowerCase() }));
	});
}

async function resolveGithubTagObject(action, objectSha, fetchImpl, env) {
	const [owner, repo] = action.split("/");
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = githubHeaders(env.GITHUB_TOKEN || env.GH_TOKEN);
	const response = await fetchImpl(
		`${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/tags/${objectSha}`,
		{ headers },
	);
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	return (await response.json()).object?.sha;
}

export async function checkActionPins({
	root = ROOT,
	fetchImpl = fetch,
	env = process.env,
} = {}) {
	let exemptions = {};
	const exemptionsFile = join(
		root,
		"scripts",
		"check-action-pins-exemptions.json",
	);
	try {
		const entries = JSON.parse(await readFile(exemptionsFile, "utf8"));
		for (const entry of entries) {
			if (
				!entry.action ||
				!entry.sha ||
				entry.tag === undefined ||
				!entry.reason
			)
				throw new Error("invalid action pin exemption");
			exemptions[`${entry.action}@${entry.sha.toLowerCase()}#${entry.tag}`] =
				entry.reason;
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const files = await workflowFiles(root);
	const texts = await Promise.all(
		files.map(async (file) => ({
			file: relative(root, file),
			text: await readFile(file, "utf8"),
		})),
	);
	const pins = texts.flatMap(({ file, text }) => parseActionPins(text, file));
	const interpreter = texts.flatMap(({ file, text }) =>
		checkInterpreterPins(text, file),
	);
	const resolved = new Map();
	const errors = await validatePins(
		pins,
		async (action, tag) => {
			const key = `${action}@${tag}`;
			if (!resolved.has(key))
				resolved.set(
					key,
					FULL_VERSION.test(tag)
						? resolveGithubTag(action, tag, fetchImpl, env)
						: resolveGithubMatchingTags(action, tag, fetchImpl, env),
				);
			return resolved.get(key);
		},
		exemptions,
	);
	return [...errors, ...interpreter];
}

export async function main() {
	const errors = await checkActionPins();
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("All pinned GitHub Actions match their version comments.");
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	await main();
