import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, State, type Device } from "react-native-ble-plx";
import { HOLD_OVER, resumeMessage } from "./hold-rules";
import type { HeldSession } from "./types";

/**
 * Talking to a Safety & Access Control machine over Bluetooth (docs/operator-app.md, docs/starter-relay.md). The
 * machine's device advertises as `VS-<device ID>`.
 *  - Unlock: the app writes the unlock pass from vs-lab to the unlock characteristic and reads back the device's answer
 *    (OK / EXPIRED / BAD_SIG / LOCKED / …).
 *  - Session hold (resume after a break): the app reads a random challenge from the nonce characteristic and writes
 *    `R1|…|proof` (src/lib/hold-rules.ts). While a check-in is held, the app keeps a connection request open for the
 *    machine, so the phone answers by itself when the operator walks back to it (iPhone: also when the app is in the
 *    background or was closed by the system; Android: while the app is still running).
 */

export const VSLAB_BLE = {
  service: "7f3c0001-6a2b-4b4e-9b1e-56a5c0de0001",
  unlock: "7f3c0002-6a2b-4b4e-9b1e-56a5c0de0001",
  nonce: "7f3c0003-6a2b-4b4e-9b1e-56a5c0de0001",
  scanSeconds: 12,
  /** iPhone: lets iOS relaunch the app in the background for a held check-in's connection. */
  restoreId: "vslab-hold",
  /** After a failed background attempt, wait this long before asking again. */
  retrySeconds: 15,
};

export const UNLOCK_ANSWERS: Record<string, string> = {
  OK: "Unlocked: start the machine.",
  EXPIRED: "The pass has expired. Refresh with signal and try again.",
  BAD_SIG: "The machine didn't accept the pass. Ask your supervisor.",
  LOCKED: "The machine is Locked. Ask your supervisor.",
  NOT_YOURS: "This pass is for a different machine.",
};

export const RESUME_ANSWERS: Record<string, string> = {
  OK: "Welcome back: start the machine. Your check-in carries on.",
  NOT_HELD: "The machine isn't holding your check-in any more (it ended, or someone else checked in). Check in again.",
  EXPIRED: "Your break ran past the hold time. Check in again.",
  BAD_SIG: "The machine didn't accept your phone. Check in again.",
  LOCKED: "The machine is Locked. Ask your supervisor.",
  TOO_FAR: "Get closer to the machine (in the cab), then try again.",
};

let manager: BleManager | null = null;
const ble = () => (manager ??= new BleManager({ restoreStateIdentifier: VSLAB_BLE.restoreId, restoreStateFunction: () => {} }));

async function androidPermissions() {
  if (Platform.OS !== "android") return true;
  const wanted =
    Number(Platform.Version) >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

/** Bluetooth problems in the operator's words, or null when ready. */
export async function bluetoothProblem(): Promise<string | null> {
  if (!(await androidPermissions())) return "Allow VS Lab to use Bluetooth (phone Settings → Apps → VS Lab → Permissions).";
  const state = await ble().state();
  if (state === State.PoweredOn) return null;
  if (state === State.PoweredOff) return "Turn on Bluetooth, then try again.";
  if (state === State.Unauthorized) return "Allow VS Lab to use Bluetooth in the phone's settings.";
  if (state === State.Unsupported) return "This phone doesn't support Bluetooth Low Energy.";
  return null;
}

const toBase64 = (text: string) => btoa(text);
const fromBase64 = (b64: string | null) => (b64 ? atob(b64) : "");

/** Finds the machine's device nearby (by its Bluetooth name). */
function findDevice(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (id: string | null) => {
      if (done) return;
      done = true;
      ble().stopDeviceScan().catch(() => {});
      resolve(id);
    };
    setTimeout(() => finish(null), VSLAB_BLE.scanSeconds * 1000);
    ble()
      .startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) return finish(null);
        if (device && (device.name === name || device.localName === name)) finish(device.id);
      })
      .catch(() => finish(null));
  });
}

// Machines the background watcher keeps a connection to, and ones the operator is using right now (the watcher
// leaves those alone).
const watched = new Set<string>();
const inUse = new Set<string>();

/** The machine's device, connected: reuses an open connection (the watcher's), else connects. */
async function open(id: string, timeout: number | null): Promise<Device> {
  if (await ble().isDeviceConnected(id)) {
    const [d] = await ble().devices([id]);
    if (d) return d;
  }
  // A background request waiting for this machine would block a new one.
  if (timeout !== null) await ble().cancelDeviceConnection(id).catch(() => {});
  const device = await ble().connectToDevice(id, timeout === null ? { autoConnect: Platform.OS === "android" } : { timeout });
  await device.discoverAllServicesAndCharacteristics();
  return device;
}

async function exchange(device: Device, message: string) {
  await device.writeCharacteristicWithResponseForService(VSLAB_BLE.service, VSLAB_BLE.unlock, toBase64(message));
  return fromBase64((await device.readCharacteristicForService(VSLAB_BLE.service, VSLAB_BLE.unlock)).value).trim();
}

async function prove(device: Device, held: HeldSession) {
  const nonce = fromBase64((await device.readCharacteristicForService(VSLAB_BLE.service, VSLAB_BLE.nonce)).value);
  return exchange(device, resumeMessage(held.session, nonce));
}

/** Does something with the machine while the operator waits: finds it, connects, runs `fn`. */
async function withMachine<T>(name: string, knownId: string | null, fn: (d: Device) => Promise<T>): Promise<{ id: string; value: T } | { error: string }> {
  const problem = await bluetoothProblem();
  if (problem) return { error: problem };
  const id = (knownId && (await ble().isDeviceConnected(knownId).catch(() => false)) ? knownId : null) ?? (await findDevice(name)) ?? knownId;
  if (!id) return { error: "Couldn't find the machine. Stand next to it with Bluetooth on, then try again." };
  inUse.add(id);
  try {
    const device = await open(id, 10_000);
    const value = await fn(device);
    if (!watched.has(id)) await device.cancelConnection().catch(() => {});
    return { id, value };
  } catch {
    if (!watched.has(id)) await ble().cancelDeviceConnection(id).catch(() => {});
    return { error: "Couldn't talk to the machine. Move closer and try again." };
  } finally {
    inUse.delete(id);
  }
}

/** Writes the pass to the machine; returns the device's answer in words, and the machine's Bluetooth id. */
export async function unlockMachine(bluetoothName: string, pass: string, knownId: string | null = null): Promise<{ ok: boolean; message: string; bleId: string | null }> {
  const r = await withMachine(bluetoothName, knownId, (d) => exchange(d, pass));
  if ("error" in r) return { ok: false, message: r.error, bleId: null };
  return { ok: r.value === "OK", message: UNLOCK_ANSWERS[r.value] ?? (r.value ? `The machine answered: ${r.value}` : "Sent. Try starting the machine."), bleId: r.id };
}

/** The "I'm back" button: proves the phone to the machine holding the operator's check-in. */
export async function resumeMachine(held: HeldSession): Promise<{ ok: boolean; message: string; answer: string | null; bleId: string | null }> {
  const r = await withMachine(held.bluetoothName, held.bleId, (d) => prove(d, held));
  if ("error" in r) return { ok: false, message: r.error, answer: null, bleId: null };
  return { ok: r.value === "OK", message: RESUME_ANSWERS[r.value] ?? `The machine answered: ${r.value}`, answer: r.value, bleId: r.id };
}

/**
 * Keeps a connection request open for a held check-in's machine and proves the phone each time it connects (the
 * operator is back). Calls `onAnswer` with the device's answer; stops by itself once the hold is over. Returns stop().
 */
export function watchHold(held: HeldSession, onAnswer: (answer: string) => void): () => void {
  const id = held.bleId;
  if (!id) return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  watched.add(id);
  const again = (seconds: number) => {
    if (!stopped) timer = setTimeout(run, seconds * 1000);
  };
  async function run() {
    if (stopped) return;
    if (inUse.has(id!) || held.session.until * 1000 < Date.now()) return again(VSLAB_BLE.retrySeconds);
    try {
      if ((await ble().state()) !== State.PoweredOn) return again(60);
      const device = await open(id!, null);
      if (stopped) return;
      const answer = await prove(device, held);
      onAnswer(answer);
      if (HOLD_OVER.includes(answer)) {
        stop();
        await device.cancelConnection().catch(() => {});
        return;
      }
      // Stay connected (the device can see the phone is near); ask again once the operator walks away.
      const sub = device.onDisconnected(() => {
        sub.remove();
        again(1);
      });
    } catch {
      again(VSLAB_BLE.retrySeconds);
    }
  }
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    watched.delete(id!);
  }
  run();
  return () => {
    stop();
    ble().cancelDeviceConnection(id).catch(() => {});
  };
}
