import { COMMANDS } from "@/lib/commands";
import { deviceCommandsForStaff, requestTime } from "@/lib/data";
import { clockTime } from "@/lib/format";
import { appTimeZone } from "@/lib/telemetry/engine";
import { cancelCommandAction } from "../../actions";
import { CommandForm } from "./CommandForm";

const STATUS: Record<string, [string, string]> = {
  pending: ["Waiting for the device", "text-slate-600 dark:text-slate-400"],
  sent: ["Sent, waiting for an answer", "text-sky-700 dark:text-sky-400"],
  done: ["Done", "text-[#006300] dark:text-[#0ca30c]"],
  failed: ["Failed", "text-red-700 dark:text-red-400"],
  expired: ["Expired (no answer)", "text-amber-700 dark:text-amber-400"],
  cancelled: ["Cancelled", "text-slate-500"],
};

/** Staff: send commands to a device and see what happened to them. */
export async function Commands({ deviceId }: { deviceId: string }) {
  const [{ history, key }, now] = await Promise.all([deviceCommandsForStaff(deviceId), requestTime()]);
  const tz = appTimeZone();
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div>
        <h2 className="font-semibold">Commands</h2>
        <p className="text-sm text-slate-500">
          Delivered with the reply to the device&apos;s next report (every few seconds while running) or check-in (every 15 minutes
          while parked). Needs our firmware version: the stock firmware ignores commands.
        </p>
      </div>
      <CommandForm deviceId={deviceId} commands={Object.entries(COMMANDS).map(([kind, c]) => ({ kind, label: c.label, help: c.help }))} />
      {history.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {history.map((c) => {
            const [statusLabel, cls] = STATUS[c.status] ?? [c.status, ""];
            return (
              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span>
                  <span className="font-medium">{c.label}</span>{" "}
                  <span className={cls}>· {statusLabel}</span>
                  {c.result && <span className="text-slate-500"> · “{c.result}”</span>}
                  <span className="block text-xs text-slate-500">
                    #{c.id} by {c.createdBy}, {clockTime(c.createdAt, tz, now)}
                    {c.sendCount > 0 && ` · sent ${c.sendCount}×, last ${clockTime(c.sentAt!, tz, now)}`}
                    {c.answeredAt && ` · answered ${clockTime(c.answeredAt, tz, now)}`}
                  </span>
                </span>
                {(c.status === "pending" || c.status === "sent") && (
                  <form action={cancelCommandAction}>
                    <input type="hidden" name="deviceId" value={deviceId} />
                    <input type="hidden" name="id" value={c.id} />
                    <button className="text-xs text-red-700 hover:underline dark:text-red-400">Cancel</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-500">Device key (for flashing our firmware)</summary>
        {key ? (
          <p className="mt-1">
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs dark:bg-slate-800">{key}</code>{" "}
            <span className="text-slate-500">Commands to this device are signed with it, and its answers must be too.</span>
          </p>
        ) : (
          <p className="mt-1 text-amber-700 dark:text-amber-400">
            Signing is off: DEVICE_KEY_SECRET isn&apos;t set, so commands go out unsigned (fine for the simulator, not for real
            machines). See docs/device-commands.md.
          </p>
        )}
      </details>
    </section>
  );
}
