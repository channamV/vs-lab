import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { liveHolds, mergeHolds, withHold } from "./hold-rules";
import type { HeldSession } from "./types";

/**
 * The operator's held check-ins on this phone (session hold, docs/operator-app.md). The details live in app storage;
 * each session key lives in the phone's secure storage (Keychain / Keystore).
 */

const listKey = (op: number) => `vslab.${op}.holds`;
const secretKey = (checkinId: number) => `vslab.hold.${checkinId}`;
type Stored = Omit<HeldSession, "session"> & { session: Omit<HeldSession["session"], "key"> };

async function load(op: number): Promise<HeldSession[]> {
  let stored: Stored[] = [];
  try {
    stored = JSON.parse((await AsyncStorage.getItem(listKey(op))) ?? "[]") as Stored[];
  } catch {
    stored = [];
  }
  const out: HeldSession[] = [];
  for (const h of stored) {
    const key = await SecureStore.getItemAsync(secretKey(h.session.checkinId));
    if (key) out.push({ ...h, session: { ...h.session, key } });
  }
  return liveHolds(out);
}

async function save(op: number, before: HeldSession[], list: HeldSession[]) {
  for (const h of before) if (!list.some((x) => x.session.checkinId === h.session.checkinId)) await SecureStore.deleteItemAsync(secretKey(h.session.checkinId));
  for (const h of list) await SecureStore.setItemAsync(secretKey(h.session.checkinId), h.session.key);
  const stored: Stored[] = list.map(({ session: { key: _key, ...session }, ...rest }) => ({ ...rest, session }));
  await AsyncStorage.setItem(listKey(op), JSON.stringify(stored));
}

export const holds = {
  list: load,
  /** After checking in (or a successful resume): remember this hold. */
  async add(op: number, h: HeldSession) {
    const before = await load(op);
    await save(op, before, withHold(before, h));
  },
  /** With signal: the server's list decides which holds are still on. */
  async sync(op: number, fromServer: Omit<HeldSession, "bleId">[]) {
    const before = await load(op);
    await save(op, before, mergeHolds(before, fromServer));
  },
  async drop(op: number, checkinId: number) {
    const before = await load(op);
    await save(op, before, before.filter((h) => h.session.checkinId !== checkinId));
  },
  async forget(op: number) {
    await save(op, await load(op), []);
    await AsyncStorage.removeItem(listKey(op));
  },
};
