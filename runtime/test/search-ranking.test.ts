import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmbeddingSpace } from "../src/generated/EmbeddingSpace.js";
import type { SearchMode } from "../src/generated/SearchMode.js";
import { SearchIndex, type Embed, type SearchRecord } from "../src/search.js";

const space: EmbeddingSpace = { id: "synthetic-ranking", model_revision: "fixture", model_digest: "fixture",
  dimensions: 3, pooling: "last", normalization: "l2", instruction_version: 1 };

async function* records(entry_id: string, text: string, source_refs: string[] = []): AsyncIterable<SearchRecord> {
  yield { entry_id, text, ordinal: 0, source_refs };
}

test("semantic search keeps a strong cross-language match ahead of coincidental keyword overlap", async () => {
  const index = new SearchIndex(":memory:");
  const query = "Améliorer la vente de vêtements de seconde main";
  const clothing = "Sell the used jacket with clear sizing, condition, and photographs.";
  const vectors = new Map<string, number[]>([[query, [1, 0, 0]], [clothing, [1, 0, 0]]]);
  const embed: Embed = async (texts) => ({ space, vectors: texts.map((text) => {
    const vector = vectors.get(text); assert.ok(vector); return vector;
  }) });
  try {
    await index.upsert("clothing", "one", records("jacket", clothing), embed);
    for (let ordinal = 0; ordinal < 12; ordinal += 1) {
      const text = `Merge software change ${ordinal} to the main branch.`;
      const cosine = 0.3 - ordinal / 100;
      vectors.set(text, [cosine, Math.sqrt(1 - cosine * cosine), 0]);
      await index.upsert(`software-${ordinal}`, "one", records(`merge-${ordinal}`, text), embed);
    }
    const result = await index.search(query, embed, [], 8);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.candidates[0]?.conversation_id, "clothing");
    assert.equal(result.candidates[0]?.matches[0]?.entry_id, "jacket");
  } finally { await index.close(); }
});

test("keyword intent prioritizes literal errors while exact references and lexical fallback work in both modes", async () => {
  const index = new SearchIndex(":memory:");
  const query = "ERR_SURFACE_413";
  const literal = "ERR_SURFACE_413 in src/render.rs prevents opening the model.";
  const related = "The application crashes while loading files.";
  const reference = "mail:example:thread-42";
  const vectors = new Map<string, number[]>([[query, [1, 0, 0]], [literal, [0, 1, 0]], [related, [1, 0, 0]]]);
  const embed: Embed = async (texts) => ({ space, vectors: texts.map((text) => {
    const vector = vectors.get(text); assert.ok(vector); return vector;
  }) });
  try {
    await index.upsert("literal", "one", records("error", literal, [reference]), embed);
    await index.upsert("related", "one", records("crash", related), embed);
    assert.equal((await index.search(query, embed)).candidates[0]?.conversation_id, "related");
    assert.equal((await index.search(query, embed, [], 2, "keyword")).candidates[0]?.conversation_id, "literal");
    const modes: SearchMode[] = ["semantic", "keyword"];
    for (const mode of modes) {
      const exact = await index.search(query, embed, [reference], 2, mode);
      assert.equal(exact.candidates[0]?.conversation_id, "literal");
      assert.deepEqual(exact.candidates[0]?.matches[0]?.source_refs, [reference]);
      const fallback = await index.search(query, async () => { throw new Error("Runner offline"); }, [], 2, mode);
      assert.equal(fallback.candidates[0]?.conversation_id, "literal");
      assert.deepEqual(fallback.gaps, ["Runner offline"]);
    }
  } finally { await index.close(); }
});

test("candidate evidence retains distinct original entries instead of overlapping chunks from one long log", async () => {
  const index = new SearchIndex(":memory:");
  const entries: SearchRecord[] = [
    { entry_id: "long-log", ordinal: 0, text: "Connector inspection log. ".repeat(400), source_refs: [] },
    { entry_id: "decision", ordinal: 1, text: "Connector decision: choose variant Z3 after reviewing the fit.", source_refs: [] },
    { entry_id: "verification", ordinal: 2, text: "Connector verification: variant Z3 passed the fit check.", source_refs: [] },
  ];
  const embed: Embed = async (texts) => ({ space, vectors: texts.map((text) => {
    const cosine = text.includes("decision:") ? 0.95 : text.includes("verification:") ? 0.9 : 1;
    return [cosine, Math.sqrt(1 - cosine * cosine), 0];
  }) });
  async function* originals() { yield* entries; }
  try {
    await index.upsert("substantive", "one", originals(), embed);
    const result = await index.search("connector inspection", embed);
    assert.deepEqual(result.gaps, []);
    assert.deepEqual(result.candidates[0]?.matches.map((match) => match.entry_id), ["long-log", "decision", "verification"]);
  } finally { await index.close(); }
});
