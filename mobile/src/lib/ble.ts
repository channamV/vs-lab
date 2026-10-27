import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, State } from "react-native-ble-plx";

/**
 * Unlocking a Safety & Access Control machine over Bluetooth (docs/operator-app.md, docs/starter-relay.md). The
 * machine's device advertises as `VS-<device ID>`; the app writes the unlock pass from vs-lab to the unlock
 * characteristic and reads back the device's answer (OK / EXPIRED / BAD_SIG / LOCKED / …). No reconnecting in the
 * background: the device keeps the machine startable for the start window and break time itself.
 */

export const VSLAB_BLE = {
  service: "7f3c0001-6a2b-4b4e-9b1e-56a5c0de0001",
  unlock: "7f3c0002-6a2b-4b4e-9b1e-56a5c0de0001",
  scanSeconds: 12,
};

export const UNLOCK_ANSWERS: Record<string, string> = {
  OK: "Unlocked: start the machine.",
  EXPIRED: "The pass has expired. Refresh with signal and try again.",
  BAD_SIG: "The machine didn't accept the pass. Ask your supervisor.",
  LOCKED: "The machine is Locked. Ask your supervisor.",
  NOT_YOURS: "This pass is for a different machine.",
};

let manager: BleManager | null = null;
const ble = () => (manager ??= new BleManager());

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

/** Writes the pass to the machine; returns the device's answer in words. */
export async function unlockMachine(bluetoothName: string, pass: string): Promise<{ ok: boolean; message: string }> {
  const problem = await bluetoothProblem();
  if (problem) return { ok: false, message: problem };
  const id = await findDevice(bluetoothName);
  if (!id) return { ok: false, message: "Couldn't find the machine. Stand next to it with Bluetooth on, then try again." };
  try {
    const device = await ble().connectToDevice(id, { timeout: 10_000 });
    await device.discoverAllServicesAndCharacteristics();
    await device.writeCharacteristicWithResponseForService(VSLAB_BLE.service, VSLAB_BLE.unlock, toBase64(pass));
    const answer = fromBase64((await device.readCharacteristicForService(VSLAB_BLE.service, VSLAB_BLE.unlock)).value).trim();
    await device.cancelConnection().catch(() => {});
    return { ok: answer === "OK", message: UNLOCK_ANSWERS[answer] ?? (answer ? `The machine answered: ${answer}` : "Sent. Try starting the machine.") };
  } catch {
    await ble().cancelDeviceConnection(id).catch(() => {});
    return { ok: false, message: "Couldn't talk to the machine. Move closer and try again." };
  }
}
