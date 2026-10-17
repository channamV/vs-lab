import { Suspense } from "react";
import Link from "next/link";
import { allDevices, listOrganizations, machinesWithoutDevice, requestTime } from "@/lib/data";
import { machineLabel, timeAgo } from "@/lib/format";
import { unpairDeviceAction } from "../machines/actions";
import { CreateOrganizationForm } from "./CreateOrganizationForm";
import { DeviceStockForm, PairWithMachineForm } from "./DeviceForms";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

/**
 * Veristart staff only: organizations, and the tracking devices: whose stock each is in and which
 * machine it's on. Customers add machines; staff pair devices with them.
 */
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
  const [orgs, devices, openMachines, now] = await Promise.all([
    listOrganizations(),
    allDevices(),
    machinesWithoutDevice(),
    requestTime(),
  ]);
  const notPaired = devices.filter((d) => !d.machine);

  return (
    <>
      <section className={card}>
        <h2 className="font-semibold">Devices</h2>
        <p className="text-xs text-slate-500">
          New devices appear in Veristart stock when they first report. Pair one with a customer&apos;s machine (it moves into
          that customer&apos;s stock). Unpairing a failed or replaced device leaves it in the customer&apos;s spares; move it back
          to Veristart stock when it&apos;s returned. Machines keep their history when devices change.
        </p>
        {devices.length === 0 ? (
          <p className="text-sm text-slate-500">None yet. A device appears here when it first reports.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1">Device</th>
                  <th className="py-1">Last report</th>
                  <th className="py-1">Where</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {devices.map((d) => (
                  <tr key={d.id} className="align-top">
                    <td className="py-2">
                      <Link href={`/platform/devices/${encodeURIComponent(d.id)}`} className="font-mono text-sky-700 hover:underline dark:text-sky-400">
                        {d.id}
                      </Link>
                    </td>
                    <td className="py-2 text-slate-500">{timeAgo(d.lastSeenAt, now)}</td>
                    <td className="py-2">
                      {d.machine ? (
                        <>
                          On <span className="font-medium">{machineLabel(d.machine)}</span>
                          <span className="text-slate-500"> · {d.stockOrganization}</span>
                        </>
                      ) : d.stockOrganization ? (
                        <>Spare · {d.stockOrganization}</>
                      ) : (
                        <span className="text-slate-500">Veristart stock</span>
                      )}
                    </td>
                    <td className="space-y-2 py-2">
                      {d.machine ? (
                        <form action={unpairDeviceAction}>
                          <input type="hidden" name="deviceId" value={d.id} />
                          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                            Unpair
                          </button>
                        </form>
                      ) : (
                        <>
                          <PairWithMachineForm
                            deviceId={d.id}
                            machines={openMachines
                              .filter((m) => d.organizationId === null || m.organizationId === d.organizationId)
                              .map((m) => ({ id: m.id, label: `${m.organizationName} — ${machineLabel(m)}` }))}
                          />
                          <DeviceStockForm deviceId={d.id} current={d.organizationId} organizations={orgs} />
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {notPaired.length > 0 && <p className="text-xs text-slate-500">{notPaired.length} not on a machine.</p>}
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
    </>
  );
}
