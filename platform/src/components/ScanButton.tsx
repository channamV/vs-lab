"use client";

import { useRef, useState } from "react";
import { ScanLine } from "lucide-react";
import { shrinkPhoto } from "@/lib/shrink-photo";

/**
 * "Scan to fill": take or choose a photo (or a PDF), which is shrunk in the browser and handed to `onScan` (a server
 * action that reads it). `onScan` returns an error message, or null when it has filled the form. Reusable for any
 * form: training certificates, serial plates…
 */
export function ScanButton({ label, onScan }: { label: string; onScan: (file: File) => Promise<string | null> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            // Enough detail to read small print, small enough to send quickly.
            const small = file.type === "application/pdf" ? file : await shrinkPhoto(file, 2000, 0.85);
            setError(await onScan(small));
          } catch {
            setError("The scan didn't work. Fill in the form by hand.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1.5 rounded border border-sky-700 px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-60 dark:border-sky-400 dark:text-sky-400 dark:hover:bg-slate-800"
      >
        <ScanLine className="h-4 w-4" aria-hidden />
        {busy ? "Reading…" : label}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
