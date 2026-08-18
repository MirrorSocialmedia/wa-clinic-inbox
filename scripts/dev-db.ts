/**
 * Local dev database — embedded Postgres（沙箱冇 docker 嘅替代方案）。
 *
 * 用法：
 *   pnpm dev:db            # 起 Postgres 並長駐（background 行）
 *   pnpm dev:db:stop       # 停
 *
 * - 首次：initialize（initdb）→ start → 確保 wa_inbox DB 存在
 * - 再起：port 已 ready → 直接 skip（冪等）
 * - 長駐原因：embedded-postgres 嘅 start() 明確「node script 退出時會 shutdown
 *   postgres」，所以 dev:db 必須保持 process 存活。
 *
 * 有 docker 嘅環境（指揮大神）改用 .dev/docker-compose.dev.yml，唔使呢個 script。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const DATABASE_DIR = path.join(ROOT, ".dev", "pgdata");
const PORT = 15432;
const USER = "wa_inbox";
const PASSWORD = "wa_inbox_dev_pw_2026";
const DB = "wa_inbox";

function pgIsReady(): boolean {
  const r = spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", String(PORT), "-q"], {
    timeout: 3000,
  });
  return r.status === 0;
}

async function main(): Promise<void> {
  if (pgIsReady()) {
    console.log(`[dev-db] postgres already ready on 127.0.0.1:${PORT} — skip start`);
  } else {
    const postgres = new EmbeddedPostgres({
      databaseDir: DATABASE_DIR,
      port: PORT,
      user: USER,
      password: PASSWORD,
      persistent: true,
      authMethod: "scram-sha-256",
      onLog: (m) => console.log(`[dev-db:pg] ${m}`),
      onError: (m) => console.error(`[dev-db:pg:err] ${m}`),
    });
    // 已初始化過嘅 data dir（PG_VERSION 存在）→ 只 start，唔好再 initdb
    const alreadyInit = existsSync(path.join(DATABASE_DIR, "PG_VERSION"));
    if (alreadyInit) {
      console.log("[dev-db] existing data dir — start only (no initdb)");
    } else {
      await postgres.initialise();
    }
    await postgres.start();
    console.log(`[dev-db] postgres started on 127.0.0.1:${PORT}`);
  }

  // 確保 DB 存在（首次 initdb 只會建有 user 同名嘅 default DB）
  const client = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: "postgres",
  });
  await client.connect();
  const { rows } = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname = $1",
    [DB]
  );
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${DB}" OWNER "${USER}"`);
    console.log(`[dev-db] created database ${DB}`);
  }
  // pg_trgm（全文搜尋中文 fuzzy 用）— 冪等
  const app = new pg.Client({
    host: "127.0.0.1",
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: DB,
  });
  await app.connect();
  await app.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await app.query(`COMMENT ON DATABASE ${DB} IS 'wa clinic inbox dev db'`).catch(() => undefined);
  await app.end();
  await client.end();
  console.log(`[dev-db] ready — DATABASE_URL=postgresql://${USER}:***@127.0.0.1:${PORT}/${DB}`);
}

// 長駐：embedded-postgres 需要 parent process 存活（佢用 exit hook 管理 postgres 子 process）。
main()
  .then(() => {
    console.log("[dev-db] staying alive (postgres will stop when this process exits)");
    setInterval(() => undefined, 1 << 30);
  })
  .catch((err) => {
    console.error("[dev-db] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
