/**
 * Keeps the paid scraper runs inside Apify's free $5 a month.
 *
 * A monthly job can start twice: GitHub may start a scheduled run hours late, after someone
 * already ran it by hand. Two H-E-B runs in one month use up the whole allowance, so each
 * saving run first checks the `runs` log and skips itself when one was already saved recently.
 */
import { getFirestore } from "firebase-admin/firestore";

/** Shorter than a month, so the next month's scheduled run is never skipped. */
export const MIN_DAYS_BETWEEN_RUNS = 25;

/** The date of this job's last saved run, if it was within MIN_DAYS_BETWEEN_RUNS. */
export async function savedRunWithin(type: "heb-prices" | "sams-club", days = MIN_DAYS_BETWEEN_RUNS): Promise<Date | null> {
  const snap = await getFirestore().collection("runs").where("type", "==", type).get();
  const cutoff = Date.now() - days * 86_400_000;
  let latest: Date | null = null;
  for (const doc of snap.docs) {
    if (doc.get("saved") === false) continue;
    const at = doc.get("at")?.toDate?.() as Date | undefined;
    if (at && at.getTime() >= cutoff && (!latest || at > latest)) latest = at;
  }
  return latest;
}
