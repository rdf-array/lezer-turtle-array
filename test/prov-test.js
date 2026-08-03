/**
 * Provenance semantics: quad utterances are a multiset over the set of
 * quads; lookups key on quad *value* (never object identity), so quads
 * reconstructed by a store still find their utterances.
 */
import {test} from "node:test";
import assert from "node:assert";
import N3 from "n3";
import {parseTurtle} from "../src/emit.js";

const F = N3.DataFactory;
const opts = {factory: F, baseIRI: "http://x.example/"};
const slice = (doc, r) => doc.slice(r.start, r.end);

test("same quad uttered twice has two utterances", () => {
  const doc = `<s> <p> <o> .\n<s> <p> <o> .`;
  const {quads, provenance} = parseTurtle(doc, opts);
  assert.equal(quads.length, 2);
  const utts = provenance.get(quads[0]);
  assert.equal(utts.length, 2);
  assert.equal(slice(doc, utts[0].subject[0]), "<s>");
  assert.notDeepEqual(utts[0].subject, utts[1].subject);
});

test("shared subject across ';' reuses the subject's source range", () => {
  const doc = `<s> <p1> <o1> ;\n    <p2> <o2> .`;
  const {quads, provenance} = parseTurtle(doc, opts);
  const [u1] = provenance.get(quads[0]);
  const [u2] = provenance.get(quads[1]);
  assert.deepEqual(u1.subject, u2.subject);
  assert.equal(slice(doc, u2.predicate[0]), "<p2>");
});

test("blank node property list's subject is its bracket span", () => {
  const doc = `[ <p> <o> ] <q> <r> .`;
  const {quads, provenance} = parseTurtle(doc, opts);
  const inner = quads.find(q => q.predicate.value === "http://x.example/p");
  const [u] = provenance.get(inner);
  assert.equal(slice(doc, u.subject[0]), "[ <p> <o> ]");
  assert.equal(slice(doc, u.object[0]), "<o>");
});

test("store-reconstructed quads still find their utterances", () => {
  const doc = `<s> <p> "lit"@en--ltr .`;
  const {quads, provenance} = parseTurtle(doc, opts);
  const store = new N3.Store(quads);
  const rebuilt = store.getQuads(null, null, null)[0];
  assert.notEqual(rebuilt, quads[0]); // a different object...
  assert.equal(provenance.get(rebuilt).length, 1); // ...same provenance
});

test("TriG: quads carry the graph label's range", () => {
  const doc = `<g> { <s> <p> <o> }`;
  const {quads, provenance} = parseTurtle(doc, {...opts, dialect: "trig"});
  const [u] = provenance.get(quads[0]);
  assert.equal(slice(doc, u.graph[0]), "<g>");
});

test("annotation quads point at the annotation syntax", () => {
  const doc = `<s> <p> <o> ~ <r> {| <a> <b> |} .`;
  const {quads, provenance} = parseTurtle(doc, opts);
  const reifies = quads.find(q => q.predicate.value.endsWith("#reifies"));
  const [u] = provenance.get(reifies);
  assert.equal(slice(doc, u.subject[0]), "~ <r>");
  const annot = quads.find(q => q.predicate.value === "http://x.example/a");
  const [ua] = provenance.get(annot);
  assert.equal(slice(doc, ua.subject[0]), "~ <r>");
  assert.equal(slice(doc, ua.object[0]), "<b>");
});

test("diagnostics carry ranges and don't stop the parse", () => {
  const doc = `<s> <p> <o> .\n<s2> <p2> ;;; .\n<s3> <p3> <o3> .`;
  const {quads, diagnostics} = parseTurtle(doc, opts);
  assert.ok(diagnostics.length > 0);
  assert.ok(quads.some(q => q.subject.value === "http://x.example/s"));
  assert.ok(quads.some(q => q.subject.value === "http://x.example/s3"),
            "parsing continues after the error");
});
