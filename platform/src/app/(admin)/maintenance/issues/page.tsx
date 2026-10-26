import { Suspense } from "react";
import { maintenanceBoard } from "@/lib/data";
import { STATUSES, type Status } from "@/lib/maintenance-types";
import { IssueCard, MaintenanceHeader } from "../ui";

/**
 * Maintenance → Issues: open items by status (New, In progress, Awaiting parts) and those resolved in the last 7
 * days. Columns side by side on a wide screen; stacked sections on a phone. Open an item to change its status.
 */
export default function IssuesPage() {
  return (
    <div className="space-y-5">
      <Suspense fallback={<MaintenanceHeader active="/maintenance/issues" canEdit={false} />}>
        <Board />
      </Suspense>
    </div>
  );
}

async function Board() {
  const { issues, now, canEdit } = await maintenanceBoard();
  return (
    <>
      <MaintenanceHeader active="/maintenance/issues" canEdit={canEdit} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {(Object.keys(STATUSES) as Status[]).map((s) => {
          const list = issues.filter((i) => i.status === s);
          return (
            <section key={s} className={`space-y-2 rounded-xl border-t-4 bg-slate-100/60 p-2 dark:bg-slate-900/40 ${STATUSES[s].style}`}>
              <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
                {STATUSES[s].label}
                {s === "resolved" && <span className="font-normal text-slate-500"> (last 7 days)</span>}
                <span className="rounded-full bg-white px-2 text-xs dark:bg-slate-800">{list.length}</span>
              </h2>
              {list.length === 0 ? (
                <p className="px-1 py-3 text-center text-sm text-slate-500">No items</p>
              ) : (
                list.map((i) => <IssueCard key={i.id} issue={i} now={now} />)
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
