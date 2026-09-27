// cwi G3 — 手動觸發 followup-scan（cronHeavyQueue）核 workforce 恢復後零 DEP_FAIL
import { cronHeavyQueue } from "../src/lib/queue";
(async () => {
  const j = await cronHeavyQueue.add("followup-scan", { manual: "g3-probe-3" }, { jobId: "g3-probe-followup-3" });
  console.log("ENQUEUED", j.id);
  process.exit(0);
})();
