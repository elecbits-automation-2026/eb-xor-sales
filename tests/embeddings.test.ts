/**
 * The keyless hash embedder: deterministic, correctly dimensioned,
 * unit-normalised, and orders similarity sensibly (same-topic text closer
 * than unrelated text). These properties are what pgvector cosine search
 * relies on.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { embed, embedderId, embeddingsAvailable } from "@/lib/embeddings";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are unit-normalised
}

describe("hash embeddings (keyless default)", () => {
  beforeEach(() => {
    delete process.env.EMBEDDINGS_PROVIDER;
    delete process.env.EMBEDDINGS_API_KEY;
    delete process.env.EMBEDDINGS_DIM;
  });

  it("is available with no key configured", () => {
    expect(embeddingsAvailable()).toBe(true);
    expect(embedderId()).toBe("hash:1536");
  });

  it("returns deterministic unit vectors of the configured dimension", async () => {
    const [a] = await embed(["a 4G GPS tracker for fleet two-wheelers"]);
    const [b] = await embed(["a 4G GPS tracker for fleet two-wheelers"]);
    expect(a).toHaveLength(1536);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("ranks same-topic text above unrelated text", async () => {
    const [query, onTopic, offTopic] = await embed([
      "gps tracker device for vehicles",
      "GPS tracking device for vehicle fleets with 4G connectivity",
      "paneer pakoda recipe with mint chutney",
    ]);
    expect(cosine(query, onTopic)).toBeGreaterThan(cosine(query, offTopic));
  });

  it("handles empty text without NaNs", async () => {
    const [v] = await embed([""]);
    expect(v).toHaveLength(1536);
    expect(v.every((x) => x === 0)).toBe(true);
  });
});
