import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Location from "expo-location";
import type { PhotoRef } from "./checklist-form";

/** Camera and location, the way the vs-lab QR page uses them. */

/** Takes a photo and shrinks it like the QR page does (about 0.2 MB), or null if cancelled / not allowed. */
export async function takePhoto(): Promise<PhotoRef | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return null;
  const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
  if (shot.canceled || !shot.assets[0]) return null;
  const asset = shot.assets[0];
  const longest = Math.max(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (longest > 1280) context.resize(asset.width >= asset.height ? { width: 1280 } : { height: 1280 });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG });
  return { uri: saved.uri, name: `photo-${Date.now()}.jpg`, type: "image/jpeg" };
}

/** The phone's position (to confirm the operator is at the machine), or null if not allowed / not found in time. */
export async function phonePosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    if (!fix) return null;
    return { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? 0 };
  } catch {
    return null;
  }
}
