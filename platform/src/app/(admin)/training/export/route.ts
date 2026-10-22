import { trainingData } from "@/lib/data";
import { toCsv } from "@/lib/reports";
import { STATUS_LABELS } from "@/lib/training-status";
import { getAuth } from "@/lib/session";

/** Operators' certifications (latest record of each) as a CSV file, with the Training page's status filter. */
export async function GET(request: Request) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const status = new URL(request.url).searchParams.get("status") ?? "all";
  const data = await trainingData();
  const rows = data.rows.filter((r) => status === "all" || r.status === status);
  const body = toCsv([
    ["Operator", "Employee #", "Active", "Certification", "Issued", "Expires", "Days left", "Status", "Provider", "Certificate #", "Entered by"],
    ...rows.map((r) => [
      r.operator.name,
      r.operator.employeeNumber,
      r.operator.active ? "Yes" : "No",
      r.type.name,
      r.record.issuedOn,
      r.record.expiresOn ?? "",
      r.daysLeft ?? "",
      STATUS_LABELS[r.status],
      r.record.provider,
      r.record.certificateNumber,
      r.record.enteredBy,
    ]),
  ]);
  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vs-lab-training-${data.today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
