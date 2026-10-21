/**
 * J1939 fault codes. Engine computers report active faults (DM1) as an SPN (what: e.g. 110 = coolant
 * temperature) and an FMI (how: e.g. 0 = above normal, most severe). Our firmware sends each as
 * SPN × 32 + FMI. Descriptions for the common ones; the rest show their numbers (look them up in the
 * engine maker's manual). No server-only code here: pages use it too.
 */

export type FaultCode = { spn: number; fmi: number };

export const decodeFault = (code: number): FaultCode => ({ spn: Math.floor(code / 32), fmi: code % 32 });
export const encodeFault = ({ spn, fmi }: FaultCode) => spn * 32 + fmi;

/** Suspect parameter numbers seen most on construction equipment. */
export const SPN_NAMES: Record<number, string> = {
  51: "Throttle position",
  84: "Wheel-based vehicle speed",
  91: "Accelerator pedal position",
  92: "Engine load",
  94: "Fuel delivery pressure",
  97: "Water in fuel",
  98: "Engine oil level",
  100: "Engine oil pressure",
  102: "Intake manifold (boost) pressure",
  105: "Intake manifold temperature",
  107: "Air filter differential pressure",
  108: "Barometric pressure",
  110: "Engine coolant temperature",
  111: "Coolant level",
  157: "Fuel rail pressure",
  158: "Battery potential (switched)",
  167: "Charging system voltage",
  168: "Battery voltage",
  171: "Ambient air temperature",
  174: "Fuel temperature",
  175: "Engine oil temperature",
  177: "Transmission oil temperature",
  190: "Engine speed",
  247: "Engine total hours",
  412: "EGR temperature",
  520: "Hydraulic oil temperature",
  625: "Proprietary data link",
  629: "Engine control module",
  636: "Camshaft position sensor",
  637: "Crankshaft position sensor",
  639: "J1939 network",
  651: "Injector cylinder 1",
  652: "Injector cylinder 2",
  653: "Injector cylinder 3",
  654: "Injector cylinder 4",
  655: "Injector cylinder 5",
  656: "Injector cylinder 6",
  1209: "Exhaust gas pressure",
  1569: "Engine power derate",
  1761: "DEF tank level",
  3031: "DEF tank temperature",
  3216: "Aftertreatment NOx (inlet)",
  3226: "Aftertreatment NOx (outlet)",
  3242: "DPF inlet temperature",
  3251: "DPF differential pressure",
  3364: "DEF quality",
  3719: "DPF soot load",
  4364: "SCR conversion efficiency",
  5246: "Aftertreatment SCR operator inducement",
};

/** Failure mode identifiers (the standard J1939 list). */
export const FMI_NAMES: Record<number, string> = {
  0: "above normal (most severe)",
  1: "below normal (most severe)",
  2: "erratic or incorrect data",
  3: "voltage above normal or shorted high",
  4: "voltage below normal or shorted low",
  5: "current below normal or open circuit",
  6: "current above normal or grounded circuit",
  7: "mechanical system not responding",
  8: "abnormal frequency or pulse width",
  9: "abnormal update rate",
  10: "abnormal rate of change",
  11: "root cause not known",
  12: "bad device or component",
  13: "out of calibration",
  14: "special instructions",
  15: "above normal (least severe)",
  16: "above normal (moderately severe)",
  17: "below normal (least severe)",
  18: "below normal (moderately severe)",
  19: "received network data in error",
  20: "data drifted high",
  21: "data drifted low",
  31: "condition exists",
};

/** "Engine coolant temperature: above normal (most severe) · SPN 110 FMI 0" */
export function describeFault({ spn, fmi }: FaultCode): string {
  const what = SPN_NAMES[spn] ?? `SPN ${spn}`;
  const how = FMI_NAMES[fmi] ?? `FMI ${fmi}`;
  return `${what}: ${how} · SPN ${spn} FMI ${fmi}`;
}

/** DM1 lamp bits, most serious first. */
export function lampsText(lamps: number | null): string | null {
  if (!lamps) return null;
  const on = [
    lamps & 2 ? "red stop lamp" : null,
    lamps & 8 ? "protect lamp" : null,
    lamps & 4 ? "amber warning lamp" : null,
    lamps & 1 ? "malfunction lamp" : null,
  ].filter(Boolean);
  return on.length ? on.join(", ") : null;
}
