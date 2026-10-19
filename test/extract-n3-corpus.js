/**
 * Adopt the Turtle/TriG subset of N3.js's parser tests as a corpus.
 *
 * Reads N3Parser-test.js from a neighboring N3.js checkout (or $N3_CHECKOUT),
 * extracts every document string passed to shouldParse()/shouldNotParse(),
 * and classifies each:
 *
 *   - parses under released n3 as text/turtle       -> corpus.turtle
 *   - else as application/trig                       -> corpus.trig
 *     (these buckets are oracle-checked at test time against released n3)
 *   - else, if the 1.2-capable N3.js *checkout* (built lib/) accepts it
 *     -> corpus.rdf12: RDF 1.2 documents released n3 can't be an oracle
 *     for; lezer-turtle's quads are verified isomorphic to the checkout's
 *     here at extraction time, then frozen as expectations
 *   - else -> corpus.negative (must produce diagnostics)
 *   - documents only lenient text/n3 accepts are out of scope and dropped.
 *
 * Writes test/corpus.json (committed, so tests need neither checkout).
 *
 *   node test/extract-n3-corpus.js [path-to-N3.js-checkout]
 */
import Fs from "fs";
import Path from "path";
import {fileURLToPath} from "url";
import {createRequire} from "module";
import N3 from "n3";
import {parseTurtle, quadKey} from "../src/emit.js";
import {isomorphic} from "./iso.js";

const require = createRequire(import.meta.url);
const here = Path.dirname(fileURLToPath(import.meta.url));
const n3Checkout = process.argv[2] || process.env.N3_CHECKOUT
  || Path.join(here, "../../../rdfjs/N3.js");
const source = Fs.readFileSync(Path.join(n3Checkout, "test/N3Parser-test.js"), "utf8");
const N3main = require(Path.join(n3Checkout, "lib/index.js")); // npm ci && npm run build first
const checkoutSha = (() => {
  try { return require("child_process").execSync("git rev-parse --short HEAD", {cwd: n3Checkout}).toString().trim(); }
  catch (e) { return "unknown"; }
})();

const callRe = /should(?:Not)?Parse\(\s*('(?:[^'\\]|\\[\s\S])*')/g;
const docs = new Set();
let m;
while ((m = callRe.exec(source)) !== null) {
  try { docs.add(eval(m[1])); } catch (e) { /* not a plain literal */ }
}

const BASE = "http://example.org/base/";

// Documents where lezer-turtle knowingly diverges from the N3.js checkout;
// our output is frozen as the expectation.
const knownDivergences = new Map([
  ["<G> { <a> <b> <c> {| <b> <c> |}. }",
   "N3.js main emits the rdf:reifies quad in the default graph while putting the annotation body in <G>; we keep both in <G> (suspected N3 bug)"],
]);
// RDF-: the oracle is N3.js-array (N3.js 2.13 with sequence terms), stricter
// than the n3 1.x lezer-turtle was written against in ways that have nothing
// to do with sequences.  Documents where lezer-turtle knowingly differs from
// it are left out of the corpus, each with its reason.
const oracleDivergences = [
  [/^VERSION "1\\u002e2"/, "N3.js 2.13 unescapes the VERSION string before checking it; lezer-turtle reads it as written"],
  [/\^\^<http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#(dir)?[lL]angString>/, "N3.js 2.13 rejects an rdf:langString or rdf:dirLangString literal written with ^^ instead of a tag; lezer-turtle accepts it"],
  [/@cantbethislong/, "N3.js 2.13 bounds language subtags at 8 characters; lezer-turtle accepts any BCP47-shaped tag"],
];
function divergesFromOracle (doc) {
  return oracleDivergences.find(([re]) => re.test(doc));
}

function parses (impl, doc, format) {
  try {
    return new impl.Parser({format, baseIRI: BASE, blankNodePrefix: ""}).parse(doc);
  } catch (e) {
    return null;
  }
}

const corpus = {meta: {n3CheckoutSha: checkoutSha, extracted: docs.size}, turtle: [], trig: [], rdf12: [], negative: []};
const problems = [];
const dropped = [];
for (const doc of docs) {
  const divergence = divergesFromOracle(doc);
  if (divergence)
    dropped.push([doc, divergence[1]]);
  else if (parses(N3, doc, "text/turtle"))
    corpus.turtle.push(doc);
  else if (parses(N3, doc, "application/trig"))
    corpus.trig.push(doc);
  else {
    const asTurtle = parses(N3main, doc, "text/turtle");
    const as12 = asTurtle || parses(N3main, doc, "application/trig");
    if (as12) {
      const dialect = asTurtle ? undefined : "trig";
      const mine = parseTurtle(doc, {factory: N3.DataFactory, baseIRI: BASE, dialect});
      if (mine.diagnostics.length === 0 && (isomorphic(mine.quads, as12) || knownDivergences.has(doc)))
        corpus.rdf12.push({doc, dialect: dialect || null, expected: mine.quads.map(quadKey).sort()});
      else
        problems.push({doc, diagnostics: mine.diagnostics.length,
                       got: mine.quads.map(quadKey).sort(), want: as12.map(quadKey).sort()});
    } else if (!parses(N3, doc, "text/n3") && !parses(N3main, doc, "text/n3"))
      corpus.negative.push(doc);
    // else: N3-only feature; out of scope for now
  }
}

Fs.writeFileSync(Path.join(here, "corpus.json"), JSON.stringify(corpus, null, 1) + "\n");
console.log(`extracted ${docs.size} docs -> turtle: ${corpus.turtle.length}, trig: ${corpus.trig.length}, rdf12: ${corpus.rdf12.length}, negative: ${corpus.negative.length}, dropped as known divergences: ${dropped.length}`);
dropped.forEach(([doc, why]) => console.log("  dropped", JSON.stringify(doc.slice(0, 60)), "--", why));
if (problems.length) {
  console.log(`\n${problems.length} PROBLEM docs (checkout accepts, lezer-turtle disagrees):`);
  problems.forEach(p => console.log(" ", JSON.stringify(p.doc.slice(0, 70)), "diagnostics:", p.diagnostics,
                                    "\n    got: ", p.got.join(" | "), "\n    want:", p.want.join(" | ")));
  process.exitCode = 1;
}
