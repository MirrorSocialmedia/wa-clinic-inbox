import { NextResponse } from "next/server";
import { WorkGroupError } from "@/lib/workgroups";

/** WorkGroupError → JSON（其他錯誤交返 handle()） */
export function wgError(err: unknown): NextResponse {
  if (err instanceof WorkGroupError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  throw err;
}
