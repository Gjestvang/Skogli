import { store, START, STAKES, PROFILES, DATE, todayOslo, state, vapid, subKey, notifyBet, notifyResult } from "../lib/betting.mjs";

// Betting on the delay log. Bets, profile names and manual results live in
// their own store; the delay entries are read from the log's store so a
// registered delay settles the day automatically.
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

export default async (req) => {
  const s = store();

  if (req.method === "GET") {
    const { bets, res, balances, names } = await state();
    // Guesses stay hidden until the day is settled, so nobody can undercut by one minute.
    const shown = bets.map((b) => (res[b.date] || b.type !== "min" ? b : { ...b, guess: null }));
    const profiles = PROFILES.map((id) => ({ id, name: names[id], balance: balances[id] }));
    const vapidKey = (await vapid(s)).publicKey;
    return json({ profiles, bets: shown, results: res, today: todayOslo(), start: START, stakes: STAKES, vapidKey, needsCode: !!writeCode() });
  }

  // Turning notifications on or off only touches this device, so it needs no write code.
  if (req.method === "POST" && new URL(req.url).searchParams.has("push")) {
    let b;
    try { b = await req.json(); } catch { return json({ error: "Ugyldig data" }, 400); }
    const endpoint = b.sub?.endpoint;
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return json({ error: "Ugyldig abonnement" }, 400);
    if (b.off) await s.delete(subKey(endpoint));
    else {
      if (!PROFILES.includes(b.profile)) return json({ error: "Ukjent profil" }, 400);
      await s.setJSON(subKey(endpoint), { sub: b.sub, profile: b.profile, ts: Date.now() });
    }
    return json({ ok: true });
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
      await notifyResult(s, b.date).catch(() => {});
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
      const stake = STAKES[b.type];
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
      await notifyBet(s, rec, names, !!old).catch(() => {});
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
