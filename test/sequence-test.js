/**
 * rdf-array: a collection parses to one sequence term, with provenance on the
 * whole ( … ) span, and nothing about rdf:first/rdf:rest.
 */
import {test} from "node:test";
import assert from "node:assert";
import N3 from "n3";
import {parseTurtle, termKey} from "../src/emit.js";

const BASE = "http://example.org/base/";
const opts = {factory: N3.DataFactory, baseIRI: BASE};
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

test("an object collection is one sequence term", () => {
  const doc = "<s> <p> (1 \"x\" <o>).";
  const {quads, provenance, diagnostics} = parseTurtle(doc, opts);
  assert.deepEqual(diagnostics, []);
  assert.equal(quads.length, 1);
  const o = quads[0].object;
  assert.equal(o.termType, "Sequence");
  assert.deepEqual(o.elements.map(e => e.value), ["1", "x", BASE + "o"]);
  assert.equal(termKey(o), `("1"^^<http://www.w3.org/2001/XMLSchema#integer> "x" <${BASE}o>)`);
  const [utt] = provenance.get(quads[0]);
  assert.equal(doc.slice(utt.object[0].start, utt.object[0].end), "(1 \"x\" <o>)");
});

test("the empty collection is the empty sequence, not rdf:nil", () => {
  const {quads} = parseTurtle("<s> <p> ().", opts);
  assert.equal(quads[0].object.termType, "Sequence");
  assert.equal(quads[0].object.elements.length, 0);
  assert.notEqual(quads[0].object.value, RDF + "nil");
});

test("collections nest, hold blank node property lists, and may be subjects", () => {
  const {quads} = parseTurtle("((1 2) [ <q> 3 ]) <p> <o>.", opts);
  assert.equal(quads.length, 2);
  const main = quads.find(q => q.predicate.value === BASE + "p");
  assert.equal(main.subject.termType, "Sequence");
  assert.equal(main.subject.elements[0].termType, "Sequence");
  assert.equal(main.subject.elements[1].termType, "BlankNode");
  const inner = quads.find(q => q.predicate.value === BASE + "q");
  assert.ok(main.subject.elements[1].equals(inner.subject));
  assert.ok(!quads.some(q => q.predicate.value === RDF + "first" || q.predicate.value === RDF + "rest"));
});

test("the sequence equals the one N3.js-array parses", () => {
  const doc = "<s> <p> (1 (2 ()) \"x\"@en).";
  const [mine] = parseTurtle(doc, opts).quads;
  const [theirs] = new N3.Parser({baseIRI: BASE}).parse(doc);
  assert.ok(mine.equals(theirs));
});

test("a plain factory without sequence() still yields a sequence-shaped term", () => {
  const plain = {
    namedNode: v => N3.DataFactory.namedNode(v), blankNode: v => N3.DataFactory.blankNode(v),
    literal: (v, l) => N3.DataFactory.literal(v, l), quad: (s, p, o, g) => N3.DataFactory.quad(s, p, o, g),
    defaultGraph: () => N3.DataFactory.defaultGraph(),
  };
  const {quads} = parseTurtle("<s> <p> (1 2).", {factory: plain, baseIRI: BASE});
  const o = quads[0].object;
  assert.equal(o.termType, "Sequence");
  assert.equal(o.elements.length, 2);
  assert.ok(o.equals(N3.DataFactory.sequence([N3.DataFactory.literal(1), N3.DataFactory.literal(2)])));
});
