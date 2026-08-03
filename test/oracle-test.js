/**
 * Oracle tests: the corpus adopted from N3.js's parser tests
 * (test/extract-n3-corpus.js) must parse to the same quads N3 produces —
 * equal as multisets under blank-node bijection — and the adopted negative
 * documents must produce diagnostics.
 */
import {test} from "node:test";
import assert from "node:assert";
import Fs from "fs";
import Path from "path";
import {fileURLToPath} from "url";
import N3 from "n3";
import {parseTurtle, quadKey} from "../src/emit.js";
import {isomorphic} from "./iso.js";

const here = Path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(Fs.readFileSync(Path.join(here, "corpus.json"), "utf8"));
const BASE = "http://example.org/base/";

function n3Parse (doc, format) {
  return new N3.Parser({format, baseIRI: BASE, blankNodePrefix: ""}).parse(doc);
}

corpus.turtle.forEach((doc, i) => {
  test(`turtle[${i}] ${JSON.stringify(doc.slice(0, 50))}`, () => {
    const expected = n3Parse(doc, "text/turtle");
    const got = parseTurtle(doc, {factory: N3.DataFactory, baseIRI: BASE});
    assert.deepEqual(got.diagnostics, [], "no diagnostics expected");
    assert.ok(isomorphic(got.quads, expected),
              `quads differ:\n  got:      ${got.quads.map(quadKey).sort().join("\n            ")}\n  expected: ${expected.map(quadKey).sort().join("\n            ")}`);
  });
});

corpus.trig.forEach((doc, i) => {
  test(`trig[${i}] ${JSON.stringify(doc.slice(0, 50))}`, () => {
    const expected = n3Parse(doc, "application/trig");
    const got = parseTurtle(doc, {factory: N3.DataFactory, baseIRI: BASE, dialect: "trig"});
    assert.deepEqual(got.diagnostics, [], "no diagnostics expected");
    assert.ok(isomorphic(got.quads, expected),
              `quads differ:\n  got:      ${got.quads.map(quadKey).sort().join("\n            ")}\n  expected: ${expected.map(quadKey).sort().join("\n            ")}`);
  });
});

corpus.rdf12.forEach(({doc, dialect, expected}, i) => {
  test(`rdf12[${i}] ${JSON.stringify(doc.slice(0, 50))}`, () => {
    const got = parseTurtle(doc, {factory: N3.DataFactory, baseIRI: BASE, dialect: dialect || undefined});
    assert.deepEqual(got.diagnostics, [], "no diagnostics expected");
    assert.deepEqual(got.quads.map(quadKey).sort(), expected);
  });
});

corpus.negative.forEach((doc, i) => {
  test(`negative[${i}] ${JSON.stringify(doc.slice(0, 50))}`, () => {
    const got = parseTurtle(doc, {factory: N3.DataFactory, baseIRI: BASE, dialect: "trig"});
    assert.ok(got.diagnostics.length > 0, "expected diagnostics for a negative document");
  });
});
