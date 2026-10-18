/**
 * #2442: forbid a NEW hand-rolled evict-oldest block outside
 * `clients/bounded-cache.ts`.
 *
 * `clients/bounded-cache.ts` ships three small bounded collections —
 * `BoundedLruCache` (get() re-inserts), `BoundedFifoMap` (get() never
 * re-inserts, insertion-order eviction), and `BoundedSet` (the Set-shaped,
 * membership-only sibling, #2460) — built specifically so a call site never
 * has to hand-roll `const oldest = map.keys().next().value; if (oldest !==
 * undefined) map.delete(oldest);` again. #2432's round-3 review named two such
 * hand-rolled sites (`clients/hashline-anchor.ts`, `clients/mutating-tool.ts`);
 * a repo-wide sweep found the idiom 27 times.
 *
 * ## Properties this sweep learned the hard way (#2442 review F5/F6, #2460
 * review S1, #2460 round-3 review F1/F2)
 *
 * 1. **Four spellings, not one.** The first draft matched only
 *    `.keys().next().value`, so `tree-sitter-client.ts`'s two live
 *    `.entries().next().value` evictions and `debug-handles.ts`'s
 *    `for (const k of map.keys()) { …; break }` walk were invisible to a guard
 *    whose whole job was finding them. A fourth spelling — a BARE
 *    `for (const x of set) { set.delete(x); break; }`, with no
 *    `.keys()/.values()/.entries()` call at all — was still invisible after
 *    that fix: #2460's review planted it in `clients/lsp/session-roots.ts` and
 *    it passed silently, because iterating a `Set` directly already yields
 *    its values and neither prior regex requires the accessor call the bare
 *    form has no reason to make. All four spellings are matched now, across
 *    `keys`/`values`/`entries`/bare — the Set-shaped sites use `.values()` or
 *    the bare form; the bare form is additionally gated on a `.size`
 *    comparison in the surrounding loop, since a bare `for...of` is common for
 *    reasons that have nothing to do with eviction. A fifth spelling — the
 *    iterator RESULT bound to a name, with `.value` read on a LATER line
 *    (`const oldest = map.keys().next(); …; map.delete(oldest.value);`) — was
 *    invisible to all four, because spelling 1 matches `.next().value` on ONE
 *    line: the two whole-word spellings are the same two steps (#4570, the
 *    residual #4503's fixer filed). The pre-#4503 drift cap used it, so the
 *    sweep stayed green on the exact defect it exists to catch. All five are
 *    matched now, across `keys`/`values`/`entries`/bare/assigned — the
 *    Set-shaped sites use `.values()` or the bare form; the bare and assigned
 *    forms are additionally gated on a `.size` comparison in the surrounding
 *    loop, since a bare `for...of` and a bare `.next()` are both common for
 *    reasons that have nothing to do with eviction.
 *    The fifth spelling is matched on the SEMANTIC (any `.next()` result whose
 *    own `.value` is deleted under a size cap), not on the accessor call,
 *    because requiring `.keys()/values()/entries()` was the shape-69 mistake
 *    again: an aliased container and an indirectly called accessor are the
 *    same eviction and both passed an accessor-anchored draft (#4570).
 * 2. **Per-OCCURRENCE, not per-FILE.** Exemptions used to name a file, so a
 *    NEW hand-rolled eviction appended to an already-exempted file passed
 *    silently — the exemption laundered it. Every flagged item is now keyed
 *    by `stableOccurrenceKey` (`tests/support/sweep-kit.ts`), so an exemption
 *    is supposed to excuse exactly one occurrence and nothing else — but the
 *    key alone cannot fully guarantee that: in a class-shaped file, every
 *    method's flagged line resolves to the SAME enclosing symbol (the class
 *    name), so two sibling methods that each flag a byte-identical line
 *    collide on one key, and one exemption would silently excuse both (#2487
 *    review F1 — the exact laundering this property exists to prevent, one
 *    layer down). `auditRegistry`'s `requireUniqueFlagged` (on by default)
 *    is what actually closes that: a duplicate flagged key fails LOUD before
 *    exemption-matching ever runs, so a real collision cannot ride through
 *    silently regardless of how the key was derived.
 * 3. **Content-keyed, not line-keyed (#2475).** The first version of property
 *    2 keyed on `path:line`, which re-keys on every unrelated line inserted
 *    ABOVE a flagged site — #2459, #2449, and #2474 each had to re-pin a line
 *    number that had nothing to do with their own change, and a textual merge
 *    of two such re-keys can silently land a WRONG number with no conflict
 *    marker. `stableOccurrenceKey` keys on the occurrence's own TEXT instead
 *    (its enclosing top-level declaration name, via `findEnclosingSymbol`,
 *    plus a short content hash of the flagged line via `lineContentHash`), so
 *    moving the site by inserting lines elsewhere in the file is a no-op for
 *    the key. Deleting or editing the flagged line still changes its key —
 *    correctly, since `auditRegistry`'s stale-exemption check must still
 *    catch an exemption whose target moved or vanished; it now reports the
 *    drift by name/hash instead of by line number.
 * 4. **A tighter-LOOKING check can be narrower, not stronger.** The bare
 *    form's original delete check required the SAME pair
 *    (`container.delete(loopVar)`), which read as a stricter guard against
 *    false positives but was strictly narrower than spelling 2's own
 *    `break`+`.delete(` window check — and vacuous besides, since a generic
 *    `.delete(` catches every fixture the pair check did. It missed
 *    assign-inside/delete-below (`oldest = v; …; set.delete(oldest)`, where
 *    the deleted name is never the loop variable), `set.delete(loopVar!)`,
 *    and `set?.delete(loopVar)` (#2460 round-3 review F1) — now matched by
 *    dropping to spelling 2's semantics. Its `.size` gate had the mirror
 *    problem: it matched a bare `.size` MENTION, not a bounded-loop
 *    COMPARISON, so a `.size` log line or a `size === 0` early-return guard
 *    sitting near an unrelated break+delete (find-first-match, drain-one)
 *    was misread as the `while (set.size > cap)` shape (#2460 round-3 review
 *    F2) — now gated on `SIZE_COMPARISON` (`>`/`>=`).
 *
 * 5. **Population is the DETECTOR's, not the tree's (#4580 r5, shape 69
 *    intake).** `EXEMPT_SITES` is the full, reasoned list of every occurrence
 *    this sweep FLAGS — not every hand-rolled retention in the tree. A
 *    retention whose ordering runs as a statement of its own and whose
 *    removal consumes a count-bounded prefix or suffix through an array API
 *    (`.slice(0, n)`, `.slice(-n)`, `.length = cap`, `.slice(...).forEach(
 *    delete)`) is invisible to every family below, and five such sites are
 *    LIVE today: four bounded evictions and one render view. `UNSEEN_SELECTION_RESIDUALS` names each spelling and each
 *    live site with its policy, and the test below asserts every anchor is
 *    still in the CODE — read from `stripSource`, so a comment or a string
 *    that quotes it is prose, not the site — and still unflagged, so a row can
 *    neither go stale nor claim a site that migrated. Migration stays with the
 *    consolidated audit (#4606); a fifth spelling is not what ends this.
 *
 * Built on tests/support/sweep-kit.ts, same as this repo's other
 * registered-or-fail sweeps. A NEW site this sweep flags must migrate to
 * `BoundedLruCache` or `BoundedFifoMap`, or be added to `EXEMPT_SITES` with a
 * real reason. A new site it cannot see joins `UNSEEN_SELECTION_RESIDUALS`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stableOccurrenceKey,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * Spelling 1: `<container>.keys()/.values()/.entries().next().value` — pull
 * the first entry out of an insertion-ordered container. `.values()` is the
 * `Set` form, `.entries()` the form used when the eviction needs the VALUE
 * too (a compiled query to free, a WASM tree to retire).
 *
 * Matched over the WHOLE blanked source with `\s*` between the chain's tokens,
 * never one line at a time: a formatter wraps a long chain (`x` /
 * `  .values()` / `  .next().value`), and a line-anchored match fails open on
 * the wrapped form — the exact shape-69 hole #4580's first round left, with two
 * live members (`clients/dispatch/fact-store.ts`'s tombstone trim and
 * `clients/lsp/client.ts`'s incremental-text skip policy). `stripSource`
 * preserves layout, so a whole-source match maps back to the line a human
 * reads through {@link lineIndexAt}.
 */
const ITERATOR_HEAD =
	/\.\s*(?:keys|values|entries)\s*\(\s*\)\s*\.\s*next\s*\(\s*\)\s*\.\s*value\b/g;

/**
 * Spelling 2: a `for (const k of container.keys())` walk that breaks out
 * early and deletes — the same evict-oldest intent written as a loop. Both
 * `break` and `.delete(` must appear within {@link FOR_OF_WINDOW} lines of
 * the `for`, because the delete frequently happens AFTER the loop
 * (`debug-handles.ts` assigns the key inside and deletes below it).
 */
const FOR_OF_ITERATOR =
	/\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+[\w$.[\]]+\.(?:keys|values|entries)\(\)\s*\)/;
const FOR_OF_WINDOW = 12;
/**
 * Spelling 3 (#2460 review S1): a BARE `for (const x of container)` — no
 * `.keys()/.values()/.entries()` call at all, because iterating a `Set`
 * directly already yields its values (a `Map` yields `[k, v]` pairs, so this
 * spelling is Set-shaped in practice). The reviewer's probe
 * (`clients/lsp/session-roots.ts`) proved this invisible to both
 * {@link ITERATOR_HEAD} and {@link FOR_OF_ITERATOR}, which both require an
 * explicit accessor call the bare form has no reason to make.
 *
 * The window check below is spelling 2's own: `break`+`.delete(` somewhere in
 * {@link FOR_OF_WINDOW} lines after the `for`. An earlier cut required the
 * delete to name the SAME identifier as the loop variable
 * (`container.delete(loopVar)`), which read as tighter but was both vacuous
 * (dropping it to a generic `.delete(` catches every real fixture this file
 * has) and narrower than spelling 2 — it missed `oldest = v; …
 * set.delete(oldest)` (the deleted name is never the loop variable),
 * `set.delete(oldest!)`, and `set?.delete(oldest)` (#2460 round-3 review F1).
 * Because a bare identifier iteration is common for reasons that have nothing
 * to do with eviction, this spelling ALSO requires a `.size` COMPARISON —
 * not just a `.size` MENTION — within {@link SIZE_LOOP_WINDOW} lines above
 * the `for`, gated to `>`/`>=`, the bounded-loop shape every real eviction
 * site has (`while (set.size > cap)` / `for (...; set.size > cap; ...)`). A
 * bare `.size` mention with no comparison — a log line reporting the current
 * size, or a `size === 0` early-return guard in front of an unconditional
 * single-item drain — is not a bounded loop and must not gate the flag in
 * (#2460 round-3 review F2).
 */
const BARE_FOR_OF_ITERATOR =
	/\bfor\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+[\w$.[\]]+\s*\)/;
const SIZE_LOOP_WINDOW = 6;
const SIZE_COMPARISON = /\.size\s*>=?/;

/**
 * Spelling 4 (#4570, residual of #4503): the iterator RESULT bound to a name,
 * with `.value` read on a LATER line —
 * `const oldest = m.keys().next(); … m.delete(oldest.value);`.
 *
 * This is the spelling the pre-#4503 drift cap used, and it hid from all
 * three spellings above (#4503's fixer probed that file against them and got
 * zero hits): spelling 1 matches `.next().value` on ONE line, and splitting
 * the same two steps across two statements put it out of reach. The issue and
 * the drift cap both call this "spelling 4"; {@link ITERATOR_HEAD} keeps its
 * own docs' "spelling 1" name so the two are not confused.
 *
 * It is matched on the SEMANTIC, not on `.keys()`/`.values()`/`.entries()`:
 * the receiver of `.next()` is any expression ({@link ASSIGNED_NEXT_BINDING}),
 * because requiring one of the three accessor names is itself a spelling
 * enumeration — an aliased container (`const byCall = this.byCall;`) and an
 * indirect accessor (`iteratorOf(m).next()`) are the same eviction and were
 * both green under an accessor-anchored draft (shape 69). The gates that keep
 * it from over-matching are the same two the bare spelling uses: a `.size`
 * COMPARISON in the {@link SIZE_LOOP_WINDOW} lines above (the bounded loop),
 * and, inside {@link FOR_OF_WINDOW} lines below, BOTH a `.delete(` and a read
 * of the bound name's own `.value` — so a peek that never evicts
 * (`clients/latency-logger.ts` `getCurrentPhase`) and a bounded loop that
 * deletes an unrelated key are not members. `.value` is required as the bound
 * name's OWN property, not as the delete's argument, so a value reached
 * through a second binding (`const victim = oldest.value; m.delete(victim)`) —
 * the third shape-69 plant — still flags.
 *
 * Matched over the whole blanked source (#4580 review F3): the binding may be
 * declared ABOVE the loop and re-assigned inside it ({@link
 * REASSIGNED_NEXT_BINDING}), and a formatter may break the line right after
 * `=`, so the receiver stretch cannot exclude newlines. `[^;{}=]` keeps the
 * receiver inside one statement, and refuses an `=` so an arrow function's
 * body is not swallowed as the receiver.
 */
/**
 * Spelling 4 covers a binding DECLARED on the same line, RE-ASSIGNED inside
 * the loop after a declaration above, and one whose declaration carries a type
 * annotation (#4580 review F3). One pattern serves all three: anchoring on
 * `const|let|var` missed the re-assignment, and keeping a declaration family
 * beside a re-assignment family left the plain form double-covered — a
 * mutation that neutered one family left every case green through the other.
 * The name is any JS identifier (`[\w$]+`, so `$`-initial names are in the
 * population), and the lookbehind refuses a property or index target
 * (`this.oldest = …`, `arr[oldest] = …`).
 *
 * Matched over the whole blanked source (#4580 review F3): the receiver
 * stretch is `[^;{}=]`, which crosses a formatter's line break (the
 * multi-line binding) but stays inside one statement and refuses an `=`, so an
 * arrow function's body is not read as the receiver.
 */
const BOUND_NEXT_BINDING =
	/(?<![\w$.])([\w$]+)\s*(?::[^=;\n]+)?=(?!=)\s*[^;{}=]*?\.next\s*\(\s*\)/g;

/**
 * Spelling 5 (#4580 review F3): array destructuring — `const [oldest] =
 * m.keys(); … m.delete(oldest);` — the key itself is the victim, so the window
 * gate is a `.delete(` plus a use of the destructured name, not a `.value`
 * read. The tree's one spread-destructure is a peek (`fieldCounts.size !== 1`,
 * no removal), which fails both gates.
 *
 * The right-hand side is ANY expression, not one of the three accessor calls:
 * requiring a literal accessor is the shape-69 mistake again, and
 * `const [oldest] = iteratorOf(m)` (an accessor behind a helper) is the same
 * eviction. The bound-victim gates carry the precision instead.
 */
const DESTRUCTURED_ITERATOR_BINDING =
	/\b(?:const|let|var)\s*\[\s*([\w$]+)(?:\s*,\s*[\w$]+)?\s*\]\s*=(?!=)\s*[^;{}=]*?/g;

/**
 * Comparator ordering is independent of its receiver (#4580 r3, shape 69).
 * Read a balanced initializer, rather than enumerating source/transform calls:
 * spread, Array.from, aliases and filter/map/slice chains all reach the same
 * sort/toSorted operation. Selection and cap evidence are separate stages.
 */
const ORDERED_BINDING =
	/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;\n]+)?=(?!=)\s*/g;
const ORDER_CALL = /\.\s*(?:sort|toSorted)\s*\(/g;
// A cap may be expressed positively, on length, or by its early-return
// complement (occupied < ceiling). This is lexical evidence, not data flow.
const CAP_COMPARISON =
	/(?:\.(?:size|length)\s*[<>]=?|[\w$.]+\s*[<>]=?\s*[\w$.(])/;

/** End of a balanced initializer or call in comment/string-blanked source. */
function balancedEnd(source: string, start: number, call = false): number {
	let depth = call ? 1 : 0;
	for (let index = start; index < source.length; index++) {
		const token = source[index];
		if (token === ";" && depth === 0) return index;
		if (token === "(" || token === "[" || token === "{") depth++;
		if (token === ")" || token === "]" || token === "}") {
			depth--;
			if (depth < 0 || (call && depth === 0)) return index + 1;
		}
	}
	return source.length;
}

/** Follow local ordered-sequence provenance through transforms and aliases. */
function selectsBinding(text: string, name: string): boolean {
	const sequences = new Set([name]);
	// Initializers are visited in source order, so a derived binding can itself
	// feed the next alias. Cross-function and reassigned aliases remain residual.
	for (const binding of text.matchAll(ORDERED_BINDING)) {
		const start = (binding.index ?? 0) + binding[0].length;
		const receiver = /^([\w$]+)\s*(?=\.|;|$)/.exec(text.slice(start));
		if (receiver && sequences.has(receiver[1] ?? ""))
			sequences.add(binding[1] ?? "");
	}
	for (const token of text.matchAll(IDENTIFIER_TOKEN)) {
		if (!sequences.has(token[0])) continue;
		let cursor = (token.index ?? 0) + token[0].length;
		// Skip balanced transform calls instead of requiring selection adjacent
		// to sorting: filter/map callbacks may contain nested calls or semicolons.
		while (cursor < text.length) {
			const tail = text.slice(cursor);
			if (/^\s*\[/.test(tail)) return true;
			const method = /^\s*\.\s*([\w$]+)\s*\(/.exec(tail);
			if (!method) break;
			if (/^(?:find|at|shift|pop)$/.test(method[1] ?? "")) return true;
			cursor = balancedEnd(text, cursor + method[0].length, true);
		}
	}
	for (const loop of text.matchAll(
		/\bfor\s*\([^;]*?\bof\s+([\w$]+)\s*\)\s*\{/g,
	)) {
		if (!sequences.has(loop[1] ?? "")) continue;
		const start = (loop.index ?? 0) + loop[0].length;
		const body = text.slice(start, balancedEnd(text, start, true));
		if (/\.\s*(?:delete|splice)\s*\(/.test(body)) return true;
	}
	return false;
}

/** 0-based start offset of every line, for offset→line mapping. */
function lineStartOffsets(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

/** The 0-based line index holding `offset`, by binary search over `starts`. */
function lineIndexAt(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((starts[mid] ?? 0) <= offset) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** The stripped source {@link FOR_OF_WINDOW} lines below `index`. */
function windowBelow(lines: readonly string[], index: number): string {
	return lines.slice(index + 1, index + 1 + FOR_OF_WINDOW).join("\n");
}

/** The stripped source {@link SIZE_LOOP_WINDOW} lines above `index`. */
function windowAbove(lines: readonly string[], index: number): string {
	return lines.slice(Math.max(0, index - SIZE_LOOP_WINDOW), index).join("\n");
}

const IDENTIFIER_TOKEN = /[\w$]+/g;
const VALUE_READ = /([\w$]+)\s*\??\.\s*value\b/g;

/** True when `text` uses `name` as a whole identifier. */
function mentionsIdentifier(text: string, name: string): boolean {
	for (const token of text.matchAll(IDENTIFIER_TOKEN)) {
		if (token[0] === name) return true;
	}
	return false;
}

/**
 * True when `text` reads `name`'s own `.value`. The read is compared by NAME
 * against the binding it belongs to (#4580 review F2, Greptile P2): splicing
 * the name into a `\b`-anchored regex both failed open on a `$`-initial name —
 * `\b` cannot precede `$` — and left a backslash-escaping path CodeQL flagged.
 */
function readsOwnValue(text: string, name: string): boolean {
	for (const read of text.matchAll(VALUE_READ)) {
		if (read[1] === name) return true;
	}
	return false;
}

function flagsAssignedEviction(
	lines: readonly string[],
	index: number,
	boundName: string,
): boolean {
	const below = windowBelow(lines, index);
	if (!/\.delete\(/.test(below)) return false;
	if (!SIZE_COMPARISON.test(windowAbove(lines, index))) return false;
	return readsOwnValue(below, boundName);
}

function flagsDestructuredEviction(
	lines: readonly string[],
	index: number,
	boundName: string,
): boolean {
	const below = windowBelow(lines, index);
	if (!/\.delete\(/.test(below)) return false;
	if (!SIZE_COMPARISON.test(windowAbove(lines, index))) return false;
	return mentionsIdentifier(below, boundName);
}

/** The one file allowed to spell the idiom: the canonical implementation. */
const DEFINITION_FILE = "clients/bounded-cache.ts";

/**
 * `stableOccurrenceKey` output (`path#enclosingSymbol:contentHash`, or
 * `path#contentHash` with no enclosing symbol) → why this exact occurrence
 * stays hand-rolled.
 *
 * Every entry is a container shape neither bounded class covers. There are no
 * "deferred" entries left: #2442's review round migrated the three
 * `clients/review-graph/*` sites (their stated owner, the build-latch fix,
 * merged as #2446) and the four eviction-side-effect sites in
 * `tree-sitter-cache.ts` / `tree-sitter-client.ts`, which is what
 * `set()`'s `[key, value]` return exists for.
 *
 * Keys were migrated from `path:line` to `stableOccurrenceKey` by #2475. When
 * a genuine edit to the flagged line itself invalidates a key (not a line
 * inserted elsewhere — that's the churn this migration removes), the failing
 * test's `audit.problems` output prints the new key the scan now computes;
 * paste it in.
 */
const EXEMPT_SITES: Readonly<Record<string, string>> = {
	"clients/widget-state.ts#pruneInactiveFileRecords:15adad3b":
		"Only inactive files with no live diagnostic qualify; touchedAt orders " +
		"multiple victims until the soft cap is met. Neither bounded class " +
		"expresses eligibility partition plus external recency (document-drift class).",
	"clients/lsp/index.ts#LSPService:2676aced":
		"Frozen LSP source (#4580 r4): markTouched maintains write recency by " +
		"delete/set and trims oldest-first; reads must not promote. BoundedFifoMap " +
		"fits this count cap, but migration is deferred under the explicit LSP freeze.",
	"clients/slow-fs.ts#median:c93fd2b8":
		"Non-member: sorted sample indices calculate a median without removing " +
		"any source entry. The lexical cap/selection census deliberately overmatches.",
	"scripts/bench-word-index-replacement.mjs#run:c93fd2b8":
		"Non-member: sorted benchmark samples calculate percentiles; no source " +
		"entry is evicted. A nearby comparison is lexical evidence only.",

	"clients/lsp/document-drift.ts#DocumentDriftTracker:add9342e":
		"Not evict-OLDEST (#4503): the walk SKIPS every record whose document a " +
		"live server still holds and evicts the oldest one nobody holds, because " +
		"dropping a held document's record leaves its stale view with nothing " +
		"comparing disk against it. When every record is held, nothing is evicted " +
		"at all. BoundedFifoMap can only drop its head, so it cannot express a " +
		"skip-held victim policy, and growing it a skip policy to serve one caller " +
		"is the same trade the debug-handles entry above already declined.",
	"clients/debug-handles.ts#recordTrackedInit:3737b5dc":
		"Not evict-OLDEST: this walk deliberately SKIPS the first " +
		"TRACKER_PROTECTED_COUNT insertion-order entries and evicts the " +
		"oldest one after them, so the earliest-created handles (the ones " +
		"most likely to be the leak under investigation) are never the ones " +
		"dropped. A protected prefix is a policy neither BoundedFifoMap nor " +
		"BoundedLruCache expresses, and encoding it into a shared primitive " +
		"for one debug-only caller is not worth the surface.",
	"clients/lsp/client.ts#recordSentContent:05851f19":
		"Not evict-OLDEST (#4580 round 2, family 1 with the accessor chain " +
		"wrapped across lines): the loop is bounded on TWO axes at once " +
		"(retained entries and retained bytes) and SKIPS every path whose " +
		"binding no longer carries text before either counter moves, so it drops " +
		"the oldest TEXT-BEARING path. Neither bounded class holds a second axis " +
		"or a skip policy, and growing BoundedFifoMap one to serve this single " +
		"caller is the trade the two entries above already declined.",
	"clients/review-graph/builder.ts#setWorkspaceGraph:5d6480b6":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by an explicitly maintained `lastUsedAt`, and the " +
		"eviction clears the entry's armed idle timer. `BoundedLruCache` promotes " +
		"on `get`, which these caches do NOT do through their equality-checking " +
		"reads, so adopting it would change which entry is evicted under a " +
		"read-only workload; no bounded class carries an external recency stamp " +
		"or a per-entry timer.",
	"clients/dispatch/integration.ts#setReverseDepsEntry:cfec6940":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the explicitly maintained `lastUsedAt` that " +
		"`touchReverseDepsEntry` stamps, and the eviction clears the entry's " +
		"armed idle timer. `BoundedLruCache`'s `get` would promote on the " +
		"equality-checking reads this cache makes, changing eviction order; no " +
		"bounded class carries an external recency stamp or a per-entry timer.",
	"clients/project-snapshot.ts#enforceAuthoritativeSnapshotCap:c15ce8a2":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the explicitly maintained `lastUsedAt`, and the " +
		"eviction must clear the single timer `scheduleAuthoritativeSnapshotEviction` " +
		"armed for it. `BoundedLruCache` would promote on `get`, which this " +
		"cache's equality-checking reads must not do; no bounded class carries an " +
		"external recency stamp or a per-entry timer.",
	"clients/workspace-topology.ts#getDirectoryMarkers:d43899c7":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the `lastUsedAt` that `touchDirMarker` stamps, " +
		"and `deleteDirMarker` must clear that entry's idle timer. " +
		"`BoundedLruCache`'s `get` would promote on reads this cache makes without " +
		"touching the stamp, changing eviction order; no bounded class carries an " +
		"external recency stamp or a per-entry timer.",
	"clients/workspace-topology.ts#walkToNearestMatch:79da3cc7":
		"Not a bounded class's recency (#4580 round 2, comparator family): the " +
		"victim is the oldest by the `lastUsedAt` that `touchWalk` stamps, and " +
		"`deleteWalk` must clear that entry's idle timer. `BoundedLruCache`'s " +
		"`get` would promote on reads this cache makes without touching the " +
		"stamp, changing eviction order; no bounded class carries an external " +
		"recency stamp or a per-entry timer.",
	"clients/read-guard.ts#ReadGuard:61e2665a":
		"Consumed reads are evicted first, ordered by the separately maintained " +
		"fileLastUsed stamp. evictFile removes read/authorship/last-used state. " +
		"Neither bounded class expresses this eligibility partition plus external recency.",
	"clients/read-guard.ts#ReadGuard:fe37c09d":
		"Unconsumed reads are the second eligibility partition, ordered by " +
		"fileLastUsed only after consumed eviction. evictFile clears associated " +
		"read/authorship state; a single FIFO/LRU container cannot encode the two passes.",
	"clients/mcp/analyze.ts#enforceWarmWordIndexLruCap:625c660e":
		"Only unleased warm roots may be evicted; lastUsedAt orders eligible roots " +
		"and evictWarmWordIndex performs retirement. Neither bounded class has " +
		"lease eligibility plus explicitly maintained recency.",
	"clients/lsp/client-registry.ts#ClientRegistry:4d17a873":
		"Frozen LSP member: adopted roots are ordered by explicit recency, " +
		"excluding the root just normalized. Eviction also retires that root's " +
		"adopted clients. Neither bounded class expresses protected-root selection.",
	"clients/lsp/client-registry.ts#ClientRegistry:4fd64a7c":
		"Frozen LSP member: ceiling capacity counts live and in-flight clients. " +
		"Only alive, idle, unleased clients other than the requested key qualify; " +
		"the victim must be shut down asynchronously. A bounded map cannot own " +
		"that eligibility or shutdown lifecycle.",

	"scripts/check-pr-body.mjs#testCorpus:9825b2b8":
		"Tooling-only FIFO corpus memo; importing the shipped clients container " +
		"would cross the script/runtime dependency boundary. This admission names " +
		"one pre-existing bounded script cache, not a shipped runtime policy.",
	"scripts/lib/lockfile-completeness.mjs#firstKeyChange:09f44dde":
		"Non-member: selects the first sorted set difference only to render a " +
		"lockfile diagnostic. It never evicts or mutates the source collections. " +
		"The lexical comparator gate deliberately overmatches this length check.",
};

/**
 * The selection spellings `findEvictionLines` cannot see, and the live sites
 * that use them (#4580 r5 F1/F2).
 *
 * This is the intake for shape 69 on this seam: the detector follows ordering
 * that reaches an element, an iterator, a for-of loop, or a removal API. It
 * does not follow ordering that finishes as a value and is then truncated by
 * an array API in a later statement — that is the file header's stated
 * in-place limit, and these are its live members. Each row carries an
 * executable plant (the miss is asserted, not described) and every live site
 * carries the policy that keeps it hand-rolled, plus an exact anchor the test
 * below re-reads from the real file. A detector round that starts catching one
 * of these spellings reds this table's assertions, which is the point: the row
 * must then be deleted or migrated, never left as a stale claim of a miss.
 */
const UNSEEN_SELECTION_RESIDUALS: Readonly<
	Record<
		string,
		{
			/** Why this spelling is invisible, and what would have to change. */
			readonly limit: string;
			/** Executable witness of the miss, through the real detector. */
			readonly plant: string;
			/** Live sites, each re-read and re-probed by the accounting test. */
			readonly live: readonly {
				readonly file: string;
				readonly anchor: string;
				/**
				 * Count of occurrences this sweep DOES flag elsewhere in the same file.
				 * Known limit (#4580 r6 F4): a total, not a set, so one new flagged
				 * occurrence replacing an old one keeps this pin satisfied; the
				 * exempted-key audit below is what rejects an unadmitted one.
				 */
				readonly detectedElsewhere: number;
				readonly policy: string;
			}[];
		}
	>
> = {
	"in-place sort, then a count prefix deleted one victim at a time": {
		limit:
			"`candidates.sort(cmp)` is one statement and the removal is the next, " +
			"so no ordered binding reaches a selection the detector follows. The " +
			"live sgconfig site is invisible twice over: its sort is not even in " +
			"a binding, and its victims are `.slice(0, over)` entries of the " +
			"sorted ARRAY, not of a container the sweep could re-derive.",
		plant: `if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 for (const victim of ranked.slice(0, over)) {
  m.delete(victim);
 }`,
		live: [
			{
				file: "clients/sgconfig.ts",
				anchor: "for (const candidate of candidates.slice(0, over)) {",
				detectedElsewhere: 0,
				policy:
					"Baseline artifacts on DISK, not map entries: eligibility is a " +
					"keep-set plus mtime recency over directory entries, the victim is " +
					"deleted with `rmSync`, and its cached baseline is retired. No " +
					"bounded class owns a filesystem directory.",
			},
		],
	},
	"in-place sort, then a count prefix RETAINED and rebuilt": {
		limit:
			"The survivors are a count prefix of the sorted array, rebuilt into a " +
			"fresh object, and the victims never appear in a selection " +
			"expression. The live cache-manager site also sorts in place, outside " +
			"any binding.",
		plant: `if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 const kept = Object.fromEntries(ranked.slice(0, MAX_PARTITIONS));`,
		live: [
			{
				file: "clients/cache-manager.ts",
				anchor: "liveEntries.slice(0, MAX_TURN_SESSION_PARTITIONS),",
				detectedElsewhere: 0,
				policy:
					"Persisted turn-state partitions: eligibility is the TTL filter, " +
					"order is the stored `lastUpdated` stamp, and the survivors are " +
					"rebuilt with `Object.fromEntries` and written back to a JSON " +
					"cache. No bounded class owns a persisted record with external " +
					"recency.",
			},
		],
	},
	"in-place sort, then a count SUFFIX retained": {
		limit:
			"The tail form truncates from the other end of the same sorted array, " +
			"so it is the same two-statement shape and just as invisible.",
		plant: `if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 const bounded = ranked.slice(-MAX_TOOLS);`,
		live: [
			{
				file: "clients/mutation-attribution.ts",
				anchor: "const bounded = tools.slice(-MUTATION_ATTRIBUTION_MAX_TOOLS);",
				detectedElsewhere: 0,
				policy:
					"Persisted tool records: the cap keeps the freshest `lastSeen` " +
					"tail of a JSON record and writes the survivors back to disk. No " +
					"bounded class owns a persisted record keyed by an external " +
					"recency stamp, and the file rewrite is the point of the block.",
			},
		],
	},
	"in-place sort, then `.length = cap`": {
		limit:
			"Truncating the sorted array in place has no selection expression at " +
			"all, so there is nothing for the element, iterator, or removal stages " +
			"to match after the ordering statement.",
		plant: `if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 ranked.length = MAX_RETAINED;`,
		live: [
			{
				file: "clients/widget-state.ts",
				anchor: "retained.length = MAX_RETAINED_SUPPRESSED_PER_FILE;",
				detectedElsewhere: 1,
				policy:
					"Per-file suppressed-row retention ordered by the stored " +
					"`observedAt`, with one degradation record per capped file and " +
					"re-emitted retained rows. External recency plus a degradation " +
					"record no bounded class carries; the sibling policy in the same " +
					"file is already an exemption.",
			},
		],
	},
	"`.slice(0, n)` over an inline-ordered sequence, kept as a capped view": {
		limit:
			"The selection is a retained VIEW of a ranked array, not a removal from " +
			"a stored container, so it is a non-member of the family even though the " +
			"shape is the same. It still needs a row: the next reader must not " +
			"mistake a silent absence for the sweep having judged it.",
		plant: `if (nodes.size <= CAP) return;
 const ranked = [...nodes.keys()].sort(cmp);
 const keep = new Set(ranked.slice(0, maxNodes));`,
		live: [
			{
				file: "clients/lens-map.ts",
				anchor: "keepIds = new Set(ranked.slice(0, maxNodes));",
				detectedElsewhere: 0,
				policy:
					"Non-member: a degree-ranked render view capped for output " +
					"(#679). Nothing is evicted from a stored container — the graph " +
					"keeps every file — so no bounded class applies.",
			},
		],
	},
	"`.slice(...).forEach(delete)`": {
		limit:
			"Removing each victim through a `forEach` callback over the prefix is " +
			"the same two-statement shape as the `for-of` row above; a callback is " +
			"not a removal the loop stage follows.",
		plant: `if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 ranked.slice(0, over).forEach((victim) => {
  m.delete(victim);
 });`,
		// No live member as of #4580 r5; the row exists so the next one is
		// recognised instead of rediscovered.
		live: [],
	},
};

/**
 * 1-based line numbers where `anchor` survives as CODE in `source`.
 *
 * Stripped first, like every other read in this file: `stripSource` blanks
 * comments, strings, and regex bodies while preserving layout, so the numbers
 * still map to the raw file a human reads (#4580 r6 F1 — reading raw text let
 * one comment quoting the anchor keep a stale row alive and green).
 */
function liveAnchorLines(source: string, anchor: string): number[] {
	return stripSource(source)
		.split("\n")
		.flatMap((line, index) => (line.includes(anchor) ? [index + 1] : []));
}

function shippedSourceFiles(): string[] {
	const files = ["clients", "tools", "mcp", "scripts", "tests/support"].flatMap(
		(dir) => {
			const abs = path.join(REPO_ROOT, dir);
			return fs.existsSync(abs)
				? listSourceFiles(abs, {
						extensions: [".ts", ".mjs", ".js"],
						skipTests: true,
					}).filter(
						(file) =>
							!file.endsWith(".js") ||
							!fs.existsSync(file.slice(0, -3) + ".ts"),
					)
				: [];
		},
	);
	const indexTs = path.join(REPO_ROOT, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files;
}

/** Every hand-rolled eviction in one file, as 1-based line numbers. */
export function findEvictionLines(stripped: string): number[] {
	const lines = stripped.split("\n");
	const starts = lineStartOffsets(stripped);
	const hits = new Set<number>();

	// The accessor-chain and bound-victim families are matched over the WHOLE
	// blanked source, so a formatter's line break inside the chain, after `=`, or
	// between the statement and its `.value` cannot hide the eviction (#4580
	// review F1/F3). Each match maps back to the line it starts on.
	for (const match of stripped.matchAll(ITERATOR_HEAD)) {
		hits.add(lineIndexAt(starts, match.index ?? 0) + 1);
	}
	const boundVictimFamilies = [
		{ pattern: BOUND_NEXT_BINDING, flags: flagsAssignedEviction },
		{
			pattern: DESTRUCTURED_ITERATOR_BINDING,
			flags: flagsDestructuredEviction,
		},
	];
	for (const { pattern, flags } of boundVictimFamilies) {
		for (const match of stripped.matchAll(pattern)) {
			const index = lineIndexAt(starts, match.index ?? 0);
			if (flags(lines, index, match[1] ?? "")) hits.add(index + 1);
		}
	}

	for (const binding of stripped.matchAll(ORDERED_BINDING)) {
		const index = lineIndexAt(starts, binding.index ?? 0);
		const name = binding[1] ?? "";
		const start = (binding.index ?? 0) + binding[0].length;
		const end = balancedEnd(stripped, start);
		const expression = stripped.slice(start, end);
		const endIndex = lineIndexAt(starts, end);
		const below = windowBelow(lines, endIndex);
		if (!CAP_COMPARISON.test(windowAbove(lines, index))) continue;
		if (!mentionsIdentifier(below, name)) continue;
		for (const order of expression.matchAll(ORDER_CALL)) {
			const close = balancedEnd(
				expression,
				(order.index ?? 0) + order[0].length,
				true,
			);
			if (
				selectsBinding(
					`const ${name} = __ordered${expression.slice(close)};`,
					"__ordered",
				) ||
				selectsBinding(below, name)
			) {
				hits.add(index + 1);
			}
		}
	}

	// The two `for…of` families stay line-anchored: their `for` header is one
	// line by construction and each is gated on its own window.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		if (FOR_OF_ITERATOR.test(line)) {
			const window = lines.slice(i + 1, i + 1 + FOR_OF_WINDOW).join("\n");
			if (/\bbreak\b/.test(window) && /\.delete\(/.test(window))
				hits.add(i + 1);
			continue;
		}

		if (BARE_FOR_OF_ITERATOR.test(line)) {
			const window = lines.slice(i + 1, i + 1 + FOR_OF_WINDOW).join("\n");
			const precedingWindow = lines
				.slice(Math.max(0, i - SIZE_LOOP_WINDOW), i)
				.join("\n");
			if (
				/\bbreak\b/.test(window) &&
				/\.delete\(/.test(window) &&
				SIZE_COMPARISON.test(precedingWindow)
			) {
				hits.add(i + 1);
			}
		}
	}
	return [...hits].sort((a, b) => a - b);
}

/** One flagged occurrence: its stable key plus a `file:line` diagnostic detail. */
interface FlaggedOccurrence {
	key: string;
	detail: string;
}

function findFlaggedOccurrences(): {
	occurrences: FlaggedOccurrence[];
	scanned: number;
} {
	const files = shippedSourceFiles();
	const occurrences: FlaggedOccurrence[] = [];
	for (const abs of files) {
		const rel = relativePosix(REPO_ROOT, abs);
		if (rel === DEFINITION_FILE) continue;
		// Strip first: an idiom named only in a comment or a string is not one.
		// Layout is preserved, so these line numbers (and the hash inputs derived
		// from them) match the raw source.
		const stripped = stripSource(fs.readFileSync(abs, "utf8"));
		const lines = stripped.split("\n");
		for (const line of findEvictionLines(stripped)) {
			occurrences.push({
				key: stableOccurrenceKey(
					rel,
					lines.map((text, index) => {
						// Same first line, different eligibility policy (#4580 r3):
						// hash the complete declaration, not its formatter's first line.
						if (index !== line - 1 || !/^\s*(?:const|let|var)\b/.test(text))
							return text;
						const start = lineStartOffsets(stripped)[index] ?? 0;
						return stripped
							.slice(start, balancedEnd(stripped, start))
							.replace(/\s+/g, " ");
					}),
					line - 1,
				),
				detail: `${rel}:${line}`,
			});
		}
	}
	return { occurrences, scanned: files.length };
}

describe("#2442 no new hand-rolled evict-oldest idiom outside bounded-cache.ts", () => {
	const { occurrences, scanned } = findFlaggedOccurrences();
	const flagged = occurrences.map((o) => o.key);

	it("actually finds the family (a dead scan must not read as clean)", () => {
		// The registered population includes runtime eviction policies and two
		// tooling matches. The registry audit below rejects missing/stale entries.

		expect(flagged.length).toBeGreaterThanOrEqual(1);
	});

	it("detects all four earlier spellings, not just `.keys().next().value`", () => {
		// Mutation guard on the DETECTOR itself (#2442 review F5): the first
		// draft matched one spelling and silently missed the other two. Each
		// fixture below is a real shape found in this tree.
		expect(findEvictionLines("const a = m.keys().next().value;")).toEqual([1]);
		expect(findEvictionLines("const b = s.values().next().value;")).toEqual([
			1,
		]);
		expect(findEvictionLines("const c = m.entries().next().value;")).toEqual([
			1,
		]);
		expect(
			findEvictionLines(
				["for (const k of m.keys()) {", "  m.delete(k);", "  break;", "}"].join(
					"\n",
				),
			),
		).toEqual([1]);
		// A plain iteration that neither breaks nor deletes is NOT an eviction.
		expect(
			findEvictionLines(
				["for (const k of m.keys()) {", "  total += k;", "}"].join("\n"),
			),
		).toEqual([]);
		// Spelling 4 (#2460 review S1): a BARE `for (const x of set)` — no
		// `.keys()/.values()/.entries()` call at all, because iterating a `Set`
		// directly already yields its values. The reviewer planted this exact
		// shape in `clients/lsp/session-roots.ts` and it passed the sweep
		// silently — ITERATOR_HEAD and FOR_OF_ITERATOR both require an explicit
		// accessor call. This spelling also requires a `.size`-bounded loop
		// around it, so an ordinary `for...of` walk that happens to `break` and
		// `delete` an unrelated key elsewhere is not misread as an eviction.
		expect(
			findEvictionLines(
				[
					"while (set.size > cap) {",
					"  for (const oldest of set) {",
					"    set.delete(oldest);",
					"    break;",
					"  }",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		// Bare for-of with no size-bounded loop around it, and no break/delete
		// of the loop variable, is NOT an eviction.
		expect(
			findEvictionLines(
				["for (const x of set) {", "  total += x;", "}"].join("\n"),
			),
		).toEqual([]);
		// Bare for-of that breaks+deletes but is NOT inside a `.size` loop is not
		// flagged by this spelling either — it needs a real bounded-eviction
		// shape, not just any early-exit delete.
		expect(
			findEvictionLines(
				[
					"for (const oldest of set) {",
					"  set.delete(oldest);",
					"  break;",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});

	// (#2460 round-3 review F1) The first cut required the bare form's delete to
	// name the EXACT loop variable (`container.delete(loopVar)`), which is both
	// vacuous (dropping it to a generic `.delete(` still catches every fixture
	// above) and narrower than spelling 2's own `break`+`.delete(` window check
	// — so it missed three real shapes below. Each fixture is wrapped in a
	// `.size`-bounded loop so only the pair-narrowing is under test.

	it("bare form catches assign-inside/delete-below, where the deleted identifier is never the loop variable (#2460 round-3 review F1)", () => {
		// The deleted identifier ("oldest") is never the loop variable ("v") at
		// all, so a same-pair check can never match this shape regardless of
		// syntax — this is the fixture that most directly proves the narrowing
		// itself must go, not just be patched around.
		expect(
			findEvictionLines(
				[
					"while (set.size > cap) {",
					"  let oldest;",
					"  for (const v of set) {",
					"    oldest = v;",
					"    break;",
					"  }",
					"  if (oldest !== undefined) set.delete(oldest);",
					"}",
				].join("\n"),
			),
		).toEqual([3]);
	});

	it("bare form catches a non-null-asserted delete of the loop variable (#2460 round-3 review F1)", () => {
		// `oldest!` is not the bare identifier `oldest` the old regex demanded
		// immediately before `)`.
		expect(
			findEvictionLines(
				[
					"while (set.size > cap) {",
					"  for (const oldest of set) {",
					"    set.delete(oldest!);",
					"    break;",
					"  }",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
	});

	it("bare form catches an optional-chain delete (#2460 round-3 review F1)", () => {
		// `set?.delete(` is not the literal `set.delete(` the old regex demanded.
		expect(
			findEvictionLines(
				[
					"while (set.size > cap) {",
					"  for (const oldest of set) {",
					"    set?.delete(oldest);",
					"    break;",
					"  }",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
	});

	// (#2460 round-3 review F2) The bare form's `.size` gate matched a bare
	// mention, not a comparison, so a break+delete pair with nothing to do with
	// bounded eviction rode through on an unrelated `.size` reference nearby.

	it("bare form does NOT flag a break+delete guarded only by a `.size` log line above (#2460 round-3 review F2)", () => {
		// find-first-match (a predicate, not evict-oldest) with a `.size` log
		// line above it must not be misread as the bounded-eviction shape.
		expect(
			findEvictionLines(
				[
					"function removeFirstMatch(set, pred) {",
					"  console.log(`size=${set.size}`);",
					"  for (const item of set) {",
					"    if (pred(item)) {",
					"      set.delete(item);",
					"      break;",
					"    }",
					"  }",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("bare form does NOT flag a break+delete guarded only by a `size === 0` early return (#2460 round-3 review F2)", () => {
		// A `size === 0` early-return guard above an unconditional single-item
		// drain is a `.size` mention too, but it is not a bounded LOOP — the
		// drain runs once regardless of size, it does not loop "while too big".
		expect(
			findEvictionLines(
				[
					"function drainOne(set) {",
					"  if (set.size === 0) return;",
					"  for (const item of set) {",
					"    set.delete(item);",
					"    break;",
					"  }",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});

	// (#4570, residual of #4503) The fifth spelling: the iterator RESULT bound to
	// a name, with `.value` read on a LATER line. This is the shape #4503's
	// pre-fix drift cap used — `while (this.synced.size > DRIFT_TRACK_CAP) {
	// const oldest = this.synced.keys().next(); if (oldest.done) break;
	// this.synced.delete(oldest.value); }` — and a probe of that file against
	// the three spellings above returned ZERO hits, so the sweep stayed green
	// on the exact defect it exists to catch. `.next().value` on ONE line is
	// spelling 1; splitting it across two statements is what hid it.

	it("detects the assigned `.next()` spelling the pre-#4503 drift cap used, #4570", () => {
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const oldest = m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		// All three accessors, and a `.done`-guarded `return` rather than
		// `break` (clients/test-runner-delivery.ts's prunePending).
		for (const accessor of ["keys", "values", "entries"]) {
			expect(
				findEvictionLines(
					[
						"while (s.size > CAP) {",
						`  const head = s.${accessor}().next();`,
						"  if (head.done) return;",
						"  s.delete(head.value);",
						"}",
					].join("\n"),
				),
				`accessor ${accessor}`,
			).toEqual([2]);
		}
	});

	// Shape-69 detector plants (#4570): an alias, an indirect call, and a value
	// reached through another binding. Each is a spelling nobody wrote the
	// matcher against, and each must flag through the real detector.
	it("flags a value reached through another binding, the #4570 shape-69 plant", () => {
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const oldest = m.keys().next();",
					"  if (oldest.done) break;",
					"  const victim = oldest.value;",
					"  m.delete(victim);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
	});

	it("flags an aliased container and an indirectly called next(), the #4570 shape-69 plants", () => {
		// Alias: the iterator is taken off a local binding, not the field.
		expect(
			findEvictionLines(
				[
					"const byCall = this.checkedPathsByCall;",
					"while (byCall.size > CAP) {",
					"  const oldest = byCall.keys().next();",
					"  if (oldest.done) break;",
					"  byCall.delete(oldest.value);",
					"}",
				].join("\n"),
			),
		).toEqual([3]);
		// Indirect call: the accessor is behind a helper, so the receiver of
		// `.next()` is a call expression, not `<container>.keys()`.
		expect(
			findEvictionLines(
				[
					"const iteratorOf = (container) => container.keys();",
					"while (m.size > CAP) {",
					"  const oldest = iteratorOf(m).next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value);",
					"}",
				].join("\n"),
			),
		).toEqual([3]);
	});

	it("does NOT flag a peek that never deletes, the getCurrentPhase case", () => {
		// The real non-member: `getCurrentPhase` reads the oldest live bracket to
		// answer "which phase is open" — no cap loop, no delete.
		expect(
			findEvictionLines(
				[
					"export function getCurrentPhase(): PhaseToken | undefined {",
					"  const oldest = liveBrackets.keys().next();",
					"  return oldest.done ? undefined : oldest.value;",
					"}",
				].join("\n"),
			),
		).toEqual([]);
		// A bounded loop that peeks but deletes only an unrelated key is a
		// peek-and-clean, not an eviction of the first-inserted entry.
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const oldest = m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(other.key);",
					"}",
				].join("\n"),
			),
		).toEqual([]);
	});

	// (#4580 review F1) The accessor chain is matched over the WHOLE blanked
	// source, so a formatter that wraps it cannot hide the eviction. Two live
	// members were invisible to the line-anchored matcher: the session-fact
	// tombstone trim and the LSP incremental-text skip policy.
	it("flags an accessor chain the formatter wrapped across lines, #4580 review F1", () => {
		expect(
			findEvictionLines(
				[
					"const oldestTombstone = this.evictedSessionFactKeys",
					"  .values()",
					"  .next().value;",
				].join("\n"),
			),
		).toEqual([2]);
		// The LSP member wraps after an optional-chain receiver.
		expect(
			findEvictionLines(
				[
					"const oldestPath = state.incrementalTextBearingPaths",
					"  ?.values()",
					"  .next().value;",
				].join("\n"),
			),
		).toEqual([2]);
	});

	// (#4580 review F2, Greptile P2) A JS identifier may start with `$`, so the
	// value read is compared by name against the binding it belongs to instead
	// of being spliced into a `\b`-anchored regex, where `\b` cannot precede `$`.
	it("flags a `$`-initial binding name, #4580 review F2", () => {
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const $oldest = m.keys().next();",
					"  if ($oldest.done) break;",
					"  m.delete($oldest.value);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		// A defensive optional chain on the value read is the same eviction.
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const oldest = m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest?.value);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
	});

	// (#4580 review F3) Iterator destructuring: the victim is the destructured
	// binding itself, so the window needs a `.delete(` and a use of that name.
	it("flags iterator destructuring, #4580 review F3", () => {
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const [oldest] = m.keys();",
					"  m.delete(oldest);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const [key, value] = m.entries();",
					"  m.delete(key);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		// An accessor behind a helper is the same destructured victim (#4580
		// round 2 review: naming the three accessors left this one green).
		expect(
			findEvictionLines(
				[
					"const iteratorOf = (container) => container.keys();",
					"while (m.size > CAP) {",
					"  const [oldest] = iteratorOf(m);",
					"  m.delete(oldest);",
					"}",
				].join("\n"),
			),
		).toEqual([3]);
		// The tree's one spread-destructure is a peek with no cap loop and no
		// removal (`fieldCounts.size !== 1`), so it stays out of the family.
		expect(
			findEvictionLines("const [delegateField] = [...fieldCounts.keys()];"),
		).toEqual([]);
	});

	// (#4580 review F3) The victim may be assigned to a binding declared above
	// the bounded loop, so the family cannot require `const`/`let`/`var` on the
	// same line as the `.next()`.
	it("flags a re-assigned iterator binding, #4580 review F3", () => {
		expect(
			findEvictionLines(
				[
					"let oldest;",
					"while (m.size > CAP) {",
					"  oldest = m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value);",
					"}",
				].join("\n"),
			),
		).toEqual([3]);
		// A type annotation on the declaration must not hide it either.
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const oldest: IteratorResult<[string, number]> = m.entries().next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value[0]);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
	});

	// (#4580 review F3) A formatter may break the line right after `=`, which a
	// single-line binding pattern cannot cross.
	it("flags a binding the formatter wrapped after `=`, #4580 review F3", () => {
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const oldest =",
					"    m.keys().next();",
					"  if (oldest.done) break;",
					"  m.delete(oldest.value);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
	});

	// (#4580 round 2, audit item 4) An eviction ordered by a COMPARATOR picks its
	// victim by sorting the spread accessor instead of taking its head. Three
	// live members sort by an explicitly maintained `lastUsedAt` inside a
	// `.size > CAP` loop and evict through a helper; the family is gated on the
	// bounded loop above and a use of the bound name below. A comparator read
	// with no cap loop is not an eviction.
	it("flags an eviction ordered by a comparator over a spread accessor, #4580 round 2", () => {
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const victim = [...m.entries()].sort(",
					"    ([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,",
					"  )[0];",
					"  if (!victim) break;",
					"  m.delete(victim[0]);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		expect(
			findEvictionLines(
				[
					"while (m.size > CAP) {",
					"  const victim = [...m.entries()].sort(cmp)[0];",
					"  m.delete(victim[0]);",
					"}",
				].join("\n"),
			),
		).toEqual([2]);
		// A truncation keeps the whole ranking instead of picking one victim, so
		// it carries no `[0]` and stays out of the family
		// (`clients/lens-map.ts`'s degree-ranked `keepIds` is that live shape).
		expect(
			findEvictionLines(
				[
					"if (files.size > maxNodes) {",
					"  const ranked = [...files.keys()].sort((a, b) => b.degree - a.degree);",
					"  keepIds = new Set(ranked.slice(0, maxNodes));",
					"  use(keepIds);",
					"}",
				].join("\n"),
			),
		).toEqual([]);
		// A ranking read outside a bounded cap loop is not an eviction.
		expect(
			findEvictionLines(
				[
					"const ranked = [...m.entries()].sort(cmp);",
					"return ranked[0];",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("flags filtered comparator chains, #4580 r3 F1", () => {
		// Shape 69: a transparent transform must not hide ordered removal.
		for (const transform of [
			".filter(eligible)",
			".map(identity)",
			".slice(0)",
			".filter(([, e]) => { return eligible(e); }).map(identity)",
		]) {
			const source = `while (m.size > CAP) {
 const victim = [...m.entries()]${transform}.sort(cmp)[0];
 evict(victim);
}`;
			expect(findEvictionLines(stripSource(source)), transform).toEqual([2]);
		}
	});

	it.each([
		".filter(eligible)[0]",
		".shift()",
		".pop()",
		"[index]",
		".filter(eligible).at(-1)",
		".filter((value) => { inspect(value); return eligible(value); })[0]",
	])("flags derived ordered element consumer %s, #4580 r4 F1", (selector) => {
		// Shape 69: transforms and removal APIs must not hide selection.
		expect(
			findEvictionLines(
				stripSource(`if (m.size <= CAP) return;
 const victim = sequence.sort(cmp)${selector};
 m.delete(victim);`),
			),
		).toEqual([2]);
	});

	it("flags aliases of ordered sequences, #4580 r4 F1", () => {
		// Greptile's alias and a second derived binding retain ordered provenance.
		expect(
			findEvictionLines(`if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 const alias = ranked;
 const derived = alias.filter(eligible);
 m.delete(derived[0]);`),
		).toEqual([2]);
	});

	it("flags ordered multi-victim removal, #4580 r4 F1", () => {
		// Real production source, not a rewritten widget-state approximation.
		const source = fs.readFileSync(
			path.join(REPO_ROOT, "clients/widget-state.ts"),
			"utf8",
		);
		const start = source.indexOf("function pruneInactiveFileRecords(");
		const end = source.indexOf("function maybePruneInactiveFileRecords", start);
		expect(findEvictionLines(stripSource(source.slice(start, end)))).toEqual([
			3,
		]);
	});

	it("rejects unconsumed ordered aliases, #4580 r4", () => {
		// A derived sequence is not an element, and an unrelated loop is not its consumer.
		expect(
			findEvictionLines(`if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 const alias = ranked.filter(eligible);
 for (const key of other) { m.delete(key); }
 consume(alias);`),
		).toEqual([]);
	});

	it("rejects ordered iteration without removal, #4580 r4", () => {
		// Iteration alone is ranking, not eviction, even under a cap.
		expect(
			findEvictionLines(`if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 for (const key of ranked) { consume(key); }`),
		).toEqual([]);
	});

	it("records indirect selection as residual #4606, #4580 r4", () => {
		// Shape 69 indirect-call plant: no interprocedural element provenance claim.
		expect(
			findEvictionLines(`if (m.size <= CAP) return;
 const ranked = sequence.sort(cmp);
 const victim = selectVictim(ranked);
 m.delete(victim);`),
		).toEqual([]);
	});

	it("accounts for every live member the detector cannot see, #4580 r5 F1/F2", () => {
		// The census describes the DETECTOR's population, not the tree's. Each
		// spelling is proved a miss, and each live site is re-read from the real
		// file: the anchor must still be there (nothing migrated or moved out from
		// under the row) and must still be unflagged (the row never claims a site
		// the sweep now catches).
		const liveSites = Object.values(UNSEEN_SELECTION_RESIDUALS).flatMap(
			(row) => row.live,
		);
		expect(Object.keys(UNSEEN_SELECTION_RESIDUALS)).toHaveLength(6);
		expect(liveSites).toHaveLength(5);
		expect(new Set(liveSites.map((site) => site.file)).size).toBe(5);
		// Collect every witness before failing, so one drifted row does not hide
		// the others.
		const witnesses: string[] = [];
		let plantChecks = 0;
		let siteChecks = 0;
		for (const [spelling, row] of Object.entries(UNSEEN_SELECTION_RESIDUALS)) {
			// Count only a plant whose scanned text reached the detector: an
			// emptied input leaves the count short instead of reading as a miss
			// proved (#4580 r6 F3).
			const plantSource = stripSource(row.plant);
			if (plantSource.trim().length > 0) plantChecks += 1;
			if (findEvictionLines(plantSource).length > 0)
				witnesses.push(`plant is now flagged: ${spelling}`);
			for (const site of row.live) {
				siteChecks += 1;
				const source = fs.readFileSync(path.join(REPO_ROOT, site.file), "utf8");
				// Code, not prose: a comment or a string quoting the anchor is not
				// the site (#4580 r6 F1).
				const anchors = liveAnchorLines(source, site.anchor);
				const detected = findEvictionLines(stripSource(source));
				if (anchors.length !== 1)
					witnesses.push(
						`${site.file}: anchor ${JSON.stringify(site.anchor)} matched ${anchors.length} lines`,
					);
				else if (detected.includes(anchors[0] ?? -1))
					witnesses.push(
						`${site.file}: ${site.anchor} is now flagged — delete or migrate the row`,
					);
				// A truncation-aware detector flags the sorted DECLARATION, not the
				// consumption line, so the file's whole flagged count is the pin.
				if (detected.length !== site.detectedElsewhere)
					witnesses.push(
						`${site.file}: sweep flags ${detected.length} occurrence(s), the row records ${site.detectedElsewhere} elsewhere`,
					);
			}
		}
		expect(witnesses).toEqual([]);
		// Every check above runs inside a loop, and both survivors of the r5
		// accounting test were loops that visited nothing: an emptied per-site
		// loop and a plant read of "" each left `witnesses` empty. Pin what the
		// loop actually performed (#4580 r6 F3).
		expect({ plantChecks, siteChecks }).toEqual({
			plantChecks: Object.keys(UNSEEN_SELECTION_RESIDUALS).length,
			siteChecks: liveSites.length,
		});
	});

	it("does not let a comment or a string keep a residual row alive, #4580 r6 F1", () => {
		// The content control for the accounting test: the anchor read is stripped
		// first, so the same anchor quoted four ways matches zero lines.
		const anchor = "for (const candidate of candidates.slice(0, over)) {";
		expect(
			liveAnchorLines(
				[
					"// Stale note kept from an older round:",
					`// ${anchor}`,
					`/* ${anchor} */`,
					`const note = ${JSON.stringify(anchor)};`,
					"for (let index = 0; index < over; index += 1) {",
					"\tconst candidate = candidates[index];",
					"}",
				].join("\n"),
				anchor,
			),
		).toEqual([]);
		// The same anchor as code still matches, so this control cannot pass by
		// matching nothing at all.
		expect(liveAnchorLines(`\t${anchor}`, anchor)).toEqual([1]);
		expect(liveAnchorLines(`\t${anchor}\n\t${anchor}`, anchor)).toEqual([1, 2]);
	});

	it("flags comparator source and ordering axes, #4580 r3", () => {
		// Shape 69: the ordering operation owns recognition, not its receiver.
		for (const source of [
			"[...m.keys()]",
			"[...m.values()]",
			"Array.from(m.entries())",
			"sequence",
			"sequenceOf(m)",
		]) {
			for (const order of ["sort(cmp)", "sort()", "toSorted(cmp)"]) {
				expect(
					findEvictionLines(`while (m.size > CAP) {
 const victim = ${source}.${order}[0];
 alias.delete(victim);
}`),
					`${source}.${order}`,
				).toEqual([2]);
			}
		}
	});

	it("flags comparator selection axes, #4580 r3 F2", () => {
		// Shape 69: find and at select a victim as surely as index zero.
		for (const selector of ["[0]", ".find(eligible)", ".at(0)"]) {
			expect(
				findEvictionLines(`if (m.size < CAP) return;
 const victim = [...m.keys()].sort(cmp)${selector};
 m.delete(victim);`),
				selector,
			).toEqual([2]);
		}
	});

	it("flags a ceiling cap with selection in another binding, #4580 r3 F2", () => {
		// client-registry's ceiling is checked before sorting eligible clients.
		const source = `if (occupied < getCeiling()) return true;
 const idle = [...m.entries()]
 .filter(([, client]) => { return client.alive(); })
 .sort(([, a], [, b]) => stamp(a) - stamp(b));
 const victim = idle[0];
 evict(victim);`;
		expect(findEvictionLines(stripSource(source))).toEqual([2]);
	});

	it("flags length caps and removal consumers, #4580 r3", () => {
		// Shape 69: collection APIs and removal APIs are independent axes.
		for (const remove of [
			"alias.delete(victim)",
			"queue.splice(victim, 1)",
			"consume(victim); queue.shift()",
			"consume(victim); queue.pop()",
		]) {
			expect(
				findEvictionLines(`while (queue.length >= CAP) {
 const victim = sequence.sort(cmp)[0];
 ${remove};
}`),
				remove,
			).toEqual([2]);
		}
	});

	it("keeps the filtered read-guard admissions distinct, #4580 r3", () => {
		// Same declaration line, different eligibility policies must not share admission.
		const reads = occurrences.filter((item) =>
			item.detail.startsWith("clients/read-guard.ts:"),
		);
		expect(reads).toHaveLength(2);
		expect(new Set(reads.map((item) => item.key)).size).toBe(2);
	});

	it("separates bound-victim gate predicates, #4580 r3 compliance F2", () => {
		// Each negative removes exactly one prerequisite; gate mutations must red.
		for (const [binding, read] of [
			["const item = iterator.next();", "consume(item.value);"],
			["const [item] = sequence;", "consume(item);"],
		]) {
			expect(
				findEvictionLines(`while (m.size > CAP) {
 ${binding}
 ${read}
}`),
				"no removal",
			).toEqual([]);
			expect(
				findEvictionLines(`{
 ${binding}
 m.delete(key); ${read}
}`),
				"no cap",
			).toEqual([]);
			expect(
				findEvictionLines(`while (m.size > CAP) {
 ${binding}
 m.delete(key);
}`),
				"no own read",
			).toEqual([]);
		}
		for (const [above, below] of [
			["{", "evict(victim);"],
			["while (m.size > CAP) {", "evict(other);"],
		]) {
			expect(
				findEvictionLines(`${above}
 const victim = [...m.keys()].sort(cmp)[0];
 ${below}
}`),
			).toEqual([]);
		}
	});

	it("does not borrow a different sequence's selection, #4580 r3", () => {
		// The ordered binding must own the later selection, not just occur nearby.
		expect(
			findEvictionLines(`while (m.size > CAP) {
 const ranked = sequence.sort(cmp);
 const victim = other[0];
 consume(ranked); evict(victim);
}`),
		).toEqual([]);
	});

	it("does not count a comment or a string that quotes any spelling, #4580 round 2", () => {
		const source = [
			"// const [oldest] = m.keys(); m.delete(oldest);",
			"/* while (m.size > CAP) { const victim = [...m.entries()].sort(cmp)[0];",
			"   m.delete(victim[0]); } */",
			'const note = "const $oldest = m.keys().next(); m.delete($oldest.value);";',
			"// x.values()",
			"//   .next().value",
			"const unrelated = 1;",
		].join("\n");
		expect(findEvictionLines(stripSource(source))).toEqual([]);
	});

	it("flags per OCCURRENCE, so an exemption cannot launder a new sibling", () => {
		// #2442 review F6: exemptions used to be file-level, so appending a NEW
		// eviction to an exempted file passed. Every flagged id carries a
		// content-derived key (#2475: `path#symbol:hash` or `path#hash`, never a
		// bare line number — see `stableOccurrenceKey`).
		for (const item of flagged) {
			expect(item).toMatch(
				/^[\w./-]+\.(?:ts|mjs|js)#(?:[A-Za-z_$][\w$]*:)?[0-9a-f]{8}$/,
			);
		}
		const exemptedFiles = new Set(
			Object.keys(EXEMPT_SITES).map((k) => k.split("#")[0]),
		);
		// Every exempted FILE still has exactly the occurrences named, no more:
		// a second, unexcused occurrence in the same file must show up as
		// unaccounted below rather than riding the file's exemption.
		for (const file of exemptedFiles) {
			const inFile = flagged.filter((f) => f.startsWith(`${file}#`));
			for (const occurrence of inFile) {
				expect(
					Object.hasOwn(EXEMPT_SITES, occurrence),
					`${occurrence} is in an exempted file but is not itself exempted`,
				).toBe(true);
			}
		}
	});

	// #2487 review F1: the test above ("flags per OCCURRENCE") is vacuous
	// against a real collision, because `expect(item).toBe(...)` compares the
	// SAME string to itself when two occurrences hash to one key — it cannot
	// distinguish "this occurrence is exempted" from "some occurrence sharing
	// this key is exempted". This test runs a REAL twin-collision fixture
	// through the actual detection pipeline (`findEvictionLines` +
	// `stableOccurrenceKey`, not a hand-typed key) and proves `auditRegistry`
	// itself refuses to let one exemption cover both — the property the
	// vacuous test above could never have caught.
	it("ATTACK_TWIN_OCCURRENCE_COLLISION (#2487 review F1): two sibling methods with an identical flagged line cannot share one exemption", () => {
		const rel = "clients/__probe_twin_cache.ts";
		const source = [
			"class ProbeTwinCache {",
			"\tevictFirst() {",
			"\t\tfor (const k of this.map.keys()) {",
			"\t\t\tthis.map.delete(k);",
			"\t\t\tbreak;",
			"\t\t}",
			"\t}",
			"\tevictSecond() {",
			"\t\tfor (const k of this.map.keys()) {",
			"\t\t\tthis.map.delete(k);",
			"\t\t\tbreak;",
			"\t\t}",
			"\t}",
			"}",
		].join("\n");
		const evictionLines = findEvictionLines(source);
		expect(evictionLines).toEqual([3, 9]); // both flagged by the REAL detector
		const lines = source.split("\n");
		const twinOccurrences = evictionLines.map((line) => ({
			key: stableOccurrenceKey(rel, lines, line - 1),
			detail: `${rel}:${line}`,
		}));
		// Precondition: both really do collide on one key — same enclosing
		// symbol (the class), same flagged-line text.
		expect(twinOccurrences[0]?.key).toBe(twinOccurrences[1]?.key);

		// One exemption, keyed to the shared string: pre-guard this read clean
		// (laundered); the collision guard must refuse it.
		const laundered = auditRegistry({
			sweepName: "probe twin sweep",
			flagged: twinOccurrences,
			registered: [],
			exemptions: {
				[twinOccurrences[0]!.key]: "reviewed exemption for one occurrence",
			},
		});
		expect(laundered.problems.join("\n")).toContain("collide");

		// The remedy this sweep ships (#2487 review round 3 F1): NOT an
		// auto-numbered ordinal — `disambiguateFlaggedKeys` shipped that and was
		// deleted, because numbering by SCAN POSITION let a genuinely new,
		// unreviewed occurrence ride an existing exemption's ordinal the moment
		// it landed between two already-exempted ones (proved against
		// `sync-child-process-timeout.test.ts`'s real collision in that same
		// review round). The actual remedy is the message's own instruction:
		// "give each occurrence a distinguishing key ... before exempting
		// either" — a human edits the flagged line's own text so its content
		// hash genuinely differs, which is what distinguishes two occurrences
		// that a mechanical scan cannot tell apart on its own.
		const distinguishedSource = source.replace(
			"\tevictSecond() {\n\t\tfor (const k of this.map.keys()) {",
			"\tevictSecond() {\n\t\tfor (const key of this.map.keys()) {",
		);
		const distinguishedLines = distinguishedSource.split("\n");
		const distinguishedEvictionLines = findEvictionLines(distinguishedSource);
		expect(distinguishedEvictionLines).toEqual([3, 9]); // same lines...
		const distinguishedOccurrences = distinguishedEvictionLines.map((line) => ({
			key: stableOccurrenceKey(rel, distinguishedLines, line - 1),
			detail: `${rel}:${line}`,
		}));
		// ...but no longer the same KEY: `key` vs `k` changed the flagged
		// line's own text, so its content hash — not its position — differs.
		expect(distinguishedOccurrences[0]!.key).not.toBe(
			distinguishedOccurrences[1]!.key,
		);
		const properlyExempted = auditRegistry({
			sweepName: "probe twin sweep",
			flagged: distinguishedOccurrences,
			registered: [],
			exemptions: {
				[distinguishedOccurrences[0]!.key]:
					"reviewed exemption for evictFirst's occurrence",
				[distinguishedOccurrences[1]!.key]:
					"reviewed exemption for evictSecond's occurrence",
			},
		});
		expect(properlyExempted.problems).toEqual([]);
	});

	it("every occurrence is the definition file, migrated, or exempted with a reason", () => {
		const audit = auditRegistry({
			sweepName: "bounded-eviction-idiom sweep",
			flagged: occurrences,
			registered: [],
			exemptions: EXEMPT_SITES,
			scannedCount: scanned,
			// Calibration: ~450 shipped .ts files across clients/tools/mcp/index.ts
			// as of #2442; half rounded down is comfortably under that.
			minScanned: 200,
			minFlagged: 1,
			remediation:
				"Migrate the site to BoundedLruCache (get() re-inserts — LRU), " +
				"BoundedFifoMap (get() never re-inserts — FIFO), or BoundedSet " +
				"(Set-shaped, membership-only — #2460) from " +
				"clients/bounded-cache.ts — all three return the evicted " +
				"key(s)/value(s) from set()/add(), so eviction-side bookkeeping " +
				"needs no hand-rolled block either — or add an EXEMPT_SITES entry " +
				"here (keyed by " +
				"`stableOccurrenceKey` from tests/support/sweep-kit.ts — " +
				"`path#symbol:hash` or `path#hash`, printed above) with a real " +
				"reason (see #2442's PR body verdict table for the shape of a " +
				"legitimate exemption).",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
		const unseenLiveSites = Object.values(UNSEEN_SELECTION_RESIDUALS).flatMap(
			(row) => row.live,
		);
		process.stdout.write(
			`bounded-eviction population: ${flagged.length} flagged, ${audit.problems.length} problems, ${unseenLiveSites.length} unseen live sites in ${Object.keys(UNSEEN_SELECTION_RESIDUALS).length} spellings, ${scanned} source files\n`,
		);
	});
});
