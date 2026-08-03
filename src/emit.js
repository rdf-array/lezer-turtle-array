/**
 * RDF/JS quad emitter for the lezer-turtle parse tree, with source
 * provenance tracked on the side.
 *
 * parseTurtle(text, {baseIRI, factory, dialect, blankNodePrefix}) returns
 *   {quads, provenance, diagnostics, prefixes, base, tree}
 * where provenance is a ProvenanceIndex: a multiset of quad *utterances*
 * layered over the set of quads.  Quads stay plain RDF/JS objects (equality
 * via .equals()); each utterance records the source ranges of the syntax
 * that gave rise to each position:
 *
 *   {quad, subject: Range[], predicate: Range[], object: Range[], graph: Range[]}
 *
 * Ranges are {start, end} character offsets (UTF-16, as Lezer counts).
 * Ranges come in arrays because a position's provenance can be split or
 * synthetic: a blank node property list's subject is its whole  [ … ]
 * bracket span, collection cell quads (rdf:first/rest) carry item and
 * collection spans, and annotation-derived reification quads point at the
 * ~reifier / {| … |} syntax.
 *
 * The index is keyed canonically (an N-Quads-shaped string), NOT by object
 * identity — RDF/JS makes no same-object guarantee, and stores like
 * N3.Store reconstruct quads on read — so looking up a quad you got back
 * from a store works.
 */

import {parser} from "./parser.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

// ── canonical keys ─────────────────────────────────────────────────────────
export function termKey (term) {
  switch (term.termType) {
  case "NamedNode": return `<${term.value}>`;
  case "BlankNode": return `_:${term.value}`;
  case "Literal": {
    const val = `"${term.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    if (term.language)
      return val + "@" + term.language + (term.direction ? "--" + term.direction : "");
    if (term.datatype && term.datatype.value !== XSD + "string")
      return val + "^^<" + term.datatype.value + ">";
    return val;
  }
  case "DefaultGraph": return "";
  case "Variable": return "?" + term.value;
  case "Quad": return `<<(${termKey(term.subject)} ${termKey(term.predicate)} ${termKey(term.object)})>>`;
  default: throw Error("termKey: unknown termType " + term.termType);
  }
}

export function quadKey (quad) {
  return `${termKey(quad.subject)} ${termKey(quad.predicate)} ${termKey(quad.object)} ${termKey(quad.graph)}`;
}

export class ProvenanceIndex {
  constructor () { this._map = new Map(); }

  _add (quad, utterance) {
    const key = quadKey(quad);
    if (!this._map.has(key))
      this._map.set(key, []);
    this._map.get(key).push(utterance);
  }

  /** utterances of a quad (empty array if never uttered) */
  get (quad) { return this._map.get(quadKey(quad)) || []; }

  /** number of distinct quads uttered */
  get size () { return this._map.size; }

  [Symbol.iterator] () { return this._map.values(); }
}

// ── IRI resolution (RFC 3986, without WHATWG normalization) ───────────────
export function resolveIri (iri, base) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri) || !base)
    return iri;
  const b = splitIri(base);
  if (iri === "") return base;
  if (iri.startsWith("#")) return b.scheme + b.authority + b.path + iri;
  if (iri.startsWith("?")) return b.scheme + b.authority + b.path.replace(/\?.*/, "") + iri;
  if (iri.startsWith("//")) return b.scheme + iri;
  if (iri.startsWith("/")) return b.scheme + b.authority + removeDotSegments(iri);
  const dir = b.path.replace(/\?.*/, "").replace(/[^/]*$/, "");
  return b.scheme + b.authority + removeDotSegments(dir + iri);
}
function splitIri (iri) {
  const m = iri.match(/^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/[^/?#]*)?([^#]*)/);
  return {scheme: m[1], authority: m[2] || "", path: m[3] || ""};
}
function removeDotSegments (path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === ".") continue;
    else if (seg === "..") { if (out.length > 1) out.pop(); }
    else out.push(seg);
  }
  let ret = out.join("/");
  if ((path.endsWith("/.") || path.endsWith("/..")) && !ret.endsWith("/")) ret += "/";
  return ret;
}

// ── string unescaping ─────────────────────────────────────────────────────
const echars = {t: "\t", b: "\b", n: "\n", r: "\r", f: "\f", '"': '"', "'": "'", "\\": "\\"};
function unescapeString (s) {
  return s.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(.))/g,
                   (_, u4, u8, e) => u4 || u8
                     ? String.fromCodePoint(parseInt(u4 || u8, 16))
                     : echars[e] !== undefined ? echars[e] : e);
}
function unescapeIri (s) {
  return s.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g,
                   (_, u4, u8) => String.fromCodePoint(parseInt(u4 || u8, 16)));
}
function unescapePnLocal (s) {
  return s.replace(/\\([_~.\-!$&'()*+,;=/?#@%])/g, "$1");
}

// ── the emitter ────────────────────────────────────────────────────────────
export function parseTurtle (text, options = {}) {
  if (!options.factory)
    throw Error("parseTurtle: supply options.factory (an RDF/JS DataFactory, e.g. N3.DataFactory)");
  const factory = options.factory;
  const state = {
    text,
    factory,
    base: options.baseIRI || null,
    prefixes: Object.create(null),
    bnodeN: 0,
    bnodePrefix: options.blankNodePrefix !== undefined ? options.blankNodePrefix : "df_",
    quads: [],
    prov: new ProvenanceIndex(),
    diagnostics: [],
    graph: factory.defaultGraph(),
    graphRanges: [],
  };
  const tree = parser.configure(options.dialect ? {dialect: options.dialect} : {}).parse(text);

  // one tree-wide scan catches every error-recovery point, however nested
  tree.iterate({enter: n => {
    if (n.type.isError)
      state.diagnostics.push({start: n.from, end: n.to, message: "syntax error"});
  }});

  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
    case "Directive": directive(child.firstChild, state); break;
    case "Triples": triples(child, state); break;
    case "Block": block(child, state); break;
    default:
      if (child.type.isError) diagnose(state, child, "syntax error");
    }
  }

  return {
    quads: state.quads,
    provenance: state.prov,
    diagnostics: state.diagnostics,
    prefixes: state.prefixes,
    base: state.base,
    tree,
  };
}

function src (state, node) { return state.text.slice(node.from, node.to); }
function range (node) { return {start: node.from, end: node.to}; }
function freshBnode (state) { return state.factory.blankNode(state.bnodePrefix + state.bnodeN++); }

function diagnose (state, node, message) {
  state.diagnostics.push({start: node.from, end: node.to, message});
}

function directive (node, state) {
  if (!node) return;
  const iriNode = node.getChild("IRIREF");
  switch (node.name) {
  case "PrefixID": case "SparqlPrefix": {
    const ns = node.getChild("PNAME_NS");
    if (ns && iriNode)
      state.prefixes[src(state, ns).slice(0, -1)] =
        resolveIri(unescapeIri(src(state, iriNode).slice(1, -1)), state.base);
    break;
  }
  case "Base": case "SparqlBase":
    if (iriNode) {
      const raw = unescapeIri(src(state, iriNode).slice(1, -1));
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && /^[^/?#]*:/.test(raw))
        diagnose(state, iriNode, "colon in first path segment of relative IRI");
      state.base = resolveIri(raw, state.base);
    }
    break;
  case "Version": case "SparqlVersion": {
    const spec = node.getChild("VersionSpecifier");
    if (spec) {
      const v = src(state, spec.firstChild).slice(1, -1);
      if (!/^[0-9]+\.[0-9]+$/.test(v))
        diagnose(state, spec, `unrecognized version "${v}"`);
    }
    break;
  }
  }
}

// names of nodes that evaluate to a term (the inlined `iri`, `literal` etc.
// rules expose these directly)
const termNodes = new Set([
  "IRIREF", "PrefixedName", "BlankNode", "Collection", "BlankNodePropertyList",
  "RDFLiteral", "NumericLiteral", "BooleanLiteral", "TripleTerm", "ReifiedTriple",
]);

/** evaluate any term-producing node to {term, ranges} */
function term (node, state) {
  const r = [range(node)];
  switch (node.name) {
  case "IRIREF": {
    const raw = unescapeIri(src(state, node).slice(1, -1));
    // RFC 3986: a relative reference's first path segment may not contain ":"
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) && /^[^/?#]*:/.test(raw))
      diagnose(state, node, "colon in first path segment of relative IRI");
    return {term: state.factory.namedNode(resolveIri(raw, state.base)), ranges: r};
  }
  case "PrefixedName": {
    const s = src(state, node);
    const colon = s.indexOf(":");
    const prefix = s.slice(0, colon), local = s.slice(colon + 1);
    if (!(prefix in state.prefixes)) {
      diagnose(state, node, `undefined prefix "${prefix}:"`);
      return {term: state.factory.namedNode("urn:error:undefined-prefix:" + prefix), ranges: r};
    }
    return {term: state.factory.namedNode(state.prefixes[prefix] + unescapePnLocal(local)), ranges: r};
  }
  case "BlankNode": {
    const label = node.getChild("BLANK_NODE_LABEL");
    if (label)
      return {term: state.factory.blankNode(src(state, label).slice(2)), ranges: r};
    return {term: freshBnode(state), ranges: r}; // Anon
  }
  case "Collection": return collection(node, state);
  case "BlankNodePropertyList": return blankNodePropertyList(node, state);
  case "RDFLiteral": return rdfLiteral(node, state);
  case "NumericLiteral": {
    const tok = node.firstChild;
    const dt = {INTEGER: "integer", DECIMAL: "decimal", DOUBLE: "double"}[tok.name];
    return {term: state.factory.literal(src(state, tok), state.factory.namedNode(XSD + dt)), ranges: r};
  }
  case "BooleanLiteral":
    return {term: state.factory.literal(src(state, node), state.factory.namedNode(XSD + "boolean")), ranges: r};
  case "TripleTerm": return tripleTerm(node, state);
  case "ReifiedTriple": return reifiedTriple(node, state);
  default:
    diagnose(state, node, `expected term, got ${node.name}`);
    return {term: freshBnode(state), ranges: r};
  }
}

function firstTermChild (node) {
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (termNodes.has(child.name))
      return child;
  return null;
}

function emit (state, s, p, o, g) {
  const quad = state.factory.quad(s.term, p.term, o.term, (g || {term: state.graph}).term);
  state.quads.push(quad);
  state.prov._add(quad, {
    quad,
    subject: s.ranges,
    predicate: p.ranges,
    object: o.ranges,
    graph: g ? g.ranges : state.graphRanges,
  });
}

function block (node, state) { // TriG
  const wrapped = node.getChild("WrappedGraph");
  const labelNode = firstTermChild(node); // labelOrSubject is inlined
  const outerGraph = state.graph, outerRanges = state.graphRanges;
  if (labelNode) {
    const label = term(labelNode, state);
    state.graph = label.term;
    state.graphRanges = label.ranges;
  }
  if (wrapped)
    for (let child = wrapped.firstChild; child; child = child.nextSibling)
      if (child.name === "Triples")
        triples(child, state);
      else if (child.type.isError)
        diagnose(state, child, "syntax error in graph block");
  state.graph = outerGraph;
  state.graphRanges = outerRanges;
}

function triples (node, state) {
  let subject = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
    case "Subject":
      subject = term(child.firstChild, state);
      break;
    case "BlankNodePropertyList":
    case "ReifiedTriple":
      subject = term(child, state);
      break;
    case "PredicateObjectList":
      predicateObjectList(child, state, subject);
      break;
    default:
      if (child.type.isError) diagnose(state, child, "syntax error in triples");
    }
  }
}

function predicateObjectList (node, state, subject) {
  let verb = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
    case "Verb": verb = readVerb(child, state); break;
    case "ObjectList": objectList(child, state, subject, verb); break;
    default:
      if (child.type.isError) diagnose(state, child, "syntax error in predicate-object list");
    }
  }
}

function readVerb (node, state) {
  const type = node.getChild("RdfTypeKw");
  if (type)
    return {term: state.factory.namedNode(RDF + "type"), ranges: [range(type)]};
  const pred = node.getChild("Predicate");
  return term((pred || node).firstChild, state);
}

function objectList (node, state, subject, verb) {
  let lastObject = null;
  let lastReifier = null; // reifier available for a following annotation block
  for (let child = node.firstChild; child; child = child.nextSibling) {
    switch (child.name) {
    case "Object":
      lastObject = term(child.firstChild, state);
      lastReifier = null;
      emit(state, subject, verb, lastObject);
      break;
    case "Annotation":
      for (let a = child.firstChild; a; a = a.nextSibling) {
        if (a.name === "Reifier") {
          lastReifier = annotationReifier(a, state, subject, verb, lastObject);
        } else if (a.name === "AnnotationBlock") {
          const reifier = lastReifier || annotationReifier(a, state, subject, verb, lastObject);
          const pol = a.getChild("PredicateObjectList");
          if (pol)
            predicateObjectList(pol, state, reifier);
          lastReifier = null;
        }
      }
      break;
    default:
      if (child.type.isError) diagnose(state, child, "syntax error in object list");
    }
  }
}

/** emit `reifier rdf:reifies <<(s p o)>>` for a ~reifier or bare {| block */
function annotationReifier (node, state, subject, verb, obj) {
  const explicit = node.name === "Reifier" ? firstTermChild(node) : null;
  const reifier = explicit
        ? Object.assign(term(explicit, state), {ranges: [range(node)]})
        : {term: freshBnode(state), ranges: [range(node)]};
  const tt = {term: state.factory.quad(subject.term, verb.term, obj.term), ranges: obj.ranges};
  emit(state, reifier,
       {term: state.factory.namedNode(RDF + "reifies"), ranges: [range(node)]},
       tt);
  return reifier;
}

function blankNodePropertyList (node, state) {
  const bnode = {term: freshBnode(state), ranges: [range(node)]};
  const pol = node.getChild("PredicateObjectList");
  if (pol)
    predicateObjectList(pol, state, bnode);
  return bnode;
}

function collection (node, state) {
  const items = [];
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (child.name === "Object")
      items.push({node: child, value: term(child.firstChild, state)});
  const nil = {term: state.factory.namedNode(RDF + "nil"), ranges: [range(node)]};
  if (items.length === 0)
    return nil;
  let head = null, prev = null;
  for (const item of items) {
    const cell = {term: freshBnode(state), ranges: [range(item.node)]};
    if (prev)
      emit(state, prev, {term: state.factory.namedNode(RDF + "rest"), ranges: [range(node)]}, cell);
    else
      head = cell;
    emit(state, cell, {term: state.factory.namedNode(RDF + "first"), ranges: [range(item.node)]}, item.value);
    prev = cell;
  }
  emit(state, prev, {term: state.factory.namedNode(RDF + "rest"), ranges: [range(node)]}, nil);
  return {term: head.term, ranges: [range(node)]};
}

function rdfLiteral (node, state) {
  const r = [range(node)];
  const str = node.getChild("String").firstChild;
  const raw = src(state, str);
  const long = str.name.includes("LONG");
  const value = unescapeString(raw.slice(long ? 3 : 1, long ? -3 : -1));
  const lang = node.getChild("LANG_DIR");
  if (lang)
    return {term: state.factory.literal(value, src(state, lang).slice(1)), ranges: r};
  const dt = firstTermChild(node); // the ^^ iri
  if (dt)
    return {term: state.factory.literal(value, term(dt, state).term), ranges: r};
  return {term: state.factory.literal(value), ranges: r};
}

/** collect [subjectTermNode, Verb, objectTermNode] of a TripleTerm/ReifiedTriple */
function ttParts (node, state) {
  let s = null, v = null, o = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Verb")
      v = readVerb(child, state);
    else if (child.name === "Reifier")
      continue;
    else if (termNodes.has(child.name)) {
      if (s === null && v === null) s = term(child, state);
      else if (o === null) o = term(child, state);
    }
  }
  return [s, v, o];
}

function tripleTerm (node, state) {
  const [s, v, o] = ttParts(node, state);
  if (s === null || v === null || o === null) {
    diagnose(state, node, "incomplete triple term");
    return {term: freshBnode(state), ranges: [range(node)]};
  }
  return {term: state.factory.quad(s.term, v.term, o.term), ranges: [range(node)]};
}

/** `<< s v o ~r? >>` evaluates to the reifier; emits r rdf:reifies <<(s v o)>> */
function reifiedTriple (node, state) {
  const reifierNode = node.getChild("Reifier");
  // evaluate s/v/o first, but the Reifier's explicit term (if any) separately
  let s = null, v = null, o = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Verb")
      v = readVerb(child, state);
    else if (child.name === "Reifier")
      break; // s v o precede the reifier
    else if (termNodes.has(child.name)) {
      if (v === null) s = term(child, state);
      else o = term(child, state);
    }
  }
  if (s === null || v === null || o === null) {
    diagnose(state, node, "incomplete reified triple");
    return {term: freshBnode(state), ranges: [range(node)]};
  }
  const explicit = reifierNode && firstTermChild(reifierNode);
  const reifier = explicit
        ? Object.assign(term(explicit, state), {ranges: [range(reifierNode)]})
        : {term: freshBnode(state), ranges: [range(node)]};
  const tt = {term: state.factory.quad(s.term, v.term, o.term), ranges: [range(node)]};
  emit(state, reifier,
       {term: state.factory.namedNode(RDF + "reifies"), ranges: [range(reifierNode || node)]},
       tt);
  return {term: reifier.term, ranges: [range(node)]};
}
