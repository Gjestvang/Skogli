import { getStore } from "@netlify/blobs";

// Betting on the delay log. Bets, profile names and manual results live in
// their own store; the delay entries are read from the log's store so a
// registered delay settles the day automatically.
const store = () => getStore({ name: "betting", consistency: "strong" });
const logStore = () => getStore({ name: "forsinkelser", consistency: "strong" });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const writeCode = () =>
  String(globalThis.Netlify?.env?.get("SKRIVEKODE") ?? process.env.SKRIVEKODE ?? "").trim();
const authorized = (req) => {
  const code = writeCode();
  if (!code) return true;
  return (req.headers.get("x-skrivekode") || "").trim() === code;
};

const START = 100;
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

export default async (req) => {
  const s = store();

  if (req.method === "GET") {
    const { bets, res, balances, names } = await state();
    // Guesses stay hidden until the day is settled, so nobody can undercut by one minute.
    const shown = bets.map((b) => (res[b.date] || b.type !== "min" ? b : { ...b, guess: null }));
    const profiles = PROFILES.map((id) => ({ id, name: names[id], balance: balances[id] }));
    return json({ profiles, bets: shown, results: res, today: todayOslo(), start: START, needsCode: !!writeCode() });
  }

  if (!authorized(req)) return json({ error: "Feil skrivekode" }, 401);

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "Ugyldig data" }, 400); }
    const { bets, res, balances, names } = await state();

    if (b.action === "rename") {
      const name = String(b.name || "").trim().slice(0, 20);
      if (!PROFILES.includes(b.profile) || !name) return json({ error: "Ugyldig navn" }, 400);
      await s.setJSON("profiles", { ...names, [b.profile]: name });
      return json({ ok: true });
    }

    if (!DATE.test(b.date || "")) return json({ error: "Ugyldig dato" }, 400);

    if (b.action === "settle") {
      // Only "on time" is set by hand; a delay is settled by registering it in the log.
      if (res[b.date]) return json({ error: "Dagen er allerede avgjort" }, 409);
      if (b.date > todayOslo()) return json({ error: "Dagen har ikke vært ennå" }, 400);
      await s.setJSON("round/" + b.date, { date: b.date, min: 0, ts: Date.now() });
      return json({ ok: true });
    }

    if (b.action === "reopen") {
      await s.delete("round/" + b.date);
      return json({ ok: true });
    }

    if (b.action === "bet") {
      if (!PROFILES.includes(b.profile)) return json({ error: "Ukjent profil" }, 400);
      if (!["yn", "min"].includes(b.type)) return json({ error: "Ukjent bettype" }, 400);
      if (b.date < todayOslo()) return json({ error: "Kan ikke bette på en dag som har vært" }, 400);
      if (res[b.date]) return json({ error: "Dagen er allerede avgjort" }, 409);
      const stake = parseInt(b.stake, 10);
      if (!(stake >= 1)) return json({ error: "Innsatsen må være minst 1" }, 400);
      const key = `bet/${b.date}/${b.profile}/${b.type}`;
      const old = bets.find((x) => x.id === key);
      if (stake > balances[b.profile] + (old ? old.stake : 0))
        return json({ error: "Ikke nok credits" }, 400);
      const rec = { id: key, date: b.date, profile: b.profile, type: b.type, stake, ts: Date.now() };
      if (b.type === "yn") {
        if (typeof b.late !== "boolean") return json({ error: "Velg ja eller nei" }, 400);
        rec.late = b.late;
      } else {
        const guess = parseInt(b.guess, 10);
        if (!(guess >= 0 && guess <= 600)) return json({ error: "Gjett mellom 0 og 600 minutter" }, 400);
        rec.guess = guess;
      }
      await s.setJSON(key, rec);
      return json(rec, 201);
    }

    return json({ error: "Ukjent handling" }, 400);
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id") || "";
    const m = id.match(/^bet\/(\d{4}-\d{2}-\d{2})\/(p[123])\/(yn|min)$/);
    if (!m) return json({ error: "Mangler id" }, 400);
    const { res } = await state();
    if (res[m[1]]) return json({ error: "Dagen er allerede avgjort" }, 409);
    await s.delete(id);
    return json({ ok: true });
  }

  return json({ error: "Ikke støttet" }, 405);
};

export const config = { path: "/api/betting" };
