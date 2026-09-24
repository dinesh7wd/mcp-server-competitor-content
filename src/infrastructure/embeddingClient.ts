import type { AppConfig } from "../config.js";
import { ErrorCodes, McpError } from "../utils/errors.js";
import type { HttpClient } from "./httpClient.js";

export interface EmbeddingClient {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export function createEmbeddingClient(http: HttpClient, config: AppConfig): EmbeddingClient | null {
  if (!config.embeddingProvider || !config.embeddingApiKey) return null;
  const provider = config.embeddingProvider;
  const apiKey = config.embeddingApiKey;
  const model = config.embeddingModel;
  return {
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      if (provider === "openai") {
        const res = await http.request({
          url: "https://api.openai.com/v1/embeddings",
          method: "POST",
          timeoutMs: config.httpTimeoutMs,
          retries: config.httpRetries,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, input: texts }),
        });
        if (res.status !== 200) {
          throw new McpError(ErrorCodes.InternalError, `Embeddings HTTP ${res.status}`);
        }
        const data = JSON.parse(res.body) as { data?: Array<{ embedding: number[] }> };
        return (data.data ?? []).map((d) => d.embedding);
      }
      throw new McpError(ErrorCodes.ProviderConfig, `Unsupported embedding provider: ${provider}`);
    },
  };
}
