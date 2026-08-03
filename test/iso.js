/** blank-node-bijection multiset equality over RDF/JS quads (small graphs) */
import {termKey} from "../src/emit.js";

export function keyWithBnodes (quad, rename) {
  const t = term => term.termType === "BlankNode"
        ? "_:" + (rename.get(term.value) ?? "?")
        : term.termType === "Quad"
        ? `<<(${t(term.subject)} ${t(term.predicate)} ${t(term.object)})>>`
        : termKey(term);
  return `${t(quad.subject)} ${t(quad.predicate)} ${t(quad.object)} ${t(quad.graph)}`;
}

export function bnodeLabels (quads) {
  const labels = new Set();
  const walk = term => {
    if (term.termType === "BlankNode") labels.add(term.value);
    else if (term.termType === "Quad") { walk(term.subject); walk(term.predicate); walk(term.object); }
  };
  for (const q of quads) { walk(q.subject); walk(q.predicate); walk(q.object); walk(q.graph); }
  return [...labels];
}

export function isomorphic (quadsA, quadsB) {
  if (quadsA.length !== quadsB.length) return false;
  const labelsA = bnodeLabels(quadsA), labelsB = bnodeLabels(quadsB);
  if (labelsA.length !== labelsB.length) return false;

  const match = (mapping, i) => {
    if (i === labelsA.length) {
      const rename = new Map(mapping);
      const identity = new Map(labelsB.map(l => [l, l]));
      const a = quadsA.map(q => keyWithBnodes(q, rename)).sort();
      const b = quadsB.map(q => keyWithBnodes(q, identity)).sort();
      return a.join("\n") === b.join("\n");
    }
    for (const target of labelsB) {
      if (mapping.some(([, t]) => t === target)) continue;
      if (match([...mapping, [labelsA[i], target]], i + 1)) return true;
    }
    return false;
  };
  return match([], 0);
}
