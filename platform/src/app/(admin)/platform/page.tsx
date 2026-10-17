import { Suspense } from "react";
import { allDevicesWithOrganization, listOrganizations, requestTime, unclaimedDevices } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { assignDeviceAction } from "./actions";
import { CreateOrganizationForm } from "./CreateOrganizationForm";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

/** Veristart staff only: organizations, and which organization each device belongs to. */
export default function PlatformPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Platform</h1>
        <p className="text-sm text-slate-500">
          Veristart staff only. Customers never see this page. To work inside an organization (its machines, operators and
          users), pick it in the top bar.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Platform />
      </Suspense>
    </div>
  );
}

async function Platform() {
  const [orgs, unclaimed, all, now] = await Promise.all([
    listOrganizations(),
    unclaimedDevices(),
    allDevicesWithOrganization(),
    requestTime(),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const AssignForm = ({ deviceId, current }: { deviceId: string; current: number | null }) => (
    // key: rebuild after a save so the dropdown shows the saved organization
    <form key={`${deviceId}:${current}`} action={assignDeviceAction} className="flex gap-2">
      <input type="hidden" name="deviceId" value={deviceId} />
      <select name="organizationId" defaultValue={current ?? ""} className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700">
        <option value="">Unclaimed</option>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Save</button>
    </form>
  );

  return (
    <>
      <section className={card}>
        <h2 className="font-semibold">New devices waiting to be claimed ({unclaimed.length})</h2>
        {unclaimed.length === 0 ? (
          <p className="text-sm text-slate-500">None. A device that reports for the first time appears here.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {unclaimed.map((d) => (
                <tr key={d.id}>
                  <td className="py-2 font-mono">{d.id}</td>
                  <td className="py-2 text-slate-500">last report {timeAgo(d.lastSeenAt, now)}</td>
                  <td className="py-2">
                    <AssignForm deviceId={d.id} current={null} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={card}>
        <h2 className="font-semibold">Organizations</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="py-1">Name</th>
              <th className="py-1 text-right">Machines</th>
              <th className="py-1 text-right">Users</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {orgs.map((o) => (
              <tr key={o.id}>
                <td className="py-1.5 font-medium">{o.name}</td>
                <td className="py-1.5 text-right">{o.machines}</td>
                <td className="py-1.5 text-right">{o.users}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <CreateOrganizationForm />
        <p className="text-xs text-slate-500">
          After creating one, pick it in the top bar and add its first owner on the Users page.
        </p>
      </section>

      <section className={card}>
        <h2 className="font-semibold">All machines</h2>
        <p className="text-xs text-slate-500">
          Moving a machine clears its approved-operator list and checks out anyone on it. Past check-ins and alerts stay with
          the organization they happened in.
        </p>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {all.map((d) => (
              <tr key={d.id}>
                <td className="py-2">
                  <span className="font-mono">{d.id}</span>
                  {d.name && <span className="text-slate-500"> · {d.name}</span>}
                </td>
                <td className="py-2 text-slate-500">{d.organizationId ? orgName.get(d.organizationId) : "Unclaimed"}</td>
                <td className="py-2">
                  <AssignForm deviceId={d.id} current={d.organizationId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
