import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyForm, formFields, missing, photoFields } from "./checklist-form.ts";
import type { Checklist } from "./types.ts";

const checklist: Checklist["checklist"] = {
  name: "Standard",
  sections: [
    {
      id: "walk",
      title: "Walk-around",
      questions: [
        { id: "place", text: "Place of inspection", noteRequired: false, textOnly: true, prefill: "place" },
        { id: "tires", text: "Tires", noteRequired: true, photoRequired: true },
        { id: "lights", text: "Lights", noteRequired: false },
      ],
    },
  ],
  options: [
    { key: "ok", label: "OK", severity: "pass", color: "#059669" },
    { key: "soon", label: "Service soon", severity: "minor", color: "#d97706" },
    { key: "out", label: "Lockout", severity: "major", color: "#dc2626" },
  ],
  confirmationText: "Safe to use.",
  frequency: "machine_daily",
  doneTodayAt: null,
  photosEnabled: true,
  meter: { kind: "hours", value: 1234.5, hint: null },
  placeQuestionIds: ["place"],
  place: "Mount Pearl, NL",
};

test("starts with the engine's meter and the town filled in", () => {
  const f = emptyForm(checklist, "Paradise, NL");
  assert.equal(f.meter, "1234.5");
  assert.equal(f.notes.place, "Paradise, NL");
  assert.equal(f.skip, false);
  assert.equal(emptyForm({ ...checklist, doneTodayAt: "7:02 AM" }, null).skip, true);
});

test("lists what's missing, like the server", () => {
  const f = emptyForm(checklist, "Paradise, NL");
  assert.deepEqual(missing(checklist, f), ["Tires", "photo: Tires", "Lights", "the confirmation at the end"]);
  f.answers = { tires: "out", lights: "ok" };
  f.photos = { tires: [{ uri: "file:///a.jpg", name: "a.jpg", type: "image/jpeg" }] };
  assert.deepEqual(missing(checklist, f), ["describe the problem: Tires", "whether to lock the machine out", "the confirmation at the end"]);
  f.notes.tires = "Flat";
  f.lockout = "yes"; // locking out: no confirmation needed
  assert.deepEqual(missing(checklist, f), []);
  f.meter = "abc";
  assert.deepEqual(missing(checklist, f), ["the hour meter reading"]);
});

test("builds the same fields as the QR page", () => {
  const f = emptyForm(checklist, "Paradise, NL");
  f.answers = { tires: "soon", lights: "ok" };
  f.notes.tires = " Worn ";
  f.notes.lights = "ignored: not a defect";
  f.confirmed = true;
  f.photos = { tires: [{ uri: "file:///a.jpg", name: "a.jpg", type: "image/jpeg" }] };
  assert.deepEqual(formFields(checklist, f, { lat: 47.5, lng: -52.9, accuracy: 8.4 }), [
    ["note:place", "Paradise, NL"],
    ["item:tires", "soon"],
    ["note:tires", "Worn"],
    ["item:lights", "ok"],
    ["meterReading", "1234.5"],
    ["confirmed", "on"],
    ["phoneLat", "47.5"],
    ["phoneLng", "-52.9"],
    ["phoneAccuracy", "8"],
  ]);
  assert.deepEqual(photoFields(f), [{ field: "photo:tires", uri: "file:///a.jpg", name: "a.jpg", type: "image/jpeg" }]);
  assert.deepEqual(formFields(checklist, { ...f, skip: true }, null), [["skipChecklist", "on"]]);
});
