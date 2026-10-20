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
// unlisted one, and every form the walker cannot fully read is refused: a YAML
// escape, text after a scalar's closing quote, a `uses:` value on another line,
// a step written as a flow mapping.
//
// The reader is dependency-free on purpose: .github/workflows/action-pins.yml
// runs `node scripts/check-action-pins.mjs` with no `npm install`, so js-yaml is
// not available here.
const CONCRETE_PYTHON = /^\d+\.\d+(?:\.\d+)?$/;
const SETUP_PYTHON = "actions/setup-python";
// A block-mapping entry: `key: value`, `- key: value`, a quoted key accepted.
// In block context `key:"value"` with no space is one plain scalar, not a key.
const KEY_LINE =
	/^(?:(-)[ \t]+)?(["']?)([A-Za-z0-9_-]+)\2[ \t]*:(?:[ \t]+(.*))?$/;
// A value that opens a block scalar: the lines more indented below it are
// literal text — shell or prose, never workflow structure (shape 43). Its
// header carries an optional indentation and chomping indicator, in either
// order (`|2-` and `|-2` are the same block).
const BLOCK_SCALAR = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

// A key's value as a block-scalar header: a trailing comment is copy, so
// `run: | # build steps` opens the same literal block as `run: |` does. This
// reads the value as written, not through `scalar()`, whose quoted form would
// turn the string `"|"` into the header it is not.
function blockHeader(value) {
	const trimmed = value.trim();
	const comment = trimmed.search(/[ \t]#/);
	return (comment < 0 ? trimmed : trimmed.slice(0, comment)).trim();
}

// A key's scalar value: quotes stripped and a trailing comment dropped. `read`
// is false for a value this walker does not fully read, and the value returned
// is then the text as written, so the rule reports what the file holds instead
// of a prefix of it (shape 69).
function scalar(raw) {
	const trimmed = raw.trim();
	if (!trimmed || trimmed.startsWith("#")) return { text: "", read: true };
	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		const end = trimmed.indexOf(quote, 1);
		if (end < 0) return { text: trimmed, read: false };
		const rest = trimmed.slice(end + 1).trim();
		if (rest && !rest.startsWith("#")) return { text: trimmed, read: false };
		const text = trimmed.slice(1, end);
		// `"\u0061"` spells `a`, and a single-quoted `''` is a literal quote: a
		// reader that does not decode YAML escapes knows neither value.
		return { text, read: !(quote === '"' && text.includes("\\")) };
	}
	const comment = trimmed.search(/[ \t]#/);
	return {
		text: comment < 0 ? trimmed : trimmed.slice(0, comment).trim(),
		read: true,
	};
}

// The action and ref of a `uses:` value, or that the walker did not read it. A
// read value with no `@` names a local action or a container, which no pin rule
// governs.
function usesTarget(raw) {
	const { text, read } = scalar(raw);
	if (!read || !text || BLOCK_SCALAR.test(text)) return { read: false, text };
	const at = text.lastIndexOf("@");
	return at < 1
		? { read: true, action: null, ref: "" }
		: { read: true, action: text.slice(0, at), ref: text.slice(at + 1) };
}

/**
 * The block structure of one workflow or composite action: for every line,
 * whether it is a mapping entry the walker may read (`key`), the literal body of
 * a block scalar (`literal`), a comment, blank, or a line it does not read as a
 * key (`other`, which is where a flow mapping lands). A block scalar's body is
 * shell or prose, so no scan below reads a step or an input out of it: marking
 * which lines carry structure is what keeps `echo "uses: …"` from failing CI
 * (shape 43).
 */
function readBlock(text) {
	const entries = [];
	let literal = null;
	for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
		const indent = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		const entry = {
			index,
			raw,
			indent,
			kind: "blank",
			key: "",
			value: "",
			column: 0,
		};
		entries.push(entry);
		if (literal !== null) {
			// A blank line belongs to the open scalar; the first line at or
			// above the key that opened it ends the scalar.
			if (!trimmed || indent > literal) {
				entry.kind = "literal";
				continue;
			}
			literal = null;
		}
		if (!trimmed) continue;
		if (trimmed.startsWith("#")) {
			entry.kind = "comment";
			continue;
		}
		const key = KEY_LINE.exec(trimmed);
		if (!key) {
			entry.kind = "other";
			continue;
		}
		entry.kind = "key";
		entry.key = key[3].toLowerCase();
		entry.value = key[4] ?? "";
		// The key token's column, past a list marker: sibling keys of a step
		// (`with:`) sit at it, and anything shallower ends the step.
		entry.column =
			indent +
			(key[1] ? key[0].length - key[0].replace(/^-[\t ]+/, "").length : 0);
		if (BLOCK_SCALAR.test(blockHeader(entry.value))) literal = entry.column;
	}
	return entries;
}

// Where a flow value ends: the first `,`, `}` or `]` outside quotes.
function flowValueEnd(raw, start) {
	let quote = "";
	for (let at = start; at < raw.length; at += 1) {
		const char = raw[at];
		if (quote) {
			if (char === "\\" && quote === '"') {
				at += 1;
				continue;
			}
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "," || char === "}" || char === "]") return at;
	}
	return raw.length;
}

// A key inside a flow collection: a quoted or bare name and its colon.
const FLOW_KEY = /^(["']?)([A-Za-z0-9_-]+)\1[ \t]*:[ \t]*/;

/**
 * The `uses:` values named as keys of a flow mapping on one line, such as
 * `- {uses: x, with: {…}}` or `steps: [{uses: x}]`. A `uses` token counts only
 * where a key can stand — straight after `{`, `[` or `,` inside a collection —
 * so the prose in `run: echo uses: a/b@c` is text, not a step (shape 43). A
 * mapping opened by a `with:` key holds that step's inputs, where `uses` is one
 * of the action's input names, so it is not the step's action
 * (PRRT_kwDORt8rec6uXCpP); every other mapping's `uses` is, wherever the step is
 * written, so no depth is left unread.
 */
function flowUsesValues(raw) {
	const values = [];
	// The key that opened each open mapping. A `[` opens none of its own, so a
	// step written as `steps: [{uses: …}]` carries its keys at the same level a
	// list-item step `- {uses: …}` does.
	const openers = [];
	let lastKey = "";
	let quote = "";
	let keyNext = false;
	for (let at = 0; at < raw.length; at += 1) {
		const char = raw[at];
		if (quote) {
			if (char === "\\" && quote === '"') {
				at += 1;
				continue;
			}
			if (char === quote) quote = "";
			continue;
		}
		if (char === "#" && (at === 0 || /[ \t]/.test(raw[at - 1]))) break;
		// A key may be quoted, so at a key position the key is read before the
		// quote opens a string: `{"uses": x}` names the action as `{uses: x}`
		// does (PRRT_kwDORt8rec6uW1l7 / PRRT_kwDORt8rec6uXCpF).
		if (keyNext && openers.length > 0) {
			const key = FLOW_KEY.exec(raw.slice(at));
			if (key) {
				keyNext = false;
				lastKey = key[2].toLowerCase();
				const start = at + key[0].length;
				if (lastKey === "uses" && !openers.includes("with"))
					values.push(raw.slice(start, flowValueEnd(raw, start)).trim());
				at = start - 1;
				continue;
			}
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "{" || char === "[" || (char === "," && openers.length > 0)) {
			if (char === "{") openers.push(lastKey);
			keyNext = true;
			continue;
		}
		if (char === "}" || char === "]" || char === ",") {
			if (char === "}") openers.pop();
			keyNext = false;
		}
	}
	return values;
}

/**
 * The text of one line that can hold a flow mapping: a line the block reader
 * did not read as a key, or a key whose own value opens a flow collection
 * (`steps: [{uses: …}]`). A flow value starts with `{` or `[`; anywhere else a
 * brace is prose, so `run: echo {uses: …}` stays text (shape 43).
 */
function flowText(entry) {
	if (entry.kind === "other") return entry.raw;
	if (entry.kind !== "key") return "";
	const value = entry.value.trimStart();
	return value.startsWith("{") || value.startsWith("[") ? value : "";
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
	const entries = readBlock(text);
	for (const entry of entries) {
		if (entry.kind !== "key" || entry.key !== "uses") continue;
		const target = usesTarget(entry.value);
		if (!target.read) {
			errors.push(
				`${file}:${entry.index + 1}: uses: "${target.text}" is not a value this walker reads; the python-version pin cannot be read`,
			);
			continue;
		}
		// GitHub owner and repository names are case-insensitive, so the
		// spelling a workflow uses is not the identity of the action.
		if (!target.action || target.action.toLowerCase() !== SETUP_PYTHON)
			continue;
		const step = `${target.action}@${target.ref}`;
		let sawWith = false;
		let inWith = false;
		let unreadable = null;
		const values = [];
		for (let at = entry.index + 1; at < entries.length; at += 1) {
			const next = entries[at];
			// A block scalar's body is shell or prose, and a comment is copy:
			// neither is one of the step's keys (shape 43).
			if (next.kind !== "key") continue;
			if (next.indent < entry.column) break;
			if (next.indent === entry.column) {
				if (next.raw.trimStart().startsWith("- ")) break;
				inWith = next.key === "with";
				if (inWith) {
					sawWith = true;
					// An inline flow mapping: the block reader cannot see its
					// keys. A comment after `with:` is copy, not a value.
					if (scalar(next.value).text) unreadable ??= next.index + 1;
				}
				continue;
			}
			if (inWith && next.key === "python-version")
				values.push({ line: next.index + 1, ...scalar(next.value) });
		}
		if (unreadable !== null) {
			errors.push(
				`${file}:${unreadable}: ${step} with: is not a block mapping; the python-version pin cannot be read`,
			);
			continue;
		}
		if (!sawWith || values.length === 0) {
			errors.push(
				`${file}:${entry.index + 1}: ${step} has no with: python-version; the interpreter channel must be a concrete x.y release`,
			);
			continue;
		}
		// A value the walker did not fully read arrives as the text written,
		// quotes and all, so it does not match the concrete form either: one
		// positive test answers for both (`'3.12''x'` is not `3.12`).
		for (const { line: valueLine, text: value } of values)
			if (!CONCRETE_PYTHON.test(value))
				errors.push(
					`${file}:${valueLine}: ${step} python-version "${value}" is not a concrete x.y or x.y.z release`,
				);
	}
	// A step written as a flow mapping (`- {uses: …}`, or `steps: [{…}]`) is
	// not the block form this walker reads, so its pin is refused rather than
	// passed: an unread spelling is never a green one. A block step reaches this
	// pass only through a flow collection held by one of its keys, and the scan
	// looks only where a `uses` key can stand, so a `run:` body that prints one
	// is left alone (shape 43).
	for (const entry of entries) {
		const line = flowText(entry);
		if (!line) continue;
		for (const value of flowUsesValues(line)) {
			const target = usesTarget(value);
			if (!target.read)
				errors.push(
					`${file}:${entry.index + 1}: uses: "${target.text}" is not a value this walker reads; the python-version pin cannot be read`,
				);
			else if ((target.action || "").toLowerCase() === SETUP_PYTHON)
				errors.push(
					`${file}:${entry.index + 1}: ${SETUP_PYTHON} uses: is not a block-mapping step; the python-version pin cannot be read`,
				);
		}
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
