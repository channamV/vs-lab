/**
 * Shrinks a photo in the browser before it's sent (phones take 3–8 MB pictures; Vercel accepts about 4.5 MB per
 * request): longest side `maxSide` px, JPEG. Falls back to the original if the browser can't. Browser only.
 */
export async function shrinkPhoto(file: File, maxSide = 1280, quality = 0.75): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}
