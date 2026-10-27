import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { Account } from "./types";

/**
 * The phone's sign-ins: one per company the operator's email belongs to (usually one). Tokens live in the phone's
 * secure storage (Keychain / Keystore); which company is showing is a plain setting.
 */

const ACCOUNTS = "vslab.accounts";
const CURRENT = "vslab.currentOperator";

export async function loadAccounts(): Promise<Account[]> {
  const raw = await SecureStore.getItemAsync(ACCOUNTS);
  try {
    return raw ? (JSON.parse(raw) as Account[]) : [];
  } catch {
    return [];
  }
}

export async function saveAccounts(accounts: Account[]) {
  if (accounts.length) await SecureStore.setItemAsync(ACCOUNTS, JSON.stringify(accounts));
  else await SecureStore.deleteItemAsync(ACCOUNTS);
}

export async function currentOperatorId(): Promise<number | null> {
  const v = await AsyncStorage.getItem(CURRENT);
  return v ? Number(v) : null;
}

export async function setCurrentOperatorId(id: number | null) {
  if (id === null) await AsyncStorage.removeItem(CURRENT);
  else await AsyncStorage.setItem(CURRENT, String(id));
}
