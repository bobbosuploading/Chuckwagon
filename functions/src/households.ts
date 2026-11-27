/**
 * Shared shopping list: a household that one shopper starts and invites family to by link.
 *
 * Apple's Family Sharing doesn't tell apps who is in a family, so joining goes through an invite
 * link (https://chuckwagon-ebbcc.web.app/h/{code}) instead. Once someone joins, every member's app
 * listens to the same list in Firestore, so adding or checking off an item shows up on all phones.
 *
 * Firestore:
 * - households/{id}: { members: [uid], names: { uid: "Bobby" }, createdBy, createdAt }.
 *   Members can read it; only these functions write it.
 * - households/{id}/onHand/{itemId}: food the household has at home ("Cook from what I have"),
 *   read and written by members straight from the app like items.
 * - households/{id}/items/{itemId}: the list. Members read and write items straight from the app
 *   (firestore.rules checks membership and the item's shape), so list edits cost no function runs.
 * - householdInvites/{code}: { householdId, createdBy, expiresAt, uses }. Backend only.
 * - users/{uid}.householdId: which household the shopper is in (one at a time).
 *
 * Members must have signed in with Apple, so a reinstall doesn't lose the household.
 */
import { randomBytes } from "node:crypto";
import { FieldValue, Firestore } from "firebase-admin/firestore";

export class HouseholdError extends Error {
  constructor(
    public code: "not-found" | "failed-precondition" | "resource-exhausted" | "invalid-argument",
    message: string
  ) {
    super(message);
  }
}

export const HOUSEHOLD_LIMITS = {
  maxMembers: 6,
  inviteDays: 7,
  usesPerInvite: 5,
  invitesPerUserPerDay: 20,
  /** Items carried over from a solo list when its owner joins someone else's household. */
  maxCarriedItems: 200,
};

/** Where invite links point (same Hosting site as shared meals). */
export const INVITE_PATH = "/h/";
export const INVITE_CODE = /^[A-Za-z0-9]{10}$/;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function newInviteCode(): string {
  return [...randomBytes(10)].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

/** A first name to show beside items ("added by Bobby"), trimmed to something sane. */
export function cleanMemberName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 30) : "";
}

export interface HouseholdInfo {
  householdId: string;
  members: { uid: string; name: string }[];
}

function info(id: string, members: string[], names: Record<string, string>): HouseholdInfo {
  return { householdId: id, members: members.map((uid) => ({ uid, name: names[uid] ?? "" })) };
}

/**
 * The shopper's household, starting one if they have none. Saves their name for the others to see.
 */
export async function ensureHousehold(db: Firestore, uid: string, name: string): Promise<HouseholdInfo> {
  const userRef = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const user = await tx.get(userRef);
    const current = user.get("householdId") as string | undefined;
    if (current) {
      const ref = db.collection("households").doc(current);
      const h = await tx.get(ref);
      const members = (h.get("members") as string[] | undefined) ?? [];
      if (h.exists && members.includes(uid)) {
        const names = { ...((h.get("names") as Record<string, string> | undefined) ?? {}) };
        if (name && names[uid] !== name) {
          names[uid] = name;
          tx.update(ref, { [`names.${uid}`]: name });
        }
        return info(current, members, names);
      }
    }
    const ref = db.collection("households").doc();
    const names = name ? { [uid]: name } : {};
    tx.set(ref, { members: [uid], names, createdBy: uid, createdAt: new Date().toISOString() });
    tx.set(userRef, { householdId: ref.id }, { merge: true });
    return info(ref.id, [uid], names);
  });
}

/** A link others can open to join the shopper's household. Starts the household if needed. */
export async function createInvite(db: Firestore, uid: string, name: string): Promise<{ code: string; expiresAt: string }> {
  const household = await ensureHousehold(db, uid, name);
  if (household.members.length >= HOUSEHOLD_LIMITS.maxMembers) {
    throw new HouseholdError("resource-exhausted", `A household can have up to ${HOUSEHOLD_LIMITS.maxMembers} people.`);
  }
  const code = newInviteCode();
  const expiresAt = new Date(Date.now() + HOUSEHOLD_LIMITS.inviteDays * 86_400_000).toISOString();
  await db.collection("householdInvites").doc(code).set({
    householdId: household.householdId,
    createdBy: uid,
    createdAt: new Date().toISOString(),
    expiresAt,
    uses: 0,
  });
  return { code, expiresAt };
}

/** Who sent an invite, for the join screen, without joining. */
export async function describeInvite(db: Firestore, code: string): Promise<{ fromName: string; members: number }> {
  const invite = await db.collection("householdInvites").doc(code).get();
  if (!invite.exists) throw new HouseholdError("not-found", "That invite link isn't valid. Ask for a new one.");
  if (Date.parse(invite.get("expiresAt") as string) < Date.now()) {
    throw new HouseholdError("failed-precondition", "That invite link has expired. Ask for a new one.");
  }
  const h = await db.collection("households").doc(invite.get("householdId") as string).get();
  if (!h.exists) throw new HouseholdError("not-found", "That household no longer exists.");
  const names = (h.get("names") as Record<string, string> | undefined) ?? {};
  return { fromName: names[invite.get("createdBy") as string] ?? "", members: ((h.get("members") as string[] | undefined) ?? []).length };
}

/**
 * Joins the household behind an invite code. If the shopper was alone in a household of their own,
 * its unchecked items come along and the old household is removed. If they shared a household
 * with others, they just leave it (the others keep it).
 */
export async function joinHousehold(db: Firestore, uid: string, code: string, name: string): Promise<HouseholdInfo> {
  const inviteRef = db.collection("householdInvites").doc(code);
  const userRef = db.collection("users").doc(uid);
  let carryFrom: string | null = null;
  const joined = await db.runTransaction(async (tx) => {
    const [invite, user] = await Promise.all([tx.get(inviteRef), tx.get(userRef)]);
    if (!invite.exists) throw new HouseholdError("not-found", "That invite link isn't valid. Ask for a new one.");
    if (Date.parse(invite.get("expiresAt") as string) < Date.now()) {
      throw new HouseholdError("failed-precondition", "That invite link has expired. Ask for a new one.");
    }
    const targetId = invite.get("householdId") as string;
    const targetRef = db.collection("households").doc(targetId);
    const target = await tx.get(targetRef);
    if (!target.exists) throw new HouseholdError("not-found", "That household no longer exists.");
    const members = (target.get("members") as string[] | undefined) ?? [];
    const names = { ...((target.get("names") as Record<string, string> | undefined) ?? {}) };
    if (members.includes(uid)) {
      if (user.get("householdId") !== targetId) tx.set(userRef, { householdId: targetId }, { merge: true });
      return info(targetId, members, names);
    }
    if (((invite.get("uses") as number | undefined) ?? 0) >= HOUSEHOLD_LIMITS.usesPerInvite) {
      throw new HouseholdError("resource-exhausted", "That invite link has been used up. Ask for a new one.");
    }
    if (members.length >= HOUSEHOLD_LIMITS.maxMembers) {
      throw new HouseholdError("resource-exhausted", `That household is full (${HOUSEHOLD_LIMITS.maxMembers} people).`);
    }

    // Leave the old household first (reads before writes).
    const oldId = user.get("householdId") as string | undefined;
    if (oldId && oldId !== targetId) {
      const oldRef = db.collection("households").doc(oldId);
      const old = await tx.get(oldRef);
      const oldMembers = ((old.get("members") as string[] | undefined) ?? []).filter((m) => m !== uid);
      if (old.exists && oldMembers.length === 0) carryFrom = oldId;
      else if (old.exists) tx.update(oldRef, { members: oldMembers, [`names.${uid}`]: FieldValue.delete() });
    }

    if (name) names[uid] = name;
    const updated = [...members, uid];
    tx.update(targetRef, { members: updated, ...(name ? { [`names.${uid}`]: name } : {}) });
    tx.update(inviteRef, { uses: FieldValue.increment(1), usedBy: FieldValue.arrayUnion(uid) });
    tx.set(userRef, { householdId: targetId }, { merge: true });
    return info(targetId, updated, names);
  });

  // Bring a solo list's unchecked items along, then remove the old household.
  if (carryFrom) {
    const oldRef = db.collection("households").doc(carryFrom);
    const items = await oldRef.collection("items").where("checked", "==", false).limit(HOUSEHOLD_LIMITS.maxCarriedItems).get();
    const batch = db.batch();
    const newItems = db.collection("households").doc(joined.householdId).collection("items");
    for (const doc of items.docs) batch.set(newItems.doc(), doc.data());
    // The on-hand list comes too, skipping food the new household already has.
    const [onHand, theirs] = await Promise.all([
      oldRef.collection("onHand").limit(HOUSEHOLD_LIMITS.maxCarriedItems).get(),
      db.collection("households").doc(joined.householdId).collection("onHand").select("text").get(),
    ]);
    const key = (t: unknown) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const have = new Set(theirs.docs.map((d) => key(d.get("text"))));
    const newOnHand = db.collection("households").doc(joined.householdId).collection("onHand");
    for (const doc of onHand.docs) {
      if (have.has(key(doc.get("text")))) continue;
      batch.set(newOnHand.doc(), doc.data());
    }
    await batch.commit();
    await db.recursiveDelete(oldRef);
  }
  return joined;
}

/** Leaves the household. The last one out removes it and its list. */
export async function leaveHousehold(db: Firestore, uid: string): Promise<void> {
  const userRef = db.collection("users").doc(uid);
  let removeId: string | null = null;
  await db.runTransaction(async (tx) => {
    const user = await tx.get(userRef);
    const id = user.get("householdId") as string | undefined;
    if (!id) return;
    const ref = db.collection("households").doc(id);
    const h = await tx.get(ref);
    const members = ((h.get("members") as string[] | undefined) ?? []).filter((m) => m !== uid);
    if (h.exists && members.length === 0) removeId = id;
    else if (h.exists) tx.update(ref, { members, [`names.${uid}`]: FieldValue.delete() });
    tx.set(userRef, { householdId: FieldValue.delete() }, { merge: true });
  });
  if (removeId) await db.recursiveDelete(db.collection("households").doc(removeId));
}
