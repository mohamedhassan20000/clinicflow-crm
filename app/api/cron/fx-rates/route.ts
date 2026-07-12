import { NextResponse } from "next/server";
import { refreshFxRates } from "@/lib/currency/refresh";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await refreshFxRates()) });
  } catch {
    // Last successful rows remain untouched. Do not leak provider details or credentials.
    return NextResponse.json({ ok: false, error: "FX refresh unavailable; using last successful snapshot" }, { status: 503 });
  }
}

