// One-off (user approved Nov 27): give back today's 3 plans that failed with "No current deals".
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
initializeApp();
const db = getFirestore();
(async () => {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const failed = 3;
  const usage = await db.collection("usage").where("day", "==", day).get();
  for (const d of usage.docs) console.log("before", d.id.startsWith("all_") ? d.id : "user_" + day, JSON.stringify({ free: d.get("free"), total: d.get("total") }));
  const mine = usage.docs.filter((d) => !d.id.startsWith("all_") && (d.get("free") ?? 0) > 0);
  if (mine.length !== 1) { console.log(`Not refunding: ${mine.length} shoppers used plans today`); return; }
  const free = mine[0].get("free");
  const back = Math.min(failed, free);
  await mine[0].ref.set({ free: FieldValue.increment(-back) }, { merge: true });
  const all = usage.docs.find((d) => d.id === `all_${day}`);
  if (all) await all.ref.set({ total: FieldValue.increment(-Math.min(back, all.get("total") ?? 0)) }, { merge: true });
  console.log(`Gave back ${back} plan(s): free ${free} -> ${free - back}`);
})().catch((e) => { console.error(e); process.exit(1); });
