import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Suspense } from "react";
import { getDevice } from "@/lib/data";

/** Printable QR sticker for a machine. Operators scan it to open the check-in page. */
export default function QrPage({ params }: PageProps<"/devices/[id]/qr">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <QrSticker params={params} />
    </Suspense>
  );
}

async function QrSticker({ params }: { params: PageProps<"/devices/[id]/qr">["params"] }) {
  const id = decodeURIComponent((await params).id);
  const device = await getDevice(id);
  if (!device) notFound();

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const url = `${proto}://${host}/checkin/${encodeURIComponent(device.id)}`;
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 print:hidden">
        <Link href={`/devices/${encodeURIComponent(device.id)}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← {device.name ?? device.id}
        </Link>
        <p className="text-sm text-slate-500">
          Print this page (Ctrl+P) and stick it where the operator sees it before getting in: on the door or by the steps.
          Use a weatherproof label or laminate it.
        </p>
      </div>
      <div className="mx-auto w-72 space-y-3 rounded-lg border-2 border-slate-900 bg-white p-5 text-center text-slate-900">
        <p className="text-lg font-bold">Operator check-in</p>
        <div className="mx-auto w-56" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="font-semibold">{device.name ?? "Unnamed machine"}</p>
        <p className="text-sm">Scan with your phone camera before starting.</p>
        <p className="font-mono text-xs">{device.id}</p>
      </div>
      <p className="text-center text-xs break-all text-slate-500 print:hidden">{url}</p>
    </div>
  );
}
