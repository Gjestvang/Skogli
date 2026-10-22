# Forsinkelseslogg på Netlify

Appen lagrer registreringene i Netlify Blobs via en liten serverfunksjon (`/api/entries`).
Alle som åpner lenken ser de samme dataene, og siden henter nye data hvert 10. sekund.

## Innhold
- `public/index.html` – selve appen
- `netlify/functions/entries.mjs` – serverfunksjonen (lese, legge til, slette)
- `netlify.toml`, `package.json` – oppsett

## Publisere
Dra-og-slipp på app.netlify.com/drop tar ikke med serverfunksjoner, så bruk én av disse:

**A) Via GitHub (enklest å oppdatere senere)**
1. Legg mappen i et GitHub-repo.
2. I Netlify: «Add new project» → «Import an existing project» → velg repoet. Innstillingene leses fra `netlify.toml`.

**B) Via Netlify CLI fra egen maskin**
```
cd netlify-mappen
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

## Skrivekode (anbefalt)
I Netlify: Project configuration → Environment variables → legg til `SKRIVEKODE` med en kode dere velger.
Publiser på nytt etterpå. Da kan alle lese, men bare de som kjenner koden kan legge til og slette.
Koden spørres om første gang og huskes i nettleseren. Uten `SKRIVEKODE` kan alle med lenken skrive.
