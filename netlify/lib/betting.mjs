import { getStore } from "@netlify/blobs";
import webpush from "web-push";
import { createHash } from "node:crypto";

// Shared by the betting and log functions: data, settlement and push notifications.
const store = () => getStore({ name: "betting", consistency: "strong" });
const logStore = () => getStore({ name: "forsinkelser", consistency: "strong" });
const START = 100;
// Fixed price per bet type, so every bet in a pot weighs the same.
const STAKES = { yn: 5, min: 10 };
const PROFILES = ["p1", "p2", "p3"];
const DEFAULT_NAMES = { p1: "Spiller 1", p2: "Spiller 2", p3: "Spiller 3" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const todayOslo = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Oslo" }).format(new Date());

const all = async (s, prefix) => {
  const { blobs } = await s.list(prefix ? { prefix } : undefined);
  return (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
};

// Result per date in minutes (0 = on time). A manual result wins; otherwise
// the day is settled by the delay log as soon as it has an entry.
function results(rounds, log) {
  const r = {};
  for (const e of log) r[e.date] = { min: (r[e.date]?.min || 0) + e.min, source: "logg" };
  for (const x of rounds) r[x.date] = { min: x.min, source: "manuell" };
  return r;
}

// Pool betting: the losers' stakes are shared among the winners in proportion
// to what they staked. If nobody (or everybody) wins, stakes are returned.
function payPool(bets, isWinner) {
  const win = bets.filter(isWinner);
  if (!win.length || win.length === bets.length) return bets.forEach((b) => (b.payout = b.stake));
  const W = win.reduce((s, b) => s + b.stake, 0);
  const L = bets.reduce((s, b) => s + b.stake, 0) - W;
  bets.forEach((b) => (b.payout = isWinner(b) ? b.stake + (b.stake / W) * L : 0));
}

function compute(bets, res) {
  const balances = Object.fromEntries(PROFILES.map((p) => [p, START]));
  const byKey = {};
  for (const b of bets) (byKey[b.date + "|" + b.type] ||= []).push(b);
  for (const [k, group] of Object.entries(byKey)) {
    const r = res[k.split("|")[0]];
    if (!r) { group.forEach((b) => { b.payout = null; balances[b.profile] -= b.stake; }); continue; }
    if (group[0].type === "yn") payPool(group, (b) => b.late === (r.min > 0));
    else {
      const best = Math.min(...group.map((b) => Math.abs(b.guess - r.min)));
      payPool(group, (b) => Math.abs(b.guess - r.min) === best);
    }
    group.forEach((b) => (balances[b.profile] += b.payout - b.stake));
  }
  return balances;
}

async function state() {
  const s = store();
  const [bets, rounds, names, log] = await Promise.all([
    all(s, "bet/"),
    all(s, "round/"),
    s.get("profiles", { type: "json" }),
    all(logStore()),
  ]);
  const res = results(rounds, log);
  const balances = compute(bets, res);
  return { bets, res, balances, names: { ...DEFAULT_NAMES, ...(names || {}) } };
}

// Push keys are made on first use and kept in the store, so no setup is needed in Netlify.
async function vapid(s) {
  let k = await s.get("vapid", { type: "json" });
  if (!k) {
    await s.setJSON("vapid", webpush.generateVAPIDKeys());
    k = await s.get("vapid", { type: "json" }); // re-read so two first visitors agree on one key
  }
  return k;
}

const subKey = (endpoint) => "sub/" + createHash("sha256").update(endpoint).digest("hex").slice(0, 32);

const dayLabel = (d) => (d === todayOslo() ? "i dag" : d.split("-").reverse().slice(0, 2).join("."));

// Send to every subscribed device, optionally skipping one profile. Dead subscriptions are dropped.
async function push(s, msg, exceptProfile) {
  const subs = (await all(s, "sub/")).filter((x) => x.profile !== exceptProfile);
  if (!subs.length) return;
  const k = await vapid(s);
  const payload = JSON.stringify({ url: "/betting.html", ...msg });
  await Promise.allSettled(
    subs.map((x) =>
      webpush
        .sendNotification(x.sub, payload, { vapidDetails: { subject: "https://forsinkelseslogg.netlify.app", ...k }, TTL: 3600 })
        .catch((e) => (e.statusCode === 404 || e.statusCode === 410 ? s.delete(subKey(x.sub.endpoint)) : null))
    )
  );
}

function notifyBet(s, rec, names, changed) {
  const what = rec.type === "yn" ? (rec.late ? "for sent" : "i tide") : "antall minutter";
  return push(s, {
    title: "Bet placed",
    body: `${names[rec.profile]}${changed ? " endret bettet" : ""}: ${what} (${dayLabel(rec.date)}), ${rec.stake} credits`,
    tag: "bet",
  }, rec.profile);
}

// Tell everyone the outcome of a day once it is settled, with each player's net result.
async function notifyResult(s, date) {
  const { bets, res, names } = await state();
  const r = res[date];
  const day = bets.filter((b) => b.date === date);
  if (!r || !day.length) return;
  const net = {};
  for (const b of day) net[b.profile] = (net[b.profile] || 0) + b.payout - b.stake;
  const parts = PROFILES.filter((p) => p in net).map((p) => {
    const n = Math.round(net[p]);
    return `${names[p]} ${n > 0 ? "+" + n : n < 0 ? "−" + -n : "±0"}`;
  });
  return push(s, {
    title: `Resultat ${dayLabel(date)}: ${r.min > 0 ? r.min + " min for sent" : "i tide"}`,
    body: parts.join(" · "),
    tag: "result-" + date,
  });
}

export { store, START, STAKES, PROFILES, DATE, todayOslo, all, state, vapid, subKey, notifyBet, notifyResult };
