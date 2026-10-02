/**
 * Centre-crop an uploaded image to a `px` square and encode it small enough to
 * live on a server row (a vault's icon, a profile picture): PNG keeps a logo's
 * transparency, and a photo that comes out too large as PNG falls back to JPEG.
 */
export async function imageFileToSquareDataUrl(
  file: File,
  px: number,
  maxChars: number,
): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't an image we can read.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process the image.");
  const side = Math.min(bitmap.width, bitmap.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
  bitmap.close();
  const png = canvas.toDataURL("image/png");
  if (png.length <= maxChars) return png;
  const jpeg = canvas.toDataURL("image/jpeg", 0.85);
  if (jpeg.length <= maxChars) return jpeg;
  throw new Error("That image is too detailed to use here. Try a simpler one.");
}
