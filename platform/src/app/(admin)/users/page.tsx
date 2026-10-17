import { Suspense } from "react";
import { listUsers, requestTime } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { AddUserForm } from "./AddUserForm";
import { updateUserAction } from "./actions";

const ROLE_HELP = [
  ["Owner", "Everything, including adding and removing users."],
  ["Manager", "Machines, operators, arm/disarm, acknowledging alerts. Gets alert emails."],
  ["Viewer", "Can look at everything, can't change anything."],
];

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
      </Suspense>
    </div>
  );
}

async function UserList() {
  const [users, now] = await Promise.all([listUsers(), requestTime()]);
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
              </td>
              <td className="px-4 py-2 text-slate-500">{timeAgo(u.lastSignInAt, now)}</td>
              <td className="px-4 py-2">
                <form key={`${u.role}|${u.active}`} action={updateUserAction} className="flex flex-wrap items-center gap-3">
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
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
