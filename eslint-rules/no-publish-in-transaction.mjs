/**
 * ★ Realtime P0 (R2, cwi-rt-20260823-a1) — local ESLint rule: no-publish-in-transaction
 *
 * commit-then-emit 鐵律（見 src/lib/notify.ts 檔頭規則）：
 * publishNotify / publishStaffNotify / publishControl 永遠唔准出現喺
 * `$transaction(async (tx) => { ... })` callback 入面 — tx 回滾時 emit 會產生幻影訊息。
 *
 * 實作：收集所有 $transaction 調用嘅 callback function range，
 * 任何 publish 調用落在 range 內 → report。
 */

const PUBLISH_FUNCS = new Set(["publishNotify", "publishStaffNotify", "publishControl"]);

function eachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) if (v && typeof v.type === "string") fn(v);
    } else if (val && typeof val.type === "string") {
      fn(val);
    }
  }
}

function walkTree(root, fn) {
  fn(root);
  (function rec(node) {
    eachChild(node, (child) => {
      fn(child);
      rec(child);
    });
  })(root);
}

function isTxCall(node) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "$transaction"
  );
}

function publishName(node) {
  if (node.type !== "CallExpression") return null;
  const c = node.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && c.property.type === "Identifier") return c.property.name;
  return null;
}

const noPublishInTransaction = {
  meta: {
    type: "problem",
    docs: {
      description:
        "R2 commit-then-emit：publish 調用唔准喺 $transaction callback 入面（tx 回滾 → 幻影 socket event）",
    },
    schema: [],
    messages: {
      publishInTx:
        "publish 調用唔准喺 $transaction callback 入面 — 移到 transaction 成功 return 之後（見 src/lib/notify.ts 檔頭規則 / R2）",
    },
  },
  create(context) {
    return {
      Program(node) {
        // pass 1：收集 $transaction callback range
        const ranges = [];
        walkTree(node, (n) => {
          if (!isTxCall(n)) return;
          const arg = n.arguments[n.arguments.length - 1];
          if (
            arg &&
            (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression")
          ) {
            ranges.push(arg.range);
          }
        });
        if (ranges.length === 0) return;

        // pass 2：publish 調用落在 tx callback 內 → report
        walkTree(node, (n) => {
          const name = publishName(n);
          if (!name || !PUBLISH_FUNCS.has(name)) return;
          for (const [s, e] of ranges) {
            if (n.range[0] >= s && n.range[1] <= e) {
              context.report({ node: n, messageId: "publishInTx" });
              break;
            }
          }
        });
      },
    };
  },
};

export default noPublishInTransaction;
