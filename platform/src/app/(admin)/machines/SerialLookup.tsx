"use client";

import { useState } from "react";
import { lookupSerialAction, type SerialLookupResult } from "./actions";

export type LookupNote = { tone: "info" | "warn"; text: string };

/** Same value, ignoring case, spaces and punctuation ("F-550" = "F550"). */
const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Puts a VIN/PIN lookup into the machine form: fills only empty fields, and lists any field whose value disagrees
 * (e.g. a misread from the plate scan) instead of overwriting it. Returns what to tell the manager.
 */
export function applySerialLookup(form: HTMLFormElement, result: SerialLookupResult): LookupNote[] {
  if (result.kind === "error") return [{ tone: "warn", text: result.error }];
  const input = (name: string) => {
    const el = form.elements.namedItem(name);
    return el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el : null;
  };
  const notes: LookupNote[] = [];
  const differences: string[] = [];
  const offer = (name: string, label: string, value: string | number | null, source: string) => {
    const el = input(name);
    if (!el || value === null || value === "") return;
    if (!el.value.trim()) el.value = String(value);
    else if (!same(el.value, String(value))) differences.push(`${label}: the form says "${el.value}", ${source} says "${value}"`);
  };
  // A recognised VIN/PIN is written the standard way (no spaces or dashes); other serials stay as typed.
  const serial = input("serialNumber");
  if (serial && (result.kind !== "unknown" || result.correctedFrom)) serial.value = result.serial;
  if (result.correctedFrom) {
    notes.push({
      tone: "warn",
      text: `The photo read "${result.correctedFrom}"; corrected to ${result.serial} (look-alike characters such as O/0 or S/5). Compare it with the plate.`,
    });
  }

  if (result.kind === "vin") {
    const d = result.decoded;
    notes.push({ tone: "info", text: `VIN decoded by NHTSA: ${[d.year, d.make, d.model].filter(Boolean).join(" ")}${d.machineType ? ` (${d.machineType})` : ""}.` });
    offer("make", "Make", d.make, "the VIN");
    offer("model", "Model", d.model, "the VIN");
    offer("year", "Year", d.year, "the VIN");
    offer("machineType", "Type", d.machineType, "the VIN");
    const category = input("categoryId");
    if (category && !category.value && result.categoryId) category.value = String(result.categoryId);
    const name = input("name");
    if (name && !name.value.trim() && d.make) name.value = [d.make, d.model].filter(Boolean).join(" ");
  } else if (result.kind === "pin") {
    notes.push({ tone: "info", text: `Equipment PIN made by ${result.manufacturer}. Model details aren't in any free public database, so check them on the plate.` });
    offer("make", "Make", result.manufacturer, "the PIN");
  } else {
    notes.push({ tone: "info", text: result.reason });
  }
  if ("checkDigitOk" in result && result.checkDigitOk === false) {
    notes.push({ tone: "warn", text: "The VIN's check digit (9th character) doesn't match: one character is probably misread. Compare it with the plate." });
  }
  if (differences.length) notes.push({ tone: "warn", text: `Please check: ${differences.join("; ")}.` });
  return notes;
}

export function LookupNotes({ notes }: { notes: LookupNote[] }) {
  return (
    <>
      {notes.map((n, i) => (
        <p key={i} className={`text-sm ${n.tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-sky-800 dark:text-sky-300"}`}>
          {n.text}
        </p>
      ))}
    </>
  );
}

/** "Check VIN / PIN" beside the serial field. */
export function SerialLookupButton() {
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<LookupNote[]>([]);
  return (
    <div className="space-y-1 sm:col-span-2">
      <button
        type="button"
        disabled={busy}
        className="rounded border border-sky-700 px-3 py-1 text-sm text-sky-700 hover:bg-sky-50 disabled:opacity-60 dark:border-sky-400 dark:text-sky-400 dark:hover:bg-slate-800"
        onClick={async (e) => {
          const form = e.currentTarget.form;
          const serial = form?.elements.namedItem("serialNumber");
          if (!form || !(serial instanceof HTMLInputElement)) return;
          setBusy(true);
          try {
            setNotes(applySerialLookup(form, await lookupSerialAction(serial.value)));
          } catch {
            setNotes([{ tone: "warn", text: "The lookup didn't work. Try again in a minute." }]);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Checking…" : "Check VIN / PIN"}
      </button>
      <LookupNotes notes={notes} />
    </div>
  );
}
