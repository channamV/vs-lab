import { Suspense } from "react";
import { canEditWorksites, listWorksites } from "@/lib/data";
import { WorksiteManager } from "./WorksiteManager";

/** Worksites ("geo-lock"): draw jobsites, yards and offices; get notified when machines enter, leave or stay too long. */
export default function WorksitesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Worksites</h1>
        <p className="text-sm text-slate-500">
          Draw your jobsites, yards, offices and customer sites. Machines are matched to them by GPS: subscribe to “Entered Worksite”, “Left
          Worksite” or “Stayed Too Long at Worksite” under Notifications.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Worksites />
      </Suspense>
    </div>
  );
}

async function Worksites() {
  const [{ sites, machines }, canEdit] = await Promise.all([listWorksites(), canEditWorksites()]);
  return <WorksiteManager sites={sites} machines={machines} canEdit={canEdit} />;
}
