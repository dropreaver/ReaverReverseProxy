export type Provider = "openai" | "anthropic";

export interface Route {
  provider: Provider;
  path: string;
  providerPrefixed?: boolean;
}

export const budgetFields: Record<string, string[] | undefined> = {
  "/v1/messages": ["max_tokens"],
  "/v1/responses": ["max_output_tokens"],
  "/v1/chat/completions": ["max_completion_tokens", "max_tokens"],
};

export const tokenCountPaths = new Set(["/v1/responses/input_tokens", "/v1/messages/count_tokens"]);

const openaiPosts = new Set([
  "/v1/responses",
  "/v1/responses/input_tokens",
  "/v1/responses/compact",
  "/v1/chat/completions",
  "/v1/decisions",
  "/v1/embeddings",
  "/v1/moderations",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
]);
const anthropicPosts = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

export function resolveRoute(method: string, pathname: string): Route | undefined {
  const match = /^\/(?:(openai|anthropic)\/)?(v1\/[^?#]+)$/.exec(pathname);
  if (!match) return;
  const path = "/" + match[2];
  const prefix = match[1];
  if (method === "POST") {
    if (prefix !== "anthropic" && openaiPosts.has(path)) return { provider: "openai", path, providerPrefixed: !!prefix };
    if (prefix !== "openai" && anthropicPosts.has(path)) return { provider: "anthropic", path, providerPrefixed: !!prefix };
  }
  if (method !== "GET") return;
  const provider = prefix === "anthropic" ? "anthropic" : "openai";
  if (path === "/v1/models") return { provider, path };
  if (!path.startsWith("/v1/models/")) return;
  let model: string;
  try {
    model = decodeURIComponent(path.slice("/v1/models/".length));
  } catch {
    return;
  }
  // A single model ID can contain colons in OpenAI fine-tune identifiers.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)) return;
  return { provider, path: "/v1/models/" + encodeURIComponent(model) };
}
