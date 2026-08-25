/**
 * ★ Fix B（cwi-fix-20260825-f1）：cache:bust 控制指令嘅共用 handler。
 * web（hub.ts initControlBridge）同 worker（workers/index.ts 自己訂閱）都調呢個 —
 * 避免兩邊各 switch 一次將來 drift。
 */
import { clearAutomationLevelCache } from "@/lib/ai/automation";
import { bustParamsCache } from "@/lib/workflow/store";
import log from "@/lib/log";

export function applyCacheBust(scope: "automation" | "workflow"): void {
  if (scope === "automation") clearAutomationLevelCache();
  else bustParamsCache();
  log.info({ scope }, "control: cache:bust applied");
}
