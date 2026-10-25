import Link from "next/link";
import { companyTimeZone, machineWorksiteVisits, requestTime } from "@/lib/data";
import { clockTime, formatHours } from "@/lib/format";
import { worksiteColor } from "@/lib/worksite-types";

/** Which worksite the machine is at now, and its recent visits (under the map on the machine page). */
export async function WorksiteVisits({ machineId }: { machineId: number }) {
  const [visits, now] = await Promise.all([machineWorksiteVisits(machineId), requestTime()]);
  if (visits.length === 0) return null;
  const tz = await companyTimeZone();
  const here = visits.filter((v) => !v.visit.leftAt);
  return (
    <div className="space-y-1 text-sm">
      <p>
        <span className="text-slate-500">At worksite: </span>
        {here.length
          ? here.map((v, i) => (
              <span key={v.visit.id}>
                {i > 0 && ", "}
                <span className="mr-1 inline-block h-2.5 w-2.5 rounded-full" style={{ background: worksiteColor(v.type) }} />
                <span className="font-medium">{v.name}</span>
                <span className="text-slate-500"> since {clockTime(v.visit.enteredAt, tz, now)}</span>
              </span>
            ))
          : "none"}
        {" · "}
        <Link href="/worksites" className="text-sky-700 hover:underline dark:text-sky-400">
          Worksites
        </Link>
      </p>
      {visits.some((v) => v.visit.leftAt) && (
        <details>
          <summary className="cursor-pointer text-slate-500">Recent worksite visits</summary>
          <ul className="mt-1 space-y-0.5">
            {visits
              .filter((v) => v.visit.leftAt)
              .map((v) => (
                <li key={v.visit.id}>
                  {v.name}: {clockTime(v.visit.enteredAt, tz, now)} – {clockTime(v.visit.leftAt!, tz, now)}{" "}
                  <span className="text-slate-500">({formatHours((v.visit.leftAt!.getTime() - v.visit.enteredAt.getTime()) / 3_600_000)})</span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}
