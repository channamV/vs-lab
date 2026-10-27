import * as Device from "expo-device";
import * as Network from "expo-network";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, OfflineError } from "./api";
import { offline, type PendingCheckin } from "./offline";
import { currentOperatorId, loadAccounts, saveAccounts, setCurrentOperatorId } from "./session";
import type { Account, Me } from "./types";

/**
 * The signed-in operator and their machines, shared by every screen. Works from saved data without signal, and sends
 * waiting check-ins when the phone is back online.
 */

type State = {
  ready: boolean;
  accounts: Account[];
  account: Account | null;
  me: Me | null;
  /** When the machine list was last fetched (null = never); shown as "offline" when old. */
  savedAt: string | null;
  online: boolean;
  pending: PendingCheckin[];
  refresh: () => Promise<void>;
  signedIn: (accounts: Account[]) => Promise<void>;
  switchTo: (operatorId: number) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<State | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

export const phoneName = () => Device.deviceName ?? Device.modelName ?? null;

/** Builds the multipart body for a check-in waiting in the queue. */
export function pendingForm(item: PendingCheckin) {
  const form = new FormData();
  for (const [k, v] of item.fields) form.append(k, v);
  form.append("completedAt", item.completedAt);
  for (const p of item.photos) form.append(p.field, { uri: p.uri, name: p.name, type: p.type } as unknown as Blob);
  return form;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState<PendingCheckin[]>([]);
  const account = accounts.find((a) => a.operatorId === operatorId) ?? accounts[0] ?? null;

  const dropAccount = useCallback(
    async (gone: Account) => {
      const rest = accounts.filter((a) => a.operatorId !== gone.operatorId);
      await saveAccounts(rest);
      await offline.forget(gone.operatorId);
      setAccounts(rest);
      setMe(null);
    },
    [accounts],
  );

  const refresh = useCallback(async () => {
    if (!account) return;
    const op = account.operatorId;
    const saved = await offline.me(op);
    if (saved) {
      setMe(saved.me);
      setSavedAt(saved.savedAt);
    }
    setPending(await offline.queue(op));
    try {
      // Waiting check-ins first, oldest first, so the machine list reflects them.
      for (const item of await offline.queue(op)) {
        // Sent, or refused (e.g. training expired meanwhile): either way it leaves the queue.
        await api.checkIn(account.token, item.machineCode, pendingForm(item));
        await offline.dequeue(op, item.id);
      }
      const fresh = await api.me(account.token);
      await offline.saveMe(op, fresh);
      setMe(fresh);
      setSavedAt(new Date().toISOString());
      setOnline(true);
      const { passes } = await api.passes(account.token);
      await offline.savePasses(op, passes);
      // Keep each machine's checklist for checking in without signal.
      for (const m of fresh.machines) {
        api.checklist(account.token, m.code).then((c) => offline.saveChecklist(op, m.code, c)).catch(() => {});
      }
    } catch (e) {
      if (e instanceof OfflineError) setOnline(false);
      else if (e instanceof ApiError && e.status === 401) await dropAccount(account);
      else throw e;
    } finally {
      setPending(await offline.queue(op));
    }
  }, [account, dropAccount]);

  useEffect(() => {
    (async () => {
      setAccounts(await loadAccounts());
      setOperatorId(await currentOperatorId());
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (ready && account) refresh().catch(() => {});
  }, [ready, account?.operatorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back online: send what's waiting and refresh.
  useEffect(() => {
    const sub = Network.addNetworkStateListener((s) => {
      if (s.isInternetReachable && !online) refresh().catch(() => {});
    });
    return () => sub.remove();
  }, [online, refresh]);

  const value = useMemo<State>(
    () => ({
      ready,
      accounts,
      account,
      me,
      savedAt,
      online,
      pending,
      refresh,
      async signedIn(list) {
        const merged = [...accounts.filter((a) => !list.some((n) => n.operatorId === a.operatorId)), ...list];
        await saveAccounts(merged);
        setAccounts(merged);
        await setCurrentOperatorId(list[0]?.operatorId ?? null);
        setOperatorId(list[0]?.operatorId ?? null);
      },
      async switchTo(id) {
        await setCurrentOperatorId(id);
        setMe(null);
        setOperatorId(id);
      },
      async signOut() {
        if (!account) return;
        await api.signOut(account.token).catch(() => {});
        await dropAccount(account);
        await setCurrentOperatorId(null);
        setOperatorId(null);
      },
    }),
    [ready, accounts, account, me, savedAt, online, pending, refresh, dropAccount],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
