/**
 * Send a plan's grocery list to a store's cart.
 *
 * Kroger (and its family stores): the shopper signs in with Kroger once. The backend
 * keeps their refresh token (Firestore krogerTokens/{uid}, never readable by the app)
 * and hands the phone a short-lived access token. The PHONE then searches products
 * and adds them to the cart, because Kroger blocks product and cart calls from
 * Google Cloud. Only the sign-in token exchange runs here, so the client secret
 * never ships inside the app.
 *
 * Everything else (H-E-B, ALDI, ...): an Instacart shopping list link. The shopper
 * opens it, picks their store in Instacart, and adds the items to that store's cart.
 *
 * Settings come from functions/.env (written by the deploy workflow from GitHub secrets):
 *   KROGER_CLIENT_ID, KROGER_CLIENT_SECRET, INSTACART_API_KEY, INSTACART_API_URL (optional)
 * Missing settings don't break the deploy; the feature just says it isn't set up yet.
 */
import { randomBytes } from "node:crypto";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

const KROGER_API = "https://api.kroger.com/v1";
/** Add to the shopper's cart, and search products at their store. */
const KROGER_SCOPES = "cart.basic:write product.compact";
/** Where the app listens for the end of the Kroger sign-in. */
const APP_RETURN = "chuckwagon://kroger";
const USER_AGENT = "Chuckwagon/0.1 (grocery deal meal planner)";

function krogerCreds(): { id: string; secret: string } {
  const id = process.env.KROGER_CLIENT_ID ?? "";
  const secret = process.env.KROGER_CLIENT_SECRET ?? "";
  if (!id || !secret) throw new HttpsError("failed-precondition", "Kroger sign-in isn't set up yet.");
  return { id, secret };
}

/** This function's public URL, which must be registered as a redirect URI in the Kroger developer portal. */
function callbackUrl(): string {
  const project = process.env.GCLOUD_PROJECT ?? "chuckwagon-ebbcc";
  return process.env.KROGER_REDIRECT_URI ?? `https://us-central1-${project}.cloudfunctions.net/krogerCallback`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function krogerToken(body: Record<string, string>): Promise<TokenResponse> {
  const { id, secret } = krogerCreds();
  const res = await fetch(`${KROGER_API}/connect/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error("Kroger token request failed", { status: res.status, body: text.slice(0, 500) });
    throw new Error(`Kroger token request failed (${res.status})`);
  }
  return (await res.json()) as TokenResponse;
}

/** Step 1: the app asks where to send the shopper to sign in with Kroger. */
export const krogerConnectUrl = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const { id } = krogerCreds();
  const state = randomBytes(24).toString("hex");
  await getFirestore().collection("krogerAuth").doc(state).set({ uid: request.auth.uid, createdAt: Date.now() });
  const qs = new URLSearchParams({
    scope: KROGER_SCOPES,
    response_type: "code",
    client_id: id,
    redirect_uri: callbackUrl(),
    state,
  });
  return { url: `${KROGER_API}/connect/oauth2/authorize?${qs}`, returnScheme: "chuckwagon" };
});

/** Step 2: Kroger sends the shopper here after they sign in. Swap the code for tokens, then return to the app. */
export const krogerCallback = onRequest(async (req, res) => {
  const back = (status: string) => res.redirect(302, `${APP_RETURN}?status=${status}`);
  const state = String(req.query.state ?? "");
  const code = String(req.query.code ?? "");
  if (req.query.error || !state || !code) {
    back(req.query.error === "access_denied" ? "cancelled" : "error");
    return;
  }
  const db = getFirestore();
  const stateRef = db.collection("krogerAuth").doc(state);
  const snap = await stateRef.get();
  await stateRef.delete().catch(() => undefined);
  const uid = snap.get("uid") as string | undefined;
  // State links this sign-in to the Chuckwagon user who started it; it's good for 10 minutes.
  if (!uid || Date.now() - ((snap.get("createdAt") as number) ?? 0) > 10 * 60_000) {
    back("expired");
    return;
  }
  try {
    const t = await krogerToken({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() });
    await db.collection("krogerTokens").doc(uid).set({
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: Date.now() + t.expires_in * 1000,
      connectedAt: FieldValue.serverTimestamp(),
    });
    await db.collection("users").doc(uid).set({ krogerConnected: true }, { merge: true });
    logger.info("Kroger connected", { uid });
    back("ok");
  } catch (err) {
    logger.error("Kroger connect failed", err);
    back("error");
  }
});

/** Step 3: the app asks for a fresh access token each time it sends a list to the cart. */
export const krogerAccessToken = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const db = getFirestore();
  const ref = db.collection("krogerTokens").doc(request.auth.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Connect your Kroger account first.");
  const expiresAt = (snap.get("expiresAt") as number) ?? 0;
  if (Date.now() < expiresAt - 2 * 60_000) {
    return { accessToken: snap.get("accessToken") as string, expiresAt };
  }
  const refreshToken = snap.get("refreshToken") as string | null;
  if (!refreshToken) throw new HttpsError("not-found", "Connect your Kroger account again.");
  try {
    const t = await krogerToken({ grant_type: "refresh_token", refresh_token: refreshToken });
    const next = { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: Date.now() + t.expires_in * 1000 };
    await ref.set(next, { merge: true });
    return { accessToken: next.accessToken, expiresAt: next.expiresAt };
  } catch (err) {
    // Refresh tokens expire after months of no use, or when the shopper changes their Kroger password.
    logger.warn("Kroger refresh failed", { uid: request.auth.uid, err: (err as Error).message });
    await ref.delete();
    await db.collection("users").doc(request.auth.uid).set({ krogerConnected: false }, { merge: true });
    throw new HttpsError("not-found", "Your Kroger sign-in expired. Connect your Kroger account again.");
  }
});

export const krogerDisconnect = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const db = getFirestore();
  await db.collection("krogerTokens").doc(request.auth.uid).delete();
  await db.collection("users").doc(request.auth.uid).set({ krogerConnected: false }, { merge: true });
  return { ok: true };
});

interface PlanListItem {
  item: string;
  buyCount: number;
  quantityNote: string;
  aisle: string;
  storeId?: string;
}

/** Turns "Chicken thighs, family pack (about 3 lb)" into a good Instacart search term. */
export function searchTerm(item: string): string {
  return item.replace(/\(.*?\)/g, "").split(",")[0].replace(/\s+/g, " ").trim() || item;
}

/**
 * H-E-B and other stores: builds an Instacart shopping list for one store's part of a plan.
 * Skips items the shopper already checked off. Returns the link to open.
 */
export const instacartShoppingList = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const apiKey = process.env.INSTACART_API_KEY ?? "";
  if (!apiKey) throw new HttpsError("failed-precondition", "Instacart isn't set up yet.");
  const planId = String(request.data?.planId ?? "");
  const storeId = request.data?.storeId ? String(request.data.storeId) : null;
  if (!planId) throw new HttpsError("invalid-argument", "planId is required");

  const plan = await getFirestore().collection("plans").doc(planId).get();
  if (!plan.exists || plan.get("uid") !== request.auth.uid) throw new HttpsError("not-found", "Plan not found");
  const checked = new Set((plan.get("checked") as string[] | undefined) ?? []);
  const list = ((plan.get("groceryList") as PlanListItem[]) ?? []).filter(
    (li) => !checked.has(`${li.aisle}|${li.item}`) && (!storeId || (li.storeId ?? plan.get("storeId")) === storeId)
  );
  if (list.length === 0) throw new HttpsError("failed-precondition", "Everything on this list is checked off.");

  const storeName = (plan.get("stores") as { storeId: string; storeName: string }[] | undefined)?.find((s) => s.storeId === storeId)?.storeName;
  const body = {
    title: `Chuckwagon list${storeName ? ` for ${storeName}` : ""}`,
    link_type: "shopping_list",
    expires_in: 30,
    line_items: list.map((li) => ({
      name: searchTerm(li.item),
      display_text: li.quantityNote ? `${li.item} (${li.quantityNote})` : li.item,
      line_item_measurements: [{ quantity: Math.max(1, li.buyCount || 1), unit: "each" }],
    })),
  };
  const base = process.env.INSTACART_API_URL || "https://connect.instacart.com";
  const res = await fetch(`${base}/idp/v1/products/products_link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    logger.error("Instacart link failed", { status: res.status, body: (await res.text()).slice(0, 500) });
    throw new HttpsError("unavailable", "Instacart didn't answer. Please try again in a minute.");
  }
  const json = (await res.json()) as { products_link_url: string };
  logger.info("Instacart list created", { planId, storeId, items: list.length });
  return { url: json.products_link_url, items: list.length };
});
