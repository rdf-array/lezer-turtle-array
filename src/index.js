/**
 * lezer-turtle — incremental Lezer grammar for RDF 1.2 Turtle and TriG
 * (dialect "trig"), plus an RDF/JS quad emitter with source provenance
 * (see ./emit.js).
 */
import {styleTags, tags as t} from "@lezer/highlight";
import {parser as rawParser} from "./parser.js";

export const parser = rawParser.configure({
  props: [
    styleTags({
      IRIREF: t.url,
      PrefixedName: t.namespace,
      BLANK_NODE_LABEL: t.variableName,
      "STRING_LITERAL_QUOTE STRING_LITERAL_SINGLE_QUOTE STRING_LITERAL_LONG_QUOTE STRING_LITERAL_LONG_SINGLE_QUOTE": t.string,
      "INTEGER DECIMAL DOUBLE": t.number,
      "TrueKw FalseKw": t.bool,
      LANG_DIR: t.modifier,
      "AtPrefixKw AtBaseKw AtVersionKw PrefixKw BaseKw VersionKw GraphKw": t.definitionKeyword,
      RdfTypeKw: t.keyword,
      Comment: t.lineComment,
      "( )": t.paren,
      "[ ]": t.squareBracket,
    }),
  ],
});

export {parseTurtle, ProvenanceIndex, termKey, quadKey, resolveIri} from "./emit.js";
