import Link from "next/link";
import { Suspense } from "react";
import { listDivisions, listUsers, requestTime } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { AddUserForm } from "./AddUserForm";
import { updateUserAction } from "./actions";
import { AddDivisionForm, DivisionRow } from "./DivisionForms";

const ROLE_HELP = [
  ["Owner", "Everything, including adding and removing users."],
  ["Manager", "Machines, operators, operating modes (lock, unlock), acknowledging alerts. Gets all alert emails to start with."],
  ["Viewer", "Can look at everything, can't change anything."],
];

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

export default function UsersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-slate-500">People who can sign in to this organization. They sign in with an emailed link.</p>
      </div>
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">Add a user</h2>
        <AddUserForm />
        <dl className="grid gap-1 text-xs text-slate-500 sm:grid-cols-[6rem_1fr]">
          {ROLE_HELP.map(([role, help]) => (
            <div key={role} className="contents">
              <dt className="font-medium">{role}</dt>
              <dd>{help}</dd>
            </div>
          ))}
        </dl>
      </section>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <UserList />
        <Divisions />
      </Suspense>
    </div>
  );
}

async function UserList() {
  const [users, divisions, now] = await Promise.all([listUsers(), listDivisions(), requestTime()]);
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
          <tr>
            <th className="px-4 py-2">User</th>
            <th className="px-4 py-2">Last sign-in</th>
            <th className="px-4 py-2">Role and access</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
              <td className="px-4 py-2">
                <div className="font-medium">{u.name ?? u.email}</div>
                {u.name && <div className="text-xs text-slate-500">{u.email}</div>}
                <Link href={`/alerts/subscriptions?user=${u.id}`} className="text-xs text-sky-700 hover:underline dark:text-sky-400">
                  Subscriptions
                </Link>
              </td>
              <td className="px-4 py-2 text-slate-500">{timeAgo(u.lastSignInAt, now)}</td>
              <td className="px-4 py-2">
                <form key={`${u.role}|${u.active}|${u.divisionIds.join(",")}`} action={updateUserAction} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="id" value={u.id} />
                  <select name="role" defaultValue={u.role} className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700">
                    <option value="owner">Owner</option>
                    <option value="manager">Manager</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" name="active" defaultChecked={u.active} /> Active
                  </label>
                  <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Save</button>
                  {divisions.length > 0 &&
                    (u.role === "owner" ? (
                      <span className="w-full text-xs text-slate-500">Owners see every division.</span>
                    ) : (
                      <fieldset className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <legend className="sr-only">Divisions</legend>
                        <span className="text-slate-500">Divisions (none ticked = all):</span>
                        {divisions.map((d) => (
                          <label key={d.id} className="flex items-center gap-1">
                            <input type="checkbox" name="division" value={d.id} defaultChecked={u.divisionIds.includes(d.id)} />
                            {d.name}
                          </label>
                        ))}
                      </fieldset>
                    ))}
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Optional sub-groups of the company. Machines go in one; users can be limited to some. */
async function Divisions() {
  const divisions = await listDivisions();
  return (
    <section className={card}>
      <h2 className="font-semibold">Divisions (optional)</h2>
      <p className="text-xs text-slate-500">
        For companies split into regions or business units. Put each machine in a division (on its page), then limit
        managers and viewers to their divisions above: they&apos;ll only see those machines, their check-ins and alerts,
        and only get those alert emails. Operators work across the whole company. Without divisions, everyone sees everything.
      </p>
      {divisions.length > 0 && (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {divisions.map((d) => (
            <DivisionRow key={`${d.id}:${d.name}`} division={d} />
          ))}
        </div>
      )}
      <AddDivisionForm />
    </section>
  );
}
