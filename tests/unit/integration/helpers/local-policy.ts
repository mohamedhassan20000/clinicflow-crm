import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function localDatabaseContainer(): string {
  const config = readFileSync("supabase/config.toml", "utf8");
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!projectId) throw new Error("supabase/config.toml must declare project_id");
  return `supabase_db_${projectId}`;
}

export function readLocalPolicyQual(table: string, policy: string): string {
  const sql = [
    "select coalesce(qual, '')",
    "from pg_policies",
    "where schemaname = 'public'",
    `  and tablename = '${table.replaceAll("'", "''")}'`,
    `  and policyname = '${policy.replaceAll("'", "''")}'`,
  ].join("\n");

  const expression = execFileSync(
    "docker",
    [
      "exec",
      localDatabaseContainer(),
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-Atc",
      sql,
    ],
    { encoding: "utf8" },
  ).trim();

  if (!expression) {
    throw new Error(`Policy ${policy} on public.${table} is not installed`);
  }
  return expression;
}
