/**
 * ★ Fix B（cwi-fix-20260825-f1）：cache:bust 控制指令嘅共用 handler。
 * web（hub.ts initControlBridge）同 worker（workers/index.ts 自己訂閱）都調呢個 —
 * 避免兩邊各 switch 一次將來 drift。
 */
import { clearAutomationLevelCache, clearPainTriageCache } from "@/lib/ai/automation";
import { bustParamsCache } from "@/lib/workflow/store";
import { bustKnowledgeCache } from "@/lib/knowledge/catalog";
import log from "@/lib/log";

export function applyCacheBust(scope: "automation" | "workflow" | "knowledge"): void {
  if (scope === "automation") {
    clearAutomationLevelCache();
    clearPainTriageCache(); // ★ cwi-final S4-3：pain triage 60s cache 同 bust（PAIN_TRIAGE row 改動即時生效）
  } else if (scope === "workflow") bustParamsCache();
  else if (scope === "knowledge") bustKnowledgeCache();
  log.info({ scope }, "control: cache:bust applied");
}
