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
// a step written as a flow mapping, an action reached through an anchor or an
// alias, and a line a flow collection holds open across lines.
//
// The reader is dependency-free on purpose: .github/workflows/action-pins.yml
// runs `node scripts/check-action-pins.mjs` with no `npm install`, so js-yaml is
// not available here.
const CONCRETE_PYTHON = /^\d+\.\d+(?:\.\d+)?$/;
const SETUP_PYTHON = "actions/setup-python";
// A block-mapping entry: `key: value`, a quoted key accepted. The list marker
// and any node property in front of the key are stripped first, so this reads
// the key the line actually holds.
// In block context `key:"value"` with no space is one plain scalar, not a key.
const KEY_LINE = /^(["']?)([A-Za-z0-9_-]+)\1[ \t]*:(?:[ \t]+(.*))?$/;
// A list marker in front of a block mapping's key, one per nesting level.
const LIST_MARKER = /^-(?:[ \t]+|$)/;
// A YAML node property in front of a node: an anchor (`&name`), an alias
// (`*name`), or a tag (`!tag`, `!!seq`, `!<tag:yaml.org,2002:seq>`). It
// prefixes the node it stands on and changes nothing about where that node
// stands or what it ultimately holds, so the reader strips it before deciding
// either question (F-4671-R5-1). A `uses:` value it prefixes is refused rather
// than read: an anchored or aliased action reference is not a value this
// walker can follow (F-4671-R5-2).
const NODE_PROPERTY = /^(?:[&*][^ \t,[\]{}]+|!(?:<[^>\n]*>|[^ \t,[\]{}]*))/;
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

// Everything in front of a node's own text: the list markers a block entry
// stands on and the node properties that prefix it. What remains is the text
// the line's meaning is decided from, and it is also what a line the block
// reader does not classify as a key is scanned as — so `- &a uses: …` is read
// as a `uses:` entry (F-4671-R5-1) while a plain scalar's continuation line,
// which is neither, stays prose (shape 43).
function nodeText(trimmed) {
	let rest = trimmed;
	let marker = 0;
	for (;;) {
		const listItem = LIST_MARKER.exec(rest);
		if (!listItem) break;
		marker += listItem[0].length;
		rest = rest.slice(listItem[0].length);
	}
	return { text: stripNodeProperties(rest).text, marker };
}

// A value with its leading node properties removed. `stripped` reports that
// the value carried one, which is what a `uses:` value is refused for.
function stripNodeProperties(text) {
	let rest = text;
	let stripped = false;
	for (;;) {
		const property = NODE_PROPERTY.exec(rest);
		if (!property) return { text: rest, stripped };
		stripped = true;
		rest = rest.slice(property[0].length).trimStart();
	}
}

// A value up to its trailing comment, or as written when it carries none. A
// `#` opens a comment only at the start of the text or after whitespace, and
// never inside a quoted scalar, so a `"a #b"` value keeps its text (shape 43:
// the action's name in a comment is prose, not a step).
function withoutComment(text) {
	let quote = "";
	for (let at = 0; at < text.length; at += 1) {
		const char = text[at];
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
		if (char === "#" && (at === 0 || /[ \t]/.test(text[at - 1])))
			return text.slice(0, at).trimEnd();
	}
	return text;
}

// How many flow collections a line leaves open, counted outside quotes: `{[`
// open one and `}]` close one. A flow collection may hold its next tokens on
// following lines, so the count is the lexical state that decides whether the
// next line stands inside one (shape 43).
function flowDelta(text) {
	let quote = "";
	let delta = 0;
	for (let at = 0; at < text.length; at += 1) {
		const char = text[at];
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
		if (char === "{" || char === "[") delta += 1;
		else if (char === "}" || char === "]") delta -= 1;
	}
	return delta;
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
	// An anchored, aliased or tagged action reference is not one this walker
	// can follow: `&a actions/setup-python@…` prefixes the action with a node
	// property, and `*ref` names a value defined on another line, so the pin
	// this step carries is not on this line at all (F-4671-R5-2). Refused as
	// written rather than resolved, because resolving a YAML alias is exactly
	// the kind of second reader this rule has already failed to write.
	if (NODE_PROPERTY.test(text)) return { read: false, text };
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
	// How many flow collections are still open at the start of the line: the
	// lexical state a flow collection spanning lines has (shape 43). It is set
	// only by a line this walker already reads as holding one, so a brace in
	// prose never puts the lines below it in flow.
	let flowDepth = 0;
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
			body: "",
			inFlow: flowDepth > 0,
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
		// The line past its list markers and node properties. A property
		// prefixes the node the line holds, so `- &a uses: …` names a `uses:`
		// entry and `steps: &x [{…}]` a `steps:` entry (F-4671-R5-1), and a
		// line with nothing of its own left is not a key.
		const node = nodeText(trimmed);
		entry.body = node.text;
		const key = KEY_LINE.exec(node.text);
		if (key) {
			entry.kind = "key";
			entry.key = key[2].toLowerCase();
			entry.value = key[3] ?? "";
			// The key token's column, past the list markers: sibling keys of a
			// step (`with:`) sit at it, and anything shallower ends the step.
			entry.column = indent + node.marker;
			if (BLOCK_SCALAR.test(blockHeader(entry.value))) literal = entry.column;
		} else entry.kind = "other";
		// The part of the line a flow collection can open in: a key's value, or
		// a line's own text with its comment dropped.
		const span = withoutComment(
			entry.kind === "key"
				? stripNodeProperties(entry.value).text
				: entry.kind === "other"
					? entry.body
					: "",
		);
		if (entry.inFlow || span.startsWith("{") || span.startsWith("["))
			flowDepth = Math.max(0, flowDepth + flowDelta(span));
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

// A `uses` key standing where a key can: after `{`, `[`, `,` or the line's
// start, quoted or bare, so prose is not a key (shape 43).
const FLOW_USES = /(?:^|[{,[])[ \t]*(["']?)uses\1[ \t]*:/i;
// A double-quoted token carrying a backslash: a YAML escape, which this walker
// decodes nowhere (`"\u0061ctions/…"` spells `actions/…`). Single quotes are
// left out because YAML processes no escape inside them.
const FLOW_ESCAPE = /"[^"]*\\/;

/**
 * Why one line's flow collection is refused, or null when it holds none. The
 * block reader reads `key: value` lines, so a step written as a flow mapping
 * (`- {uses: …}`, `steps: [{…}]`, or a `with:` whose value is one) is not a
 * form this walker reads.
 *
 * Shape 69: nothing here decides what a `uses` token *means*. Telling a step's
 * `uses` from an input named `uses` needs the key that opened the mapping, and
 * three rounds of that ownership rule each left one valid workflow able to pass
 * a floating pin silently: a quoted key consumed as a string (round 3), a
 * sibling's opener taken from the previous mapping's trailing `with:` (round
 * 4), and an escaped key no key regex matched (round 5, this file). So a flow
 * collection that names the action is refused whole, and the block path stays
 * the precise one. Cost, at live population 0: a wrapper action whose input is
 * literally named `uses` is refused rather than read — visible, where a silent
 * pass is not.
 *
 * Prose stays text: the trailing comment is copy, so a `#` explaining why the
 * action is not needed is not a step (shape 43), and only a node that *is* a
 * flow collection reaches here at all (see `flowText`).
 */
function flowRefusal(line, at, file) {
	const text = withoutComment(line);
	if (FLOW_ESCAPE.test(text))
		return `${file}:${at}: a flow-collection token carries a YAML escape this walker does not decode; the python-version pin cannot be read`;
	if (text.toLowerCase().includes(SETUP_PYTHON))
		return `${file}:${at}: ${SETUP_PYTHON} appears in a flow collection, which this walker does not read; write the step as a block mapping`;
	const key = FLOW_USES.exec(text);
	if (key) {
		const start = key.index + key[0].length;
		const target = usesTarget(text.slice(start, flowValueEnd(text, start)));
		// A flow value the scalar reader did not fully decode, or one that
		// names its action through an anchor or an alias, is refused too: it
		// may name an action this walker cannot read.
		if (!target.read)
			return `${file}:${at}: uses: "${target.text}" is not a value this walker reads; the python-version pin cannot be read`;
	}
	return null;
}

/**
 * The text of one line that can hold a flow mapping: a line the block reader
 * did not read as a key, a key whose own value opens a flow collection
 * (`steps: [{uses: …}]`), or either kind standing inside a flow collection
 * that a previous line left open (a flow list may carry its next tokens on
 * following lines, F-4671-R6-1). What is handed on is the node's own text,
 * past its list markers and node properties, and — outside an open collection —
 * only when it *starts* with `{` or `[`: a brace anywhere else, or on a line
 * that is really a plain scalar's continuation, is prose, so `run: echo
 * {uses: …}` stays text and a `run:` value continued on the next line is not a
 * step (shape 43). The owning key is not handed on: `flowRefusal` attributes
 * nothing.
 */
function flowText(entry) {
	if (entry.kind !== "other" && entry.kind !== "key") return "";
	// Inside an open flow collection the whole line is that collection's text,
	// however it starts and whatever key it happens to spell.
	if (entry.inFlow) return withoutComment(entry.body);
	const text = entry.kind === "other" ? entry.body : entry.value;
	if (!text) return "";
	const value = stripNodeProperties(text).text;
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
		// A line inside an open flow collection is that collection's text, not
		// a block mapping entry: the flow pass below refuses it, and reading it
		// here would attribute a step the line does not spell (round 6).
		if (entry.kind !== "key" || entry.inFlow || entry.key !== "uses") continue;
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
			// A block scalar's body is shell or prose, a comment is copy, and a
			// line inside an open flow collection is that collection's text:
			// none is one of the step's keys (shape 43).
			if (next.kind !== "key" || next.inFlow) continue;
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
	// looks only at lines that hold one, so a `run:` body that prints a `uses:`
	// line is left alone (shape 43).
	for (const entry of entries) {
		const line = flowText(entry);
		if (!line) continue;
		const refusal = flowRefusal(line, entry.index + 1, file);
		if (refusal) errors.push(refusal);
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
