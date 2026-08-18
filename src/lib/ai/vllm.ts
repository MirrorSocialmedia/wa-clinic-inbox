/**
 * vLLM client — OpenAI-compatible chat.completions（框架 MD §7.1）。
 *
 * 降級係一等公民（D6）：
 * - 每個 model：超時 AI_TIMEOUT_MS（預設 8000ms）+ 重試 1 次（共 2 次）
 * - primary 兩次都失敗 → fallback model 再 2 次 → 都失敗 = AiCallError（AI degraded）
 * - circuit breaker：連續 3 次 fail → OPEN 60s（期間直接 skip，唔打 GPU 唔排隊）→ half-open 試一次
 *
 * 環境變數：
 * - VLLM_BASE_URL   OpenAI-compatible base（e.g. http://<tailscale-ip>:8000/v1）
 * - VLLM_API_KEY    可選（vLLM 預設唔使 key；有就帶 Bearer）
 * - VLLM_MODEL      primary（預設 Qwen/Qwen2.5-32B-Instruct-AWQ）
 * - VLLM_FALLBACK_MODEL  fallback（預設 Qwen3-30B-A3B）
 * - AI_TIMEOUT_MS   單次 call 超時（預設 8000）
 *
 * ★ AI 永遠本地（D4）：base URL 應該係 Tailscale 私網地址；呢度唔做白名單
 *   （部署層用 Tailscale ACL 限死），但 baseUrl 唔准係 empty（fail-closed）。
 */
import log from "@/lib/log";
import { AiCallError } from "./types";

export interface AiConfig {
  baseUrl: string;
  apiKey: string | null;
  primaryModel: string;
  fallbackModel: string;
  timeoutMs: number;
}

export function getAiConfig(): AiConfig {
  const rawBase = (process.env.VLLM_BASE_URL ?? process.env.AI_BASE_URL ?? "").trim();
  return {
    baseUrl: rawBase.replace(/\/+$/, ""),
    apiKey: process.env.VLLM_API_KEY?.trim() || null,
    primaryModel: process.env.VLLM_MODEL?.trim() || "Qwen/Qwen2.5-32B-Instruct-AWQ",
    fallbackModel: process.env.VLLM_FALLBACK_MODEL?.trim() || "Qwen3-30B-A3B",
    timeoutMs: Math.max(1000, Number(process.env.AI_TIMEOUT_MS ?? 8000) || 8000),
  };
}

// ── Circuit breaker（in-memory，per process） ───────────────────────────

const BREAKER_FAIL_THRESHOLD = 3; // 連續 3 次 fail → OPEN
const BREAKER_OPEN_MS = 60_000; // OPEN 60s → half-open

let breakerState: "closed" | "open" = "closed";
let breakerFailCount = 0;
let breakerOpenUntil = 0;

export function getBreakerState(): { state: "closed" | "open"; openUntilMs: number | null } {
  const state = breakerState === "open" && Date.now() >= breakerOpenUntil ? "closed" : breakerState;
  return {
    state,
    openUntilMs: state === "open" ? breakerOpenUntil : null,
  };
}

function breakerAllow(): boolean {
  if (breakerState === "open") {
    if (Date.now() < breakerOpenUntil) return false; // OPEN 期間直接 skip
    breakerState = "closed"; // half-open：試一次，失敗再 OPEN
    breakerFailCount = BREAKER_FAIL_THRESHOLD - 1; // half-open 失敗一次就再 OPEN
  }
  return true;
}

function breakerRecord(ok: boolean): void {
  if (ok) {
    breakerState = "closed";
    breakerFailCount = 0;
    return;
  }
  breakerFailCount += 1;
  if (breakerFailCount >= BREAKER_FAIL_THRESHOLD) {
    breakerState = "open";
    breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
    log.warn(
      { failCount: breakerFailCount, openMs: BREAKER_OPEN_MS },
      "ai breaker OPEN — 60s 內 skip AI（inbox 照常）"
    );
  }
}

/** Test hook：重置 breaker（mock-e2e / 單測用）。 */
export function __resetBreakerForTest(): void {
  breakerState = "closed";
  breakerFailCount = 0;
  breakerOpenUntil = 0;
}

// ── chat.completions ────────────────────────────────────────────────────

export interface AiChatOptions {
  messages: { role: "system" | "user"; content: string }[];
  /** vLLM guided_json schema（強制結構化輸出） */
  guidedJson?: unknown;
}

export interface AiChatResult {
  content: string;
  model: string;
  tokens: number;
  latencyMs: number;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

async function chatOnce(cfg: AiConfig, model: string, opts: AiChatOptions): Promise<AiChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const t0 = Date.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: opts.messages,
        temperature: 0,
        max_tokens: 600,
        // vLLM 拓展（guidance）：強制合法 JSON 結構
        guided_json: opts.guidedJson,
      }),
    });
    const latencyMs = Date.now() - t0;
    const json = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
    if (!res.ok) {
      // ★ 錯訊只係 server 端錯誤描述（e.g. 404 model not found）— 唔含 prompt 內容，可以入 error
      const msg = json?.error?.message ? ` : ${json.error.message.slice(0, 160)}` : "";
      throw new AiCallError(`vllm ${res.status}${msg} (model=${model}, ${latencyMs}ms)`);
    }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new AiCallError(`vllm empty content (model=${model}, ${latencyMs}ms)`);
    }
    return {
      content,
      model,
      tokens: json?.usage?.total_tokens ?? 0,
      latencyMs,
    };
  } catch (err) {
    if (err instanceof AiCallError) throw err;
    const name = err instanceof Error ? err.name : "unknown";
    const reason = name === "AbortError" ? `timeout ${cfg.timeoutMs}ms` : "network error";
    throw new AiCallError(`vllm ${reason} (model=${model})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * primary（重試 1 次）→ fallback（重試 1 次）→ 都失敗 = throw AiCallError。
 * 成功 / 最終失敗都 record 去 breaker。
 */
export async function chatWithFallback(
  cfg: AiConfig,
  opts: AiChatOptions
): Promise<AiChatResult> {
  if (!cfg.baseUrl) throw new AiCallError("VLLM_BASE_URL 未設定（AI degraded）");
  if (!breakerAllow()) {
    throw new AiCallError("circuit breaker OPEN — AI skipped");
  }

  const models =
    cfg.fallbackModel && cfg.fallbackModel !== cfg.primaryModel
      ? [cfg.primaryModel, cfg.fallbackModel]
      : [cfg.primaryModel];

  let lastErr: AiCallError | null = null;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await chatOnce(cfg, model, opts);
        breakerRecord(true);
        if (model !== cfg.primaryModel) {
          log.warn({ model, latencyMs: r.latencyMs }, "ai call succeeded on fallback model");
        }
        return r;
      } catch (err) {
        lastErr =
          err instanceof AiCallError ? err : new AiCallError(err instanceof Error ? err.message : "unknown error");
        log.warn(
          { model, attempt, err: lastErr.message },
          "ai call attempt failed"
        );
      }
    }
  }
  breakerRecord(false);
  throw lastErr ?? new AiCallError("ai call failed (unknown)");
}
