import { FieldValue, Firestore, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { requireApp } from "./appCheck";
import { checkWatchList, cleanWatchSettings, watchIsOn, watchMessage, WatchHit, WatchSettings } from "./saleWatch";
import { recordWatchPrices, WatchStoreCache } from "./watchData";

/**
 * Push notifications (Firebase Cloud Messaging, free). Both kinds are opt-in from Settings:
 *  - "New deals are in": a starred store's weekly ad changed. At most one every DEALS_GAP_DAYS.
 *  - Meal planning reminder: once a week on the day and hour the shopper picked.
 *  - Sale alerts: items on the shopper's watch list hit a good sale, or a cut on sale makes
 *    homemade bacon, ground beef or jerky worth it (saleWatch.ts). Checked once a day; at most
 *    one every WATCH_GAP_DAYS, and it stands in for the deals alert when both are due.
 * So a shopper gets three notifications a week at most, and usually one or two.
 *
 * Settings live on users/{uid}.notify (written only here):
 *   on, token, deals, planDay (-1 off, 0 = Sunday … 6), planHour (0-23), timeZone, storeIds,
 *   adKeys { storeId: latest deal end date seen }, lastDealsAlertAt, lastPlanNudgeAt,
 *   watch (WatchSettings), watchCheckedOn (local date), lastWatchAlertAt, watchSent { hit key: ISO date }
 */

const DEALS_GAP_DAYS = 6;
/** Deals alerts wait for daytime where the shopper lives. */
const DEALS_FIRST_HOUR = 9;
const DEALS_LAST_HOUR = 19;
const MAX_STORES = 8;
const TEST_PUSHES_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WATCH_GAP_DAYS = 6;
/** The daily watch check runs at the first hourly run from this local hour. */
const WATCH_FIRST_HOUR = 10;
/** A sale already announced isn't announced again for this long. */
const WATCH_SENT_DAYS = 14;
const WATCH_CHECKS_PER_DAY = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface NotifySettings {
  on?: boolean;
  token?: string;
  deals?: boolean;
  planDay?: number;
  planHour?: number;
  timeZone?: string;
  storeIds?: string[];
  adKeys?: Record<string, string>;
  lastDealsAlertAt?: string;
  lastPlanNudgeAt?: string;
  watch?: WatchSettings;
  watchCheckedOn?: string;
  lastWatchAlertAt?: string;
  watchSent?: Record<string, string>;
}

function validTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "America/Chicago";
  }
}

/** Weekday (0 = Sunday), hour (0-23) and date (YYYY-MM-DD) right now in a time zone. */
export function localNow(timeZone: string, now = new Date()): { weekday: number; hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    weekday: WEEKDAYS.indexOf(get("weekday")),
    hour: Number(get("hour")) % 24,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** Looks up stores once per run: name, and whose deals it shows (stores can share another store's ad). */
class StoreCache {
  private stores = new Map<string, Promise<{ name: string; adKey: string | null } | null>>();
  constructor(private db: Firestore) {}

  get(storeId: string) {
    let hit = this.stores.get(storeId);
    if (!hit) {
      hit = this.load(storeId);
      this.stores.set(storeId, hit);
    }
    return hit;
  }

  /** adKey: the latest end date among the store's deals. It moves forward when a new ad loads. */
  private async load(storeId: string) {
    const store = await this.db.doc(`stores/${storeId}`).get();
    if (!store.exists) return null;
    const dealStoreId = (store.get("dealsFrom") as string | undefined) || storeId;
    const latest = await this.db.collection("deals").where("storeId", "==", dealStoreId)
      .orderBy("validTo", "desc").limit(1).get();
    const adKey = latest.empty ? null : String(latest.docs[0].get("validTo") ?? "").slice(0, 10) || null;
    return { name: String(store.get("name") ?? "your store"), adKey };
  }
}

/** "New deals at H-E-B" or "New deals at H-E-B and 2 more". */
function dealsMessage(names: string[]): { title: string; body: string } {
  const unique = [...new Set(names)];
  const title = unique.length === 1
    ? `New deals at ${unique[0]}`
    : `New deals at ${unique[0]} and ${unique.length - 1} more`;
  return { title, body: "This week's sales are in. Tap to see what's on sale and plan supper." };
}

const PLAN_MESSAGE = {
  title: "Time to plan this week's suppers",
  body: "Tap Build a meal plan and we'll turn this week's sales into meals and a grocery list.",
};

type SendResult = "sent" | "bad-token" | "failed";

async function send(token: string, msg: { title: string; body: string }, kind: string): Promise<SendResult> {
  try {
    await getMessaging().send({
      token,
      notification: msg,
      data: { kind },
      apns: { payload: { aps: { sound: "default" } } },
    });
    return "sent";
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      return "bad-token";
    }
    logger.warn("Push failed", { kind, code, message: (e as Error).message });
    return "failed";
  }
}

/**
 * Settings > Notifications. Data: { token, deals, planDay, planHour, timeZone, storeIds, watch }.
 * Turning everything off keeps nothing but the switches.
 */
export const saveNotificationSettings = onCall(async (request) => {
  requireApp(request, "saveNotificationSettings");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const d = (request.data ?? {}) as Record<string, unknown>;
  const token = typeof d.token === "string" && d.token.length < 4096 ? d.token : "";
  const deals = d.deals === true;
  const planDay = Number.isInteger(d.planDay) && (d.planDay as number) >= 0 && (d.planDay as number) <= 6 ? (d.planDay as number) : -1;
  const planHour = Number.isInteger(d.planHour) && (d.planHour as number) >= 0 && (d.planHour as number) <= 23 ? (d.planHour as number) : 9;
  const timeZone = validTimeZone(d.timeZone);
  const storeIds = (Array.isArray(d.storeIds) ? d.storeIds : [])
    .filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(s))
    .slice(0, MAX_STORES);
  const watch = cleanWatchSettings(d.watch);
  const on = !!token && (deals || planDay >= 0 || watchIsOn(watch));

  const db = getFirestore();
  const ref = db.collection("users").doc(request.auth.uid);
  const user = await ref.get();
  const known = ((user.get("notify") as NotifySettings | undefined)?.adKeys) ?? {};

  // Remember each new store's current ad, so turning alerts on doesn't announce an ad that's
  // already been out for days. The next ad is the one that gets announced.
  const adKeys: Record<string, string> = {};
  if (on && deals) {
    const cache = new StoreCache(db);
    for (const id of storeIds) {
      if (known[id]) adKeys[id] = known[id];
      else {
        const store = await cache.get(id);
        if (store?.adKey) adKeys[id] = store.adKey;
      }
    }
  }

  await ref.set({
    notify: {
      on, token: on ? token : FieldValue.delete(), deals, planDay, planHour, timeZone, storeIds,
      adKeys, watch, updatedAt: new Date().toISOString(),
    },
  }, { mergeFields: ["notify.on", "notify.token", "notify.deals", "notify.planDay", "notify.planHour",
    "notify.timeZone", "notify.storeIds", "notify.adKeys", "notify.watch", "notify.updatedAt"] });
  logger.info("Notification settings saved", {
    uid: request.auth.uid, on, deals, planDay, planHour, stores: storeIds.length,
    watchItems: watch.items.length + watch.custom.length, diy: [watch.bacon, watch.groundBeef, watch.jerky].filter(Boolean).length,
  });
  return { on };
});

/** "Send a test notification" in Settings, so testers can check pushes reach their phone. */
export const sendTestNotification = onCall(async (request) => {
  requireApp(request, "sendTestNotification");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const token = typeof request.data?.token === "string" ? request.data.token as string : "";
  if (!token) throw new HttpsError("failed-precondition", "Notifications aren't set up on this phone yet. Turn one on above first.");
  const db = getFirestore();
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const usage = db.collection("usage").doc(`${request.auth.uid}_${day}`);
  await db.runTransaction(async (tx) => {
    const u = await tx.get(usage);
    if (((u.get("testPush") as number | undefined) ?? 0) >= TEST_PUSHES_PER_DAY) {
      throw new HttpsError("resource-exhausted", "That's enough test notifications for today.");
    }
    tx.set(usage, { uid: request.auth!.uid, day, testPush: FieldValue.increment(1) }, { merge: true });
  });
  const result = await send(token, { title: "Howdy from Chuckwagon", body: "Notifications are working. We'll keep them to a couple a week." }, "test");
  if (result !== "sent") throw new HttpsError("unavailable", "Couldn't send the test notification. Try again in a minute.");
  return { sent: true };
});

/**
 * Settings > Sale alerts > "What's on sale now": the watch list checked against this week's
 * deals right away, so shoppers can see what an alert would say. Data: { storeIds, watch }.
 * Returns every watched item on sale, with `alert` true for the ones that pass the threshold.
 */
export const checkSaleWatch = onCall(async (request) => {
  requireApp(request, "checkSaleWatch");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const d = (request.data ?? {}) as Record<string, unknown>;
  const watch = cleanWatchSettings(d.watch);
  const storeIds = (Array.isArray(d.storeIds) ? d.storeIds : [])
    .filter((s): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(s))
    .slice(0, MAX_STORES);
  if (!watchIsOn(watch) || !storeIds.length) return { hits: [] };
  const db = getFirestore();
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const usage = db.collection("usage").doc(`${request.auth.uid}_${day}`);
  await db.runTransaction(async (tx) => {
    const u = await tx.get(usage);
    if (((u.get("watchChecks") as number | undefined) ?? 0) >= WATCH_CHECKS_PER_DAY) {
      throw new HttpsError("resource-exhausted", "That's enough checks for today. Your alerts still come on their own.");
    }
    tx.set(usage, { uid: request.auth!.uid, day, watchChecks: FieldValue.increment(1) }, { merge: true });
  });
  const stores = await new WatchStoreCache(db).many(storeIds);
  const histories = new Map(stores.map((s) => [s.sourceId, s.history]));
  const hits = checkWatchList(watch, stores.flatMap((s) => s.offers), histories, localNow(validTimeZone(d.timeZone)).date);
  return { hits: hits.slice(0, 40).map(publicHit) };
});

function publicHit(h: WatchHit) {
  return { label: h.label, kind: h.kind, line: h.line, storeName: h.storeName, product: h.product, pct: h.pct, alert: h.alert };
}

/**
 * The daily watch check for one shopper. Returns hits to announce (already filtered for ones
 * sent before) and the settings updates to save.
 */
async function watchAlerts(n: NotifySettings, cache: WatchStoreCache, db: Firestore, today: string, now: Date):
  Promise<{ hits: WatchHit[]; sent: Record<string, string> }> {
  const stores = await cache.many(n.storeIds ?? []);
  // Each store's price history grows by one point a day, whoever's check gets there first.
  for (const s of stores) await recordWatchPrices(db, s, today).catch((e) => logger.warn("watchPrices write failed", { store: s.sourceId, message: (e as Error).message }));
  const histories = new Map(stores.map((s) => [s.sourceId, s.history]));
  const cutoff = now.getTime() - WATCH_SENT_DAYS * DAY_MS;
  const sent = Object.fromEntries(Object.entries(n.watchSent ?? {}).filter(([, at]) => Date.parse(at) > cutoff));
  const hits = checkWatchList(n.watch!, stores.flatMap((s) => s.offers), histories, today)
    .filter((h) => h.alert && !sent[h.key]);
  return { hits, sent };
}

/** Hourly: sends planning reminders that are due, and deals alerts for newly loaded ads. */
export const sendNotifications = onSchedule(
  { schedule: "every 1 hours", timeZone: "America/Chicago", memory: "256MiB" },
  async () => {
    const db = getFirestore();
    const users = await db.collection("users").where("notify.on", "==", true).get();
    const stores = new StoreCache(db);
    const watchStores = new WatchStoreCache(db);
    const now = new Date();
    let plans = 0, dealAlerts = 0, watchAlertsSent = 0, dropped = 0;

    for (const user of users.docs) {
      const n = user.get("notify") as NotifySettings;
      if (!n?.token) continue;
      const local = localNow(validTimeZone(n.timeZone), now);
      const update: Record<string, unknown> = {};
      let badToken = false;

      // Weekly planning reminder, at the hour the shopper picked.
      const lastPlan = n.lastPlanNudgeAt ? Date.parse(n.lastPlanNudgeAt) : 0;
      if ((n.planDay ?? -1) === local.weekday && (n.planHour ?? 9) === local.hour && now.getTime() - lastPlan > DAY_MS) {
        const r = await send(n.token, PLAN_MESSAGE, "plan");
        if (r === "sent") { update["notify.lastPlanNudgeAt"] = now.toISOString(); plans++; }
        badToken ||= r === "bad-token";
      }

      // Sale alerts for the watch list, checked once a day during the day.
      let watchSent = false;
      const daytimeNow = local.hour >= DEALS_FIRST_HOUR && local.hour <= DEALS_LAST_HOUR;
      if (!badToken && watchIsOn(n.watch) && (n.storeIds?.length ?? 0) > 0 && local.hour >= WATCH_FIRST_HOUR &&
        daytimeNow && n.watchCheckedOn !== local.date) {
        update["notify.watchCheckedOn"] = local.date;
        const lastWatch = n.lastWatchAlertAt ? Date.parse(n.lastWatchAlertAt) : 0;
        if (now.getTime() - lastWatch >= WATCH_GAP_DAYS * DAY_MS) {
          try {
            const { hits, sent } = await watchAlerts(n, watchStores, db, local.date, now);
            if (hits.length) {
              const r = await send(n.token, watchMessage(hits), "watch");
              if (r === "sent") {
                hits.forEach((h) => { sent[h.key] = now.toISOString(); });
                update["notify.lastWatchAlertAt"] = now.toISOString();
                watchSent = true;
                watchAlertsSent++;
              }
              badToken ||= r === "bad-token";
            }
            update["notify.watchSent"] = sent;
          } catch (e) {
            logger.warn("Watch check failed", { uid: user.id, message: (e as Error).message });
          }
        }
      }

      // New weekly ads at the shopper's stores.
      if (!badToken && n.deals && (n.storeIds?.length ?? 0) > 0) {
        const known = n.adKeys ?? {};
        const fresh: { id: string; name: string; adKey: string }[] = [];
        for (const id of n.storeIds ?? []) {
          const store = await stores.get(id);
          if (!store?.adKey) continue;
          // Only ads that are still running and newer than the one we last saw.
          if (store.adKey >= local.date && store.adKey > (known[id] ?? "")) fresh.push({ id, name: store.name, adKey: store.adKey });
        }
        if (fresh.length) {
          const lastDeals = n.lastDealsAlertAt ? Date.parse(n.lastDealsAlertAt) : 0;
          const daytime = local.hour >= DEALS_FIRST_HOUR && local.hour <= DEALS_LAST_HOUR;
          const tooSoon = now.getTime() - lastDeals < DEALS_GAP_DAYS * DAY_MS;
          if (daytime && !tooSoon && watchSent) {
            // The sale alert just went out; one notification is enough today. Count the ads as announced.
            update["notify.lastDealsAlertAt"] = now.toISOString();
            fresh.forEach((f) => { update[`notify.adKeys.${f.id}`] = f.adKey; });
          } else if (daytime && !tooSoon) {
            const r = await send(n.token, dealsMessage(fresh.map((f) => f.name)), "deals");
            if (r === "sent") { update["notify.lastDealsAlertAt"] = now.toISOString(); dealAlerts++; }
            badToken ||= r === "bad-token";
            if (r !== "failed") fresh.forEach((f) => { update[`notify.adKeys.${f.id}`] = f.adKey; });
          } else if (tooSoon) {
            // Already told them this week: count these ads as seen instead of announcing them late.
            fresh.forEach((f) => { update[`notify.adKeys.${f.id}`] = f.adKey; });
          }
        }
      }

      if (badToken) {
        // The app was deleted or notifications were turned off in iOS Settings.
        update["notify.on"] = false;
        update["notify.token"] = FieldValue.delete();
        dropped++;
      }
      if (Object.keys(update).length) await user.ref.update(update);
    }
    logger.info("Notifications sent", { users: users.size, plans, dealAlerts, watchAlerts: watchAlertsSent, dropped });
  }
);
