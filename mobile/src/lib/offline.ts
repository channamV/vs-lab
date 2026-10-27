import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Checklist, Me, OfflinePass } from "./types";

/**
 * What the app keeps for working without signal (per signed-in operator): the machine list, each machine's
 * checklist, the offline unlock passes, and check-ins waiting to be sent.
 */

export type PendingPhoto = { field: string; uri: string; name: string; type: string };
export type PendingCheckin = {
  id: string;
  machineCode: string;
  machineLabel: string;
  fields: [string, string][];
  photos: PendingPhoto[];
  /** When the operator finished the checklist (the check-in is dated then). */
  completedAt: string;
};

const key = (operatorId: number, what: string) => `vslab.${operatorId}.${what}`;

async function read<T>(k: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(k);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
const write = (k: string, v: unknown) => AsyncStorage.setItem(k, JSON.stringify(v));

export const offline = {
  saveMe: (op: number, me: Me) => write(key(op, "me"), { me, savedAt: new Date().toISOString() }),
  me: (op: number) => read<{ me: Me; savedAt: string }>(key(op, "me")),
  saveChecklist: (op: number, code: string, c: Checklist) => write(key(op, `checklist.${code}`), c),
  checklist: (op: number, code: string) => read<Checklist>(key(op, `checklist.${code}`)),
  savePasses: (op: number, passes: OfflinePass[]) => write(key(op, "passes"), passes),
  /** A still-valid offline pass for a machine, or null. */
  async pass(op: number, code: string, now = Date.now()) {
    const passes = (await read<OfflinePass[]>(key(op, "passes"))) ?? [];
    return passes.find((p) => p.machineCode === code && Date.parse(p.validUntil) > now + 60_000) ?? null;
  },
  queue: async (op: number) => (await read<PendingCheckin[]>(key(op, "queue"))) ?? [],
  async enqueue(op: number, item: PendingCheckin) {
    const q = await offline.queue(op);
    await write(key(op, "queue"), [...q, item]);
  },
  async dequeue(op: number, id: string) {
    const q = await offline.queue(op);
    await write(key(op, "queue"), q.filter((i) => i.id !== id));
  },
  async forget(op: number) {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(`vslab.${op}.`));
    await AsyncStorage.multiRemove(keys);
  },
};
