import { getStore } from "@netlify/blobs";

// Each registration is its own blob (key = id), so two people saving at
// the same time never overwrite each other.
const store = () => getStore({ name: "forsinkelser", consistency: "strong" });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const authorized = (req) => {
  const code = Netlify.env.get("SKRIVEKODE");
  if (!code) return true; // no code set: anyone with the link may write
  return req.headers.get("x-skrivekode") === code;
};

export default async (req) => {
  const s = store();

  if (req.method === "GET") {
    const { blobs } = await s.list();
    const entries = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))).filter(Boolean);
    return json({ entries, needsCode: !!Netlify.env.get("SKRIVEKODE") });
  }

  if (!authorized(req)) return json({ error: "Feil skrivekode" }, 401);

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "Ugyldig data" }, 400); }
    const min = parseInt(b.min, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || !(min >= 1 && min <= 600))
      return json({ error: "Ugyldig dato eller minutter" }, 400);
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const rec = { id, date: b.date, min, note: String(b.note || "").slice(0, 80), ts: Date.now() };
    await s.setJSON(id, rec);
    return json(rec, 201);
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    if (!id || !/^[\w-]{1,40}$/.test(id)) return json({ error: "Mangler id" }, 400);
    await s.delete(id);
    return json({ ok: true });
  }

  return json({ error: "Ikke støttet" }, 405);
};

export const config = { path: "/api/entries" };
