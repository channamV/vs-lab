import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checklistAnswerSets, checklistTemplates, type AnswerOption } from "@/lib/db/schema";
import { ChecklistError, createTemplate, DEFAULT_ANSWER_SETS, ensureChecklistDefaults, type TemplateInput } from "@/lib/checklists";

/**
 * Ready-made checklists a company can add with one click (Checklists → Ready-made checklists), then edit like any
 * other. docs/checklists.md → "Ready-made checklists" says where each one's wording comes from.
 */

export type LibraryTemplate = {
  key: string;
  name: string;
  summary: string;
  /** Uses an answer set with Minor defect / Major defect / Not applicable (created if the company has none). */
  sections: TemplateInput["sections"];
  confirmationText: string;
  /** How often (src/lib/checklist-frequency.ts). */
  frequency: string;
};

/** Each Schedule A system: a defect needs a description (the report must list the defects found). */
const part = (id: string, text: string) => ({ id, text, noteRequired: true });

/**
 * Newfoundland and Labrador trip inspection for trucks, tractors and trailers over 4,500 kg registered gross weight:
 * Trip Inspection Report Regulations (NLR 27/12, Highway Traffic Act), Schedule A, which follows National Safety Code
 * Standard 13, Schedule 1. Every system in column 1 must be inspected (N/A when the vehicle doesn't have it); column 2
 * defects are minor (report to the carrier), column 3 major (the vehicle must not be driven). The report must show
 * the vehicle's plate or unit number, the carrier, date and time, the place of inspection, the defects found (or that
 * there were none), the inspector's name and their signed statement: plate/unit, carrier, time and name come from the
 * machine, company, check-in and operator; the rest are questions below and the confirmation.
 */
const NL_SCHEDULE_A: LibraryTemplate = {
  key: "nl-trip-inspection-schedule-a",
  name: "NL trip inspection – truck, tractor, trailer (Schedule A)",
  summary:
    "Newfoundland and Labrador daily trip inspection for trucks, tractors and trailers over 4,500 kg (NLR 27/12 Schedule A, " +
    "based on NSC Standard 13 Schedule 1): all 23 systems, location and trailer (the odometer is asked on every checklist).",
  sections: [
    {
      id: "trip",
      title: "Trip inspection details",
      questions: [
        { id: "location", text: "Place of inspection (city, town or highway)", noteRequired: false, textOnly: true, prefill: "place" },
        { id: "trailers", text: "Trailer(s) towed: licence plate or unit number (write \"None\" if not towing)", noteRequired: false, textOnly: true },
      ],
    },
    {
      id: "brakes",
      title: "Brakes",
      questions: [
        part(
          "p01_air_brakes",
          "1. Air brake system: no audible air leak, normal pressure build-up, low-air warning works, service, parking and emergency brakes work, pushrod stroke within limit, air lines, tanks and chambers secure. Major: brake inoperative, warning activated, stroke at/over limit.",
        ),
        part(
          "p17_hydraulic_brakes",
          "17. Hydraulic brake system: fluid at or above minimum, no fluid leak, firm pedal with reserve, power assist works, no warning lamp (other than ABS), parking brake works. Major: leak, pedal fade, assist or parking brake inoperative, reservoir under ¼.",
        ),
        part(
          "p08_electric_brakes",
          "8. Electric brake system (trailer): wiring and connections secure, brakes and breakaway device work. Major: breakaway device or brake inoperative.",
        ),
      ],
    },
    {
      id: "coupling_cargo",
      title: "Coupling and cargo",
      questions: [
        part(
          "p04_coupling",
          "4. Coupling devices: fifth wheel / hitch secure, locks properly, no excess movement, fasteners present, safety chains or cables correct. Major: fails to lock, insecure or excess movement, safety chain/cable missing or defective.",
        ),
        part(
          "p03_cargo",
          "3. Cargo securement: load secure, required tie-downs and load covering present and in good condition. Major: insecure cargo, or a required securement device missing, failed or deteriorated.",
        ),
        part("p05_dangerous_goods", "5. Dangerous goods: placards, documents and requirements met (N/A if not carrying dangerous goods). Any failure is a major defect."),
      ],
    },
    {
      id: "cab",
      title: "Cab and driver",
      questions: [
        part("p02_cab", "2. Cab: doors open and close securely (cab and sleeper). Major: any cab or sleeper door fails to close securely."),
        part(
          "p06_driver_controls",
          "6. Driver controls: accelerator, clutch, gauges, warning lights and instruments work. Major: accelerator sticks and engine doesn't return to idle.",
        ),
        part("p07_driver_seat", "7. Driver seat: secure and stays in position; seatbelt works. Major: seatbelt or tether belt missing, insecure or not working."),
        part(
          "p14_glass_mirrors",
          "14. Glass and mirrors: windshield, windows and required mirrors give a clear view, not cracked, missing or loose. Major: windshield damage blocks the driver's view.",
        ),
        part("p15_heater_defroster", "15. Heater / defroster works. Major: defroster can't keep the windshield clear when needed."),
        part("p16_horn", "16. Horn works."),
        part(
          "p23_wipers",
          "23. Windshield wiper / washer: controls work, blades not damaged, clear the view. Major: driver's side wiper or washer fails to clear the view when needed.",
        ),
        part("p09_emergency_equipment", "9. Emergency equipment and safety devices present and in good condition (e.g. warning devices, fire extinguisher if required)."),
      ],
    },
    {
      id: "vehicle",
      title: "Around and under the vehicle",
      questions: [
        part(
          "p18_lamps",
          "18. Lamps and reflectors: all required lamps work, reflectors present. Major: both low-beam headlamps or both rear tail lamps out (when lamps required), a rear turn signal out, or both brake lamps out.",
        ),
        part(
          "p19_steering",
          "19. Steering: wheel secure, normal response, free play not excessive. Major: steering insecure or not responding normally, or free play over the limit.",
        ),
        part(
          "p20_suspension",
          "20. Suspension: no air leak, springs and fasteners intact, U-bolts tight, air bags undamaged. Major: damaged or deflated air bag, broken main leaf or more than one leaf, shifted or missing parts, loose U-bolt.",
        ),
        part(
          "p21_tires",
          "21. Tires: inflated, no leaks, tread above wear limit, no damage or exposed cords, not touching other parts. Major: flat or audible leak, below wear limit, exposed cords, touching another tire or part, \"not for highway use\".",
        ),
        part(
          "p22_wheels",
          "22. Wheels, hubs and fasteners: nuts present and tight, no cracks, hub oil and seals OK. Major: loose, missing or ineffective fastener, cracked or broken wheel or rim, signs of wheel, hub or bearing failure.",
        ),
        part(
          "p11_frame_body",
          "11. Frame and cargo body: no damage. Major: frame member visibly shifted, cracked, collapsing or sagging.",
        ),
        part("p12_fuel", "12. Fuel system: tank secure, cap present, no leaks. Major: insecure tank or dripping fuel leak."),
        part("p10_exhaust", "10. Exhaust system: no leaks. Major: exhaust gas entering the cab."),
        part("p13_general", "13. General: no other serious damage or deterioration that could affect safe operation (if there is, it's a major defect)."),
      ],
    },
  ],
  // The rules ask for an inspection at least every 24 hours, and a later driver may rely on a valid one: once a day
  // per machine (a calendar day, a little stricter than 24 hours).
  frequency: "machine_daily",
  confirmationText:
    "I conducted this trip inspection of the vehicle (and any trailer listed) in accordance with the Trip Inspection Report " +
    "Regulations under the Highway Traffic Act (Newfoundland and Labrador), Schedule A. The defects I found, if any, are " +
    "recorded above. I will report minor defects to the carrier, and I will not drive the vehicle with a major defect.",
};

export const CHECKLIST_LIBRARY: LibraryTemplate[] = [NL_SCHEDULE_A];

/** The company's answer set with Minor defect / Major defect / Not applicable answers, created if missing. */
async function inspectionAnswerSet(db: Db, organizationId: number) {
  const sets = await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.organizationId, organizationId));
  const fits = (options: AnswerOption[]) => (["pass", "minor", "major", "na"] as const).every((s) => options.some((o) => o.severity === s));
  const preset = DEFAULT_ANSWER_SETS.find((s) => s.name === "Vehicle inspection")!;
  const existing = sets.find((s) => s.name === preset.name && fits(s.options)) ?? sets.find((s) => fits(s.options));
  if (existing) return existing.id;
  let name = preset.name;
  for (let n = 2; sets.some((s) => s.name === name); n++) name = `${preset.name} ${n}`;
  const [row] = await db.insert(checklistAnswerSets).values({ organizationId, name, options: preset.options }).returning({ id: checklistAnswerSets.id });
  return row.id;
}

/** Adds a ready-made checklist to the company (not as its default). */
export async function addLibraryTemplate(db: Db, organizationId: number, key: string) {
  const item = CHECKLIST_LIBRARY.find((t) => t.key === key);
  if (!item) throw new ChecklistError("That ready-made checklist doesn't exist.");
  await ensureChecklistDefaults(db, organizationId);
  const [already] = await db
    .select({ id: checklistTemplates.id })
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.organizationId, organizationId), eq(checklistTemplates.name, item.name)));
  if (already) throw new ChecklistError(`"${item.name}" is already in your checklists.`);
  return createTemplate(db, organizationId, {
    name: item.name,
    answerSetId: await inspectionAnswerSet(db, organizationId),
    confirmationText: item.confirmationText,
    frequency: item.frequency,
    sections: item.sections,
  });
}
