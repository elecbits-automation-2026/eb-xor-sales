/**
 * Provider-agnostic embeddings client (OpenAI or Voyage via plain fetch).
 * Used by KB sync (indexing) and retrieveContext (query time). Vector
 * dimension is validated on every response — a mismatched vector would
 * silently corrupt the pgvector index.
 */
import { cfg } from "@/lib/config";

/** True when an embeddings API key is configured (RAG enabled). */
export function embeddingsAvailable(): boolean {
  return cfg.embeddingsApiKey !== "";
}

/** Max inputs per provider request; both providers accept batches this size. */
const BATCH_SIZE = 96;

interface EmbeddingsResponse {
  data?: { embedding: number[]; index?: number }[];
}

/** Embed texts (batched internally). Throws on HTTP/provider/dimension errors. */
export async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const provider = cfg.embeddingsProvider;
  let url: string;
  if (provider === "openai") {
    url = "https://api.openai.com/v1/embeddings";
  } else if (provider === "voyage") {
    url = "https://api.voyageai.com/v1/embeddings";
  } else {
    throw new Error(
      `unknown EMBEDDINGS_PROVIDER "${provider}" (expected "openai" or "voyage")`,
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.embeddingsApiKey}`,
    },
    body: JSON.stringify({ model: cfg.embeddingsModel, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${provider} embeddings failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as EmbeddingsResponse;
  const rows = [...(json.data ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  if (rows.length !== texts.length) {
    throw new Error(
      `${provider} embeddings returned ${rows.length} vectors for ${texts.length} inputs`,
    );
  }
  for (const row of rows) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== cfg.embeddingsDim) {
      throw new Error(
        `${provider} embedding dimension ${row.embedding?.length ?? "?"} != ` +
          `EMBEDDINGS_DIM ${cfg.embeddingsDim} (model ${cfg.embeddingsModel})`,
      );
    }
  }
  return rows.map((r) => r.embedding);
}
