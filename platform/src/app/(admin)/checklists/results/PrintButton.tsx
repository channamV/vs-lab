"use client";

/** Opens the browser's print dialog (choose "Save as PDF" there for a file). */
export function PrintButton({ label = "Print / Save as PDF" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 print:hidden dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {label}
    </button>
  );
}
