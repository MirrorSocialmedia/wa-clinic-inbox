import { NextResponse } from "next/server";
import { StickerError } from "@/lib/stickers";

/** StickerError → JSON（其他錯誤交返 handle()） */
export function stickerError(err: unknown): NextResponse {
  if (err instanceof StickerError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  throw err;
}
