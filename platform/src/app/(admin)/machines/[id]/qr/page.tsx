import Link from "next/link";
import { OPERATOR_ALERTS } from "@/lib/operator-alerts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Suspense } from "react";
import { getMachine } from "@/lib/data";
import { machineLabel } from "@/lib/format";

/**
 * Printable QR sticker for a machine. Operators scan it to open the check-in page. It points at the
 * machine's code, not the device, so it keeps working when the device is replaced.
 */
export default function QrPage({ params }: PageProps<"/machines/[id]/qr">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <QrSticker params={params} />
    </Suspense>
  );
}

async function QrSticker({ params }: { params: PageProps<"/machines/[id]/qr">["params"] }) {
  const id = Number((await params).id);
  const machine = Number.isSafeInteger(id) && id > 0 ? await getMachine(id) : null;
  if (!machine) notFound();

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/checkin/${encodeURIComponent(machine.code)}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 print:hidden">
        <Link href={`/machines/${machine.id}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← {machineLabel(machine)}
        </Link>
        <p className="text-sm text-slate-500">
          Print this page (Ctrl+P) and stick it where the operator sees it before getting in: on the door or by the steps.
          Use a weatherproof label or laminate it.
        </p>
      </div>
      <div className="mx-auto w-72 space-y-3 rounded-lg border-2 border-slate-900 bg-white p-5 text-center text-slate-900">
        <p className="text-lg font-bold">Operator check-in</p>
        <div className="mx-auto w-56" dangerouslySetInnerHTML={{ __html: svg }} />
        {machine.unitNumber && <p className="text-2xl font-bold">Unit {machine.unitNumber}</p>}
        <p className="font-semibold">{machine.name}</p>
        <p className="text-sm">Scan with your phone camera before starting.</p>
        {/* On every sticker: a sticker lasts for years, while a machine's tier or mode can change any day. */}
        <div className="space-y-1 border-t border-slate-300 pt-2 text-left text-xs">
          <p className="font-semibold">If you hear:</p>
          {(["not_checked_in", "checklist_due"] as const).map((kind) => (
            <p key={kind}>
              <span className="font-semibold">{OPERATOR_ALERTS[kind].pattern}</span>: {OPERATOR_ALERTS[kind].meaning}
            </p>
          ))}
        </div>
        <p className="font-mono text-xs">{machine.code}</p>
      </div>
      <p className="text-center text-xs break-all text-slate-500 print:hidden">{url}</p>
    </div>
  );
}
