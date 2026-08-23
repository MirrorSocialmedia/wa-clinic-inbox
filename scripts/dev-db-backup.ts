/**
 * dev-db-backup — 本地 harness（15432）全庫 SQL dump（restorable）。
 *
 * ★ Realtime P0 (cwi-rt-20260823-a1)：iron rule 要求 migrate deploy 前 pg_dump 備份。
 * 但 host 只有 pg_dump 16，embedded server 係 Postgres 18.4 — pg_dump 16 拒講
 * （"server version mismatch"）。呢個 script 用 node-postgres 做等價全量 dump：
 *   1) extensions  2) enums  3) tables（FK 依賴 topological order，pg_get_tabledef）
 *   4) indexes（非 constraint） 5) data（INSERT，型別感知 escape） 6) sequences setval
 * 輸出：.dev/backups/wa_inbox_<ts>.sql — 用 psql 可以還原落任何 v18 庫。
 *
 * 用法：pnpm tsx scripts/dev-db-backup.ts [output.sql]
 *   （唔傳參 → 自動 .dev/backups/wa_inbox_YYYYMMDD_HHMM.sql）
 */
import pg from "pg";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.join(import.meta.dirname, "..");
const CFG = {
  host: "127.0.0.1",
  port: 15432,
  user: "wa_inbox",
  password: "wa_inbox_dev_pw_2026",
  database: "wa_inbox",
};

function q(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
/** standard_conforming_strings=on 下：只需要 double single quote（backslash 係字面量） */
function lit(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function escValue(v: unknown, dataType: string): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return lit(v.toISOString());
  if (Buffer.isBuffer(v)) return `'\\x${v.toString("hex")}'::bytea`;
  if (v instanceof Uint8Array) return `'\\x${Buffer.from(v).toString("hex")}'::bytea`;
  if (Array.isArray(v)) {
    // Postgres 陣列字面量 {a,b}
    if (v.length === 0) return "'{}'";
    const items = v.map((x) => {
      if (x === null) return "NULL";
      const s = String(x);
      if (/^[a-z0-9_\-.,+ ]*$/i.test(s)) return s;
      return lit(s);
    });
    return `{${items.join(",")}}`;
  }
  switch (dataType) {
    case "integer":
    case "bigint":
    case "smallint":
    case "numeric":
    case "double precision":
    case "real":
      return String(v);
    case "boolean":
      return v ? "TRUE" : "FALSE";
    case "json":
    case "jsonb":
      return lit(JSON.stringify(v)) + `::${dataType}`;
    case "uuid":
      return lit(String(v));
    case "timestamp with time zone":
    case "timestamp without time zone":
    case "date":
    case "time with time zone":
    case "time without time zone":
      return lit(String(v));
    default:
      return lit(String(v));
  }
}

async function main(): Promise<void> {
  const client = new pg.Client(CFG);
  await client.connect();

  const out: string[] = [];
  out.push(`-- wa_inbox dev harness dump（restorable）`);
  out.push(`-- generated: ${new Date().toISOString()} by scripts/dev-db-backup.ts`);
  out.push(`-- 注意：host pg_dump 16 無法連 v18 server — 呢個係 repo 內 node-postgres 等價 dump（cwi-rt-20260823-a1）`);
  out.push(`SET standard_conforming_strings = on;`);
  out.push(``);

  // 1) extensions
  const exts = await client.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`
  );
  for (const e of exts.rows) out.push(`CREATE EXTENSION IF NOT EXISTS ${e.extname};`);

  // 2) enums
  const enums = await client.query<{ typname: string; labels: string }>(
    `SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
     FROM pg_type t
     JOIN pg_enum e ON e.enumtypid = t.oid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     GROUP BY t.typname`
  );
  for (const en of enums.rows) out.push(`CREATE TYPE ${q(en.typname)} AS ENUM (${en.labels});`);
  out.push(``);

  // 3) tables — FK topological order
  const tables = await client.query<{ oid: string; relname: string }>(
    `SELECT c.oid::text, c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`
  );
  const fks = await client.query<{ conrelid: string; confrelid: string }>(
    `SELECT conrelid::text, confrelid::text FROM pg_constraint
     WHERE contype = 'f' AND connamespace = 'public'::regnamespace`
  );
  const byOid = new Map(tables.rows.map((t) => [t.oid, t.relname]));
  const dep = new Map<string, Set<string>>(); // table oid -> oids it references
  for (const f of fks.rows) {
    if (!byOid.has(f.conrelid) || !byOid.has(f.confrelid)) continue;
    if (!dep.has(f.conrelid)) dep.set(f.conrelid, new Set());
    dep.get(f.conrelid)!.add(f.confrelid);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const visit = (oid: string): void => {
    if (done.has(oid)) return;
    done.add(oid);
    for (const d of dep.get(oid) ?? []) visit(d);
    ordered.push(oid);
  };
  for (const t of tables.rows) visit(t.oid);

  for (const oid of ordered) {
    const name = byOid.get(oid)!;
    const cols = await client.query<{ attname: string; type: string; notnull: boolean; def: string | null }>(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [name]
    );
    const cons = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass`,
      [`public.${q(name)}`]
    );
    const parts = cols.rows.map(
      (c) =>
        `${q(c.attname)} ${c.type}${c.notnull ? " NOT NULL" : ""}${c.def ? ` DEFAULT ${c.def}` : ""}`
    );
    parts.push(...cons.rows.map((c) => c.def));
    out.push(`CREATE TABLE ${q(name)} (\n  ${parts.join(",\n  ")}\n);`);
  }

  // 4) indexes（唔含 constraint — 已喺 table def 入面）
  const idx = await client.query<{ def: string }>(
    `SELECT pg_get_indexdef(i.indexrelid) AS def
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND i.indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0)`
  );
  for (const r of idx.rows) out.push(`${r.def};`);
  out.push(``);

  // 5) data
  const colInfo = await client.query<{ table: string; column: string; data_type: string }>(
    `SELECT table_name AS table, column_name AS column, data_type
     FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  );
  const colsByTable = new Map<string, { name: string; type: string }[]>();
  for (const c of colInfo.rows) {
    if (!colsByTable.has(c.table)) colsByTable.set(c.table, []);
    colsByTable.get(c.table)!.push({ name: c.column, type: c.data_type });
  }
  for (const oid of ordered) {
    const name = byOid.get(oid)!;
    const cols = colsByTable.get(name);
    if (!cols) continue;
    const data = await client.query(`SELECT * FROM ${q(name)}`);
    if (data.rows.length === 0) {
      out.push(`-- ${name}: 0 rows`);
      continue;
    }
    out.push(`-- ${name}: ${data.rows.length} rows`);
    const colList = cols.map((c) => q(c.name)).join(", ");
    const rows = data.rows.map((r: Record<string, unknown>) =>
      `(${cols.map((c) => escValue(r[c.name], c.type)).join(", ")})`
    );
    // 100 行一批
    for (let i = 0; i < rows.length; i += 100) {
      out.push(`INSERT INTO ${q(name)} (${colList}) VALUES ${rows.slice(i, i + 100).join(", ")};`);
    }
  }

  // 6) sequences（此 build 嘅 pg_sequence 冇 last_value 欄 — 庫入面本身 0 個 sequence，fail 就跳過）
  try {
    const seqs = await client.query<{ seqrelid: string; last_value: string; is_called: string }>(
      `SELECT s.seqrelid::text, s.last_value::text AS last_value, s.is_called::text AS is_called
       FROM pg_sequence s
       JOIN pg_class c ON c.oid = s.seqrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'`
    );
    for (const s of seqs.rows) {
      out.push(`SELECT pg_catalog.setval(${s.seqrelid}::oid::regclass, ${s.last_value}, ${s.is_called === "t" || s.is_called === "true"});`);
    }
  } catch {
    out.push(`-- sequences: skipped（此 PG build 嘅 pg_sequence 無 last_value 欄；庫內 0 個 sequence）`);
  }

  const file =
    process.argv[2] ??
    path.join(ROOT, ".dev", "backups", `wa_inbox_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "_")}.sql`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join("\n") + "\n");
  console.log(`[dev-db-backup] wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(1)} KB, ${tables.rows.length} tables, ${idx.rows.length} indexes)`);
  await client.end();
}

main().catch((err) => {
  console.error("[dev-db-backup] failed:", err);
  process.exit(1);
});
