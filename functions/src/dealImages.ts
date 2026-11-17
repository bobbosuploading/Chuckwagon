/**
 * Small product pictures for deals read from a shopper's ad photo. The scan marks where each
 * item's picture is on the page; we cut it out, shrink it to a ~240px WebP (about 5-10 KB) and
 * keep it in Firebase Storage under deal-images/. The ad photo itself is never kept.
 *
 * Cost: a heavy week for 10 testers is a few thousand pictures, tens of MB, well inside the
 * free 5 GB. Pictures are deleted with their deal when the ad ends (cleanEndedAdScans), and
 * anything older than MAX_AGE_DAYS is swept up in case a deal was removed some other way.
 *
 * Everything here is best effort: if Storage isn't set up, or a cutout fails, the deal is saved
 * without a picture and the app shows its category icon.
 */
import { randomUUID } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import * as logger from "firebase-functions/logger";
import sharp from "sharp";

export const DEAL_IMAGE_PREFIX = "deal-images/";
/** Ads run at most 21 days; anything older is left over. */
const MAX_AGE_DAYS = 30;
/** Longest side of a saved picture, in pixels. */
const THUMB_PX = 240;
/** The ad page is shrunk to this before cutting, which is plenty for 240px pictures. */
const PAGE_PX = 2000;

/** Where an item's picture is on the page, in thousandths of the page width and height (0-1000). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function bucketName(): string {
  try {
    const cfg = JSON.parse(process.env.FIREBASE_CONFIG ?? "{}") as { storageBucket?: string };
    if (cfg.storageBucket) return cfg.storageBucket;
  } catch {
    // fall through
  }
  return `${process.env.GCLOUD_PROJECT ?? "chuckwagon-ebbcc"}.firebasestorage.app`;
}

function bucket() {
  return getStorage().bucket(bucketName());
}

/** The Storage path for a deal's picture. Deal ids are letters, digits, - and _. */
export function dealImagePath(dealId: string): string {
  return `${DEAL_IMAGE_PREFIX}${dealId.replace(/[^A-Za-z0-9_-]/g, "")}.webp`;
}

/**
 * Turns a box from the model into a pixel rectangle with a little padding, or null when it
 * can't be a single product picture (missing, backwards, tiny, or most of the page).
 */
export function cropRect(box: Box | null | undefined, width: number, height: number) {
  if (!box) return null;
  const vals = [box.left, box.top, box.right, box.bottom];
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  const clamp = (v: number) => Math.min(1000, Math.max(0, v));
  let [l, t, r, b] = vals.map(clamp);
  if (r - l < 20 || b - t < 20) return null; // under 2% of the page: a misread
  if ((r - l) * (b - t) > 600_000) return null; // over 60% of the page: not one product
  // Pad 6% each way, since the model's boxes run a little tight or off-center.
  const padX = (r - l) * 0.06;
  const padY = (b - t) * 0.06;
  [l, t, r, b] = [clamp(l - padX), clamp(t - padY), clamp(r + padX), clamp(b + padY)];
  const left = Math.floor((l / 1000) * width);
  const top = Math.floor((t / 1000) * height);
  const w = Math.min(width - left, Math.ceil(((r - l) / 1000) * width));
  const h = Math.min(height - top, Math.ceil(((b - t) / 1000) * height));
  if (w < 24 || h < 24) return null;
  return { left, top, width: w, height: h };
}

/**
 * Cuts each item's picture out of the ad page and saves it. Returns a download URL per deal id
 * (missing when there was no usable box or the save failed). Never throws.
 */
export async function saveDealImages(
  imageBase64: string,
  items: { dealId: string; box: Box | null | undefined }[]
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const wanted = items.filter((it) => it.box);
  if (wanted.length === 0) return urls;
  try {
    // Decode the page once (turned upright from the photo's EXIF), then cut every picture from it.
    const { data, info } = await sharp(Buffer.from(imageBase64, "base64"))
      .rotate()
      .resize(PAGE_PX, PAGE_PX, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
    const b = bucket();
    await Promise.all(
      wanted.map(async ({ dealId, box }) => {
        const rect = cropRect(box, info.width, info.height);
        if (!rect) return;
        try {
          const webp = await sharp(data, raw)
            .extract(rect)
            .resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 70 })
            .toBuffer();
          const path = dealImagePath(dealId);
          const token = randomUUID();
          await b.file(path).save(webp, {
            resumable: false,
            contentType: "image/webp",
            metadata: {
              cacheControl: "public, max-age=604800",
              metadata: { firebaseStorageDownloadTokens: token },
            },
          });
          urls.set(
            dealId,
            `https://firebasestorage.googleapis.com/v0/b/${b.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`
          );
        } catch (err) {
          logger.warn("Deal picture not saved", { dealId, err: String(err) });
        }
      })
    );
  } catch (err) {
    logger.warn("Ad page pictures skipped", { err: String(err) });
  }
  return urls;
}

/** Deletes the pictures of deals that were removed. Missing pictures are fine. Never throws. */
export async function deleteDealImages(dealIds: string[]): Promise<void> {
  if (dealIds.length === 0) return;
  try {
    const b = bucket();
    await Promise.all(dealIds.map((id) => b.file(dealImagePath(id)).delete({ ignoreNotFound: true }).catch(() => undefined)));
  } catch (err) {
    logger.warn("Deal pictures not deleted", { err: String(err) });
  }
}

/** Deletes pictures older than any ad could run. Returns how many went. Never throws. */
export async function sweepOldDealImages(): Promise<number> {
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    const [files] = await bucket().getFiles({ prefix: DEAL_IMAGE_PREFIX });
    const old = files.filter((f) => Date.parse(String(f.metadata.timeCreated ?? "")) < cutoff);
    await Promise.all(old.map((f) => f.delete({ ignoreNotFound: true }).catch(() => undefined)));
    return old.length;
  } catch (err) {
    logger.warn("Old deal pictures not swept", { err: String(err) });
    return 0;
  }
}
