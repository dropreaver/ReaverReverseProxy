# RisuAI model proxy

Use your OpenAI and Anthropic API accounts from RisuAI. The proxy keeps provider keys on the server. Clients authenticate with a proxy token and can share one. Requests use the provider's native API format, including JSON responses and server-sent events.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Public process health check |
| `GET` | `/v1/models` | Combined catalog from configured providers |
| `GET` | `/v1/usage/models` | Model usage for the authenticated proxy token since this gateway process started |
| `GET` | `/openai/v1/models` | Native OpenAI catalog |
| `GET` | `/anthropic/v1/models` | Native Anthropic catalog |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages |

Use a model ID from the appropriate provider's live catalog. The catalog shows models visible to the API account. Inference also requires an endpoint and input the gateway can check against the token limits. The three chat routes accept new provider model IDs. See [server limits](#server-limits).

### Image input

Image recognition is disabled on every model through this gateway. You can send a message containing both text and an image. The proxy removes the image before contacting OpenAI or Anthropic and sends the accompanying text. For example, a user turn with two text blocks separated by a photo keeps both text blocks in their original order. The same filtering applies to streaming, native provider routes, tool results and standalone token counts.

PDFs, opaque file IDs and references to stored conversation history can also supply images. The gateway drops those references and forwards the inline text. It preserves inline plain-text Claude documents and converts supported inline UTF-8 `text/plain` file parts into text. Send any history or document text you want the model to use directly in the request. If the latest user turn contains only an image or an omitted reference, the proxy returns HTTP 400 locally and the request consumes no generation slot. The inbound body size limit still applies before filtering.

### Compact chat responses

Plain text generation on `/v1/responses`, `/v1/messages` and `/v1/chat/completions` returns the model, visible answer or refusal, and the small set of protocol fields used to read the reply. This applies to both JSON and streaming. A `parameters` object reports recognized generation controls supplied in the request, including a token cap added by the gateway. An empty object means the request used provider defaults for these controls. Streaming reports parameters at the start.

The gateway writes `model` first in compact JSON replies and in streaming payloads that carry a model name. OpenAI Responses and Anthropic Messages carry it inside the event's `response` and `message` objects, respectively. Compact replies omit tokenizer metadata.

The `usage` object contains `input_tokens`, `output_tokens`, and `total_tokens` from the provider. Claude's input count includes uncached, cache-read and cache-write tokens. Output includes any reasoning tokens already counted by the provider. Unknown counts are `null`. The gateway omits detailed usage breakdowns, reasoning blocks, signatures, billing and diagnostics. [Anthropic cache accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#how-do-i-calculate-total-input-tokens-from-the-usage-fields)

For streaming, read the final Responses lifecycle event's `response.usage`, the last Claude `message_delta.usage`, or the Chat Completions chunk with `choices: []` immediately before `[DONE]`. Chat Completions streaming requests enable `stream_options.include_usage` by default on compact and native routes, including tool calls. An explicit `false` is respected and usually yields unknown counts. Interrupted streams can end before final usage is available. [OpenAI streaming usage](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

For the full native format, including usage breakdowns, citations and signed reasoning for continuing a tool interaction, use `/openai/v1/responses`, `/openai/v1/chat/completions` or `/anthropic/v1/messages`. These paths enforce the same quotas. Use them with SDK helpers that expect a complete provider object, such as Anthropic's streaming message accumulator. Supported requests with client-executed tools, background processing, token log probabilities or additional provider output also use the native format. The special inclusion of `reasoning.encrypted_content` by itself on the ordinary text route still produces compact output.

## Run the proxy locally

Use Node.js 24. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or both. Generate a proxy token and save it as `PROXY_TOKENS`. To issue several tokens, use a comma-separated list.

Each provider variable accepts one key or a comma-separated list in the desired order. For example, in the Render service's **Environment** settings, enter `first-openai-key,second-openai-key` as the value of `OPENAI_API_KEY` and `first-claude-key,second-claude-key` as the value of `ANTHROPIC_API_KEY`. Replace the examples with your keys and save and deploy the changes. Spaces around keys, empty entries and duplicates are ignored.

Each gateway process rotates through the eligible keys in each provider's list in order. One generation keeps the same key for input counting and inference, including streaming. A provider error is returned to the caller. The gateway never replays that request with a different key. Quota rejections before admission and combined model-list cache hits consume no turn. A catalog refresh uses one key per provider across its pages.

When a provider reports an exhausted key, the gateway keeps it in the configured list and skips it on subsequent requests. A temporary rate limit expires at the provider's retry or reset time, or after 60 seconds if the provider gives no time. A confirmed Anthropic monthly spend cap expires on the first day of the next month at 00:00 UTC. For exhausted credits or a hard spending limit without a reset time, restore the account's balance or raise the limit and restart the gateway to make the key eligible again. Ordinary authentication errors, missing models and provider outages do not change eligibility.

If all keys for a provider are excluded, a request requiring that provider returns HTTP 429 without contacting it. The response includes `Retry-After` when a key has a known return time. The other provider can still serve requests. Exclusions are held in process memory, so restarting or redeploying the gateway makes every configured key eligible again. The user's generation count is tracked separately.

Use keys with equivalent model access. RisuAI sends the proxy token on each turn.

```powershell
Copy-Item .env.example .env
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

Set `ALLOWED_ORIGINS` to the exact origin of each browser client, including its scheme and any non-default port. The example file assumes RisuAI runs at `http://localhost:5173`. The server also accepts exact origins in the optional comma-separated `ADDITIONAL_ALLOWED_ORIGINS` list. When both lists are empty, only clients that omit the Origin header can connect. Start the server after saving the file.

```powershell
node --env-file=.env src/server.ts
```

The example configuration serves the API at `http://localhost:3000`. Use RisuAI Desktop or a local RisuAI Node server for loopback access. The pinned static browser client blocks non-streaming requests to loopback addresses before sending them, even with Force Plain Fetch and a matching CORS entry. Use the proxy's public HTTPS URL with that client. [RisuAI browser request handling](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/ts/globalApi.svelte.ts#L691-L706)

If your provider keys already live in a local `API.txt`, you can set `PROVIDER_KEYS_FILE=API.txt` in `.env`. The file has one unquoted provider key per line. For a provider whose environment list is empty, the first matching file entry supplies its key.

## Deploy on Render

The Blueprint creates a free Node.js web service named `reaver-proxy` and a static site named `risu-chat`. The site builds unmodified RisuAI release `v2026.10.295` from commit `4d87a70ffb325db84dd35cb1b76b31d7074da156`, using its locked dependencies and pnpm 11.28.10. Browser storage holds local chats and settings. [RisuAI release](https://github.com/kwaroran/RisuAI/releases/tag/v2026.10.295) · [Upstream build workflow](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/.github/workflows/nightly-deploy.yml#L22-L52)

1. In Render, select **New → Blueprint** and connect the Git repository containing `render.yaml`. The template prompts for both provider keys. For a single-provider deployment, remove the unused provider's two-line entry from the Blueprint before the first sync. Later, you can add that provider key under the web service's **Environment** tab.
2. Set the selected provider keys on **reaver-proxy**. Render generates `PROXY_TOKENS`. On **risu-chat**, set the build-time flag `VITE_RISU_LEGAL_CONFIGURED=TRUE` if this is your personal self-host of the original source or you have completed the upstream requirements for your hosted service. Leaving the flag unset displays RisuAI's setup notice. Rebuild the static site after changing a build-time value. [RisuAI hosting notice](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/lib/Others/Legal.svelte#L58-L76)
3. The Blueprint sets `ALLOWED_ORIGINS` to the Render static site's actual `RENDER_EXTERNAL_URL` and `ADDITIONAL_ALLOWED_ORIGINS` to `https://risuai.xyz`. You can use either browser client with your proxy token. For a custom frontend domain, edit the comma-separated `ADDITIONAL_ALLOWED_ORIGINS` in the Blueprint. To allow only your Render frontend, set that value to an empty string. Sync the Blueprint and redeploy the backend after changing the list. [Render Blueprint service references](https://render.com/docs/blueprint-spec#referencing-service-properties) · [Render public service URLs](https://render.com/docs/environment-variables#render_external_url)
4. Copy the web service's actual public HTTPS URL for the RisuAI endpoint and one `PROXY_TOKENS` value for **Key/Password**. Open the static site's URL to configure RisuAI. Keep provider keys in the web service environment.

For an existing RisuAI installation, deploy the Node web service alone with build command `node --version`, start command `node src/server.ts`, Node 24 and health path `/healthz`. Supply the server variables from `.env.example` and allow the existing browser client's exact origin.

## Connect RisuAI

1. In the browser client, open **Advanced Settings**, turn on **Show Unrecommended Settings**, then **Force Plain Fetch**. This sends generation requests directly from the browser to your proxy. Leave Local Network Mode off for a public Render proxy. [RisuAI fetch settings](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/ts/setting/advancedSettingsData.ts#L240-L245)
2. Open **Advanced Settings → Custom Models → +** and create a named entry for each model you want to select. Use the table below. Enter a friendly **Name**, the exact provider ID in **Request Model**, the full HTTPS endpoint in **URL**, and a proxy token in **Key/Password**. Replace `<proxy>` with the web service's HTTPS origin. [Named model editor](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte#L85-L167)
3. In the model picker, select each entry under **Custom Models**. You can independently assign entries to **Model** and **Auxiliary Model**. To add a newly released model, update the request ID or add another named entry and choose the format that model supports. [Model picker](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/lib/UI/ModelList.svelte#L90-L95)

| Provider API | Format in Custom Models | Full endpoint | Per-model flags to start with |
| --- | --- | --- | --- |
| OpenAI Responses | `OpenAIResponseAPI` | `<proxy>/v1/responses` | `hasStreaming`, `hasFullSystemPrompt` |
| OpenAI Chat Completions | `OpenAICompatible` | `<proxy>/v1/chat/completions` | `hasStreaming`, `hasFullSystemPrompt`. Enable `OAICompletionTokens` when the model requires `max_completion_tokens`. |
| Anthropic Messages | `Anthropic` | `<proxy>/v1/messages` | `hasStreaming`, `hasFirstSystemPrompt`. Enable `claudeAdaptiveThinking` for models that support it. |

Named entries start with empty flags. Leave `hasImageInput` off for this proxy. Choose the tokenizer for the model and set context and output token limits suitable for the provider. Also enable RisuAI's normal streaming setting to see streamed text. The simpler **Custom API** picker supports **OpenAI Compatible**, **OpenAI Response API**, and **Anthropic Claude**, but shares one URL, key, model ID and format across slots. In this release its Anthropic mode flattens each conversation message to its first text block. [Custom API settings](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/lib/Setting/Pages/BotSettings.svelte#L220-L249) · [Anthropic message handling](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/ts/process/request/anthropic.ts#L338-L359)

### Samplers and reasoning

RisuAI gives each named model a generic sampler list. In **Additional Parameters**, `field={{none}}` removes a top-level field before sending the request. For a recent reasoning model that rejects sampling controls, start with the following lines. For Chat Completions add `logit_bias={{none}}` if needed. For models that accept a sampler, remove its override to use the RisuAI slider. [RisuAI parameter removal](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/ts/process/request/shared.ts#L79-L110)

```text
temperature={{none}}
top_p={{none}}
top_k={{none}}
top_a={{none}}
min_p={{none}}
repetition_penalty={{none}}
frequency_penalty={{none}}
presence_penalty={{none}}
thinking_tokens={{none}}
```

For OpenAI Responses models supporting adjustable reasoning, set `reasoning.effort="high"` when desired. Chat Completions uses the top-level `reasoning_effort="high"` on supported models. For Claude models supporting adaptive thinking, select RisuAI's adaptive mode and the model's applicable flags. To leave thinking and effort at the provider defaults, remove their top-level objects with `thinking={{none}}` and `output_config={{none}}` on separate lines. The compact chat response shows the final answer. Available controls and accepted values depend on the selected model. [RisuAI Responses event handling](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/ts/process/request/openAI/responses.ts#L620-L655) · [Claude thinking options](https://github.com/kwaroran/RisuAI/blob/4d87a70ffb325db84dd35cb1b76b31d7074da156/src/ts/process/request/anthropic.ts#L364-L393)

## Check a deployment

In PowerShell 7, set the actual web service URL and enter one proxy token when prompted. The health check and catalog calls below create no model generations.

```powershell
$proxyUrl = 'https://your-proxy.onrender.com'
$token = Read-Host -Prompt 'Proxy token' -MaskInput
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod "$proxyUrl/healthz"
(Invoke-RestMethod "$proxyUrl/v1/models" -Headers $headers).data | Select-Object provider,id,owned_by
```

To inspect Claude's own model metadata, request `GET /anthropic/v1/models/<model-id>` with the proxy token and the `anthropic-version` header for the API version you use. Model entries in the combined list identify the provider, while the native detail route returns the provider's original metadata. [Anthropic model details](https://platform.claude.com/docs/en/api/models/retrieve)

Send a short text from RisuAI and inspect the browser's Network panel. Its POST should target the selected path on the web service. JSON is returned for ordinary requests and `text/event-stream` for streaming. For a CORS error, compare the browser's `Origin` with the deployed web service's `ALLOWED_ORIGINS` and `ADDITIONAL_ALLOWED_ORIGINS`. A 401 calls for checking the proxy token and the relevant provider credentials. A provider error naming an unsupported field calls for adjusting the model entry's flags or additional parameters.

## Model usage

Send `GET /v1/usage/models` with the same `Authorization: Bearer <proxy-token>` or `x-api-key` header you use for generation. The response gives the UTC start time in `since` and one row per provider and model in `data`. People sharing a proxy token see its combined totals. Model listings, token estimates and usage-report reads do not consume a generation slot.

Each generation with observed usage contributes one to `requests`. The model ID comes from the provider reply, with the requested model as a fallback. Rows contain `input_tokens`, `output_tokens`, `total_tokens` and `incomplete_requests`. Cumulative streaming updates contribute once per request. A stream that ends early contributes the counts reported so far and increments `incomplete_requests` when final usage is missing. A token field is `null` if no request in the row reported that metric. Rows with incomplete reports can understate actual consumption. The request limit continues to apply across models.

The live endpoint starts a new reporting window when the service restarts. The gateway also writes one structured `token_usage` record per counted generation to its existing application log. To group usage across proxy tokens, instances and restarts, run the following from the repository on a computer with a Render API key in `RENDER_API_KEY` that can read the service and its logs. Set `RENDER_SERVICE_ID` to your proxy’s service ID from the Render dashboard. The command queries the previous seven days, which is the Hobby workspace's log retention period, and follows all result pages. It covers generations recorded since this feature was deployed. [Render log retention](https://render.com/docs/logging#retention-period) · [Render logs API](https://api-docs.render.com/reference/list-logs)

```sh
node scripts/model-usage.mjs --render
```

You can also use the Render dashboard without an API key. Open the proxy's **Logs** page, select the time range, filter for `token_usage`, and copy the displayed log lines. In PowerShell, the following command summarizes the copied records. For a complete window with many pages, use the API command above.

```powershell
Get-Clipboard | node scripts/model-usage.mjs --stdin
```

## Server limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_ACTIVE_PER_USER` | `8` | Concurrent requests per proxy token and client IP |
| `REQUESTS_PER_MINUTE` | `3` | Generations with observed usage per proxy token and client IP in a rolling 60-second window across both providers |
| `MAX_BODY_BYTES` | `33554432` | Maximum inbound request size in bytes |
| `OPENAI_MAX_INPUT_TOKENS` | `100000` | Input tokens per OpenAI Responses or Chat Completions request |
| `OPENAI_MAX_OUTPUT_TOKENS` | `10000` | OpenAI output tokens per request, including reasoning and all requested Chat Completions choices |
| `ANTHROPIC_MAX_INPUT_TOKENS` | `100000` | Input tokens per Anthropic Messages request |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | `10000` | Anthropic output tokens per request, including thinking |

Set the four provider variables independently. When a provider variable is unset, the proxy reads the legacy `MAX_INPUT_TOKENS` or `MAX_OUTPUT_TOKENS` for that field, then uses the table default. `MAX_ACTIVE_PER_TOKEN` is also accepted as a fallback for `MAX_ACTIVE_PER_USER`.

One shared `PROXY_TOKENS` credential gives each public client IP its own allowance across GPT and Claude. People on the same Wi-Fi or VPN share that window if their public IP and credential match. Changing public IP starts a separate window. RisuAI's direct browser requests work with the existing key and URL.

The public Render service uses the edge-provided `CF-Connecting-IP`. Render's Free web service accepts public ingress and cannot receive private network traffic. A local instance uses its TCP peer address. Missing or invalid addresses on the Render service share one fallback quota per credential. IPs are held in memory for rate limiting and are omitted from application logs. [Render client IP handling](https://render.com/articles/host-pocketbase-on-render#making-pocketbase-see-the-real-client-ip) · [Render Free networking](https://render.com/docs/free#other-limitations)

Each admitted generation temporarily reserves one slot. It counts once if the provider reports positive usage or sends generated output, including partial text, a refusal, reasoning or a tool call. Positive input or cache usage alone counts even with zero output. A later error, interruption or client cancellation keeps that charge. The proxy checks the original provider data before filtering the response for RisuAI.

The slot is released when the request ends without evidence of usage. This includes validation and preflight failures, provider errors with no reported usage or generated content, and a disconnect before such evidence arrives. An interrupted stream can omit its final usage report. The count is based on the data received by the proxy. [OpenAI streaming usage](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [Claude streaming events](https://platform.claude.com/docs/en/build-with-claude/streaming)

While all three slots are occupied, another generation returns HTTP 429 with `Retry-After` in seconds. Model listings and input-token estimates use zero generation slots. The gateway's request log records `generation_counted` for each admitted generation. Each running process maintains its own window in memory. The Render deployment uses one instance and a restart clears its window.

The gateway checks input before generation. OpenAI Responses and Claude Messages use their providers' token-count endpoints. Anthropic describes its result as an estimate that can differ slightly from final usage. An input over the configured limit returns HTTP 413. Token-count failures stop the request before inference. [OpenAI input counting](https://developers.openai.com/api/docs/guides/token-counting) · [Claude token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)

Chat Completions uses a conservative input estimate based on UTF-8 bytes and message framing for short text and inline function definitions. For long plain-text conversations, the proxy asks OpenAI to count the equivalent Responses input on the same model and reserves extra tokens for differences in formatting. Long requests with tool schemas or named messages can reach the conservative limit earlier. The response's `usage` still reports the provider's actual usage.

An omitted output limit defaults to the proxy ceiling. A smaller requested limit is honored. An explicit limit above the ceiling returns HTTP 400. Chat Completions divides the output budget among the requested choices (`n`). Each model's own limits also apply.

The gateway rejects dedicated image, audio, Realtime, embeddings, moderation, Decisions and standalone compaction routes with HTTP 403. It also rejects chat features whose input or output cannot be checked, including hosted search tools and mutable external media URLs. Streaming and provider-prefixed chat routes follow the same admission checks. Logs contain request metadata. Provider credentials, proxy tokens and conversation bodies belong outside operational logs.
