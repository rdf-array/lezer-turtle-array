# lezer-turtle

An incremental [Lezer](https://lezer.codemirror.net/) grammar for
[RDF 1.2 Turtle](https://www.w3.org/TR/rdf12-turtle/) — with a `trig`
dialect adding [TriG](https://www.w3.org/TR/rdf12-trig/)'s graph blocks —
plus an RDF/JS quad emitter that tracks **source provenance** on the side.

Being a Lezer grammar, it parses incrementally and recovers from errors,
so it slots directly into CodeMirror 6 for highlighting, folding and
lint, and keeps producing quads (with span-carrying diagnostics) while a
document is mid-edit.

## parsing to quads with provenance

```js
import N3 from "n3";
import {parseTurtle} from "lezer-turtle/emit";

const {quads, provenance, diagnostics, prefixes, tree} =
  parseTurtle(text, {
    factory: N3.DataFactory,      // any RDF/JS DataFactory
    baseIRI: "http://x.example/",
    dialect: "trig",              // omit for plain Turtle
  });
```

`provenance` is a `ProvenanceIndex`: a **multiset of quad utterances**
layered over the set of quads.  Quads stay ordinary RDF/JS objects; each
utterance records where each position came from:

```js
provenance.get(quad)  // → [{quad, subject: Range[], predicate: Range[],
                      //     object: Range[], graph: Range[]}, …]
```

`Range` is `{start, end}` in character offsets.  Ranges are arrays because
provenance can be split or synthetic: a `[ … ]` property list's subject is
its bracket span, collection cell quads point at their item, and
annotation-derived `rdf:reifies` quads point at the `~reifier`/`{| … |}`
syntax.  A quad uttered twice has two utterances — the multiset lives
here, not in your store.

The index keys on quad *value* (an N-Quads-shaped canonical form), never
on object identity: RDF/JS only promises `.equals()`, and stores like
`N3.Store` reconstruct quads on read — reconstructed quads still find
their utterances.

## RDF 1.2

Reified triples (`<< s p o ~ r >>`), triple terms (`<<( s p o )>>`),
annotation blocks (`{| … |}`), base-direction language tags
(`"…"@en--ltr`) and version directives (`VERSION "1.2"` / `@version`) are
parsed and emitted per the 1.2 drafts.

Known v0 limitation: prefixed-name characters are the BMP subset of
`PN_CHARS_BASE` (astral-plane ranges explode Lezer's DFA construction).

## tests

`test/corpus.json` adopts the Turtle/TriG subset of
[N3.js](https://github.com/rdfjs/N3.js)'s parser tests
(`test/extract-n3-corpus.js` regenerates it from a neighboring checkout):
released n3 is the oracle for the 1.1 buckets; the 1.2 bucket was verified
isomorphic against N3.js's (1.2-capable) main at extraction and frozen.
`test/prov-test.js` covers the utterance semantics.

```sh
npm install && npm test
```
