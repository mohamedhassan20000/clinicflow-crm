import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/rbac";
import { DEFAULT_FROM, getResend } from "@/lib/email/resend";

// POST /api/email/test  { to: string, subject?: string, html?: string }
// Admin-only smoke-test endpoint to confirm the Resend integration works
// without going through the password-reset flow. Remove once you've migrated
// transactional emails to a real flow.
export async function POST(request: NextRequest) {
  try {
    await requireRole(["admin"]);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { to?: string; subject?: string; html?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON." },
      { status: 400 },
    );
  }
  if (!body.to) {
    return NextResponse.json({ error: "Missing `to`." }, { status: 400 });
  }

  const resend = getResend();
  const { data, error } = await resend.emails.send({
    from: DEFAULT_FROM,
    to: body.to,
    subject: body.subject ?? "Hello World",
    html:
      body.html ??
      "<p>Congrats on sending your <strong>first email</strong>!</p>",
  });

  if (error) {
    return NextResponse.json(
      { error: error.message || "Resend rejected the request." },
      { status: 500 },
    );
  }
  return NextResponse.json({ id: data?.id ?? null });
}
