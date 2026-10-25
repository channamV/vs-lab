import { companyTimeZone, machineFuel, requestTime } from "@/lib/data";
import { clockTime, timeAgo } from "@/lib/format";

const KIND: Record<string, [string, string]> = {
  refuel: ["⛽", "Refuelled"],
  theft: ["⚠", "Fuel dropped while parked"],
  loss: ["⚠", "Fuel lost while running"],
};

/** Tank level and the fuel log. Only shown for machines that report fuel level. */
export async function FuelLog({ machineId, tankLitres }: { machineId: number; tankLitres: number | null }) {
  const [{ latest, log }, now] = await Promise.all([machineFuel(machineId), requestTime()]);
  if (!latest && log.length === 0) return null;
  const tz = await companyTimeZone();
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Fuel</h2>
        <span className="text-sm">
          {latest ? (
            <>
              Tank <span className="font-semibold">{Math.round(latest.pct)}%</span>
              {tankLitres && <span className="text-slate-500"> of {Math.round(tankLitres)} L (about {Math.round((latest.pct / 100) * tankLitres)} L)</span>}
              <span className="text-slate-500"> · {timeAgo(latest.at, now)}</span>
            </>
          ) : (
            <span className="text-slate-500">No recent level</span>
          )}
        </span>
      </div>
      {!tankLitres && (
        <p className="text-xs text-slate-500">Add the fuel tank size (Edit machine) to see litres and, on J1939 machines, check for fuel lost while running.</p>
      )}
      {log.length === 0 ? (
        <p className="text-sm text-slate-500">No refuels or fuel drops recorded yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {log.map((e) => {
            const [icon, label] = KIND[e.kind] ?? ["•", e.kind];
            const bad = e.kind !== "refuel";
            return (
              <li key={e.id} className="flex flex-wrap justify-between gap-x-4 py-1.5">
                <span>
                  <span aria-hidden className={bad ? "text-red-700 dark:text-red-400" : ""}>
                    {icon}
                  </span>{" "}
                  <span className={bad ? "font-medium text-red-800 dark:text-red-300" : ""}>{label}</span>
                  {e.kind === "refuel" && e.when === "running" && <span className="text-slate-500"> (engine running)</span>}
                  <span className="text-slate-500">
                    {" "}
                    · {Math.round(e.fromPct)}% → {Math.round(e.toPct)}%{e.litres !== null && `, about ${Math.round(e.litres)} L`}
                  </span>
                </span>
                <span className="text-slate-500">{clockTime(e.at, tz, now)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
