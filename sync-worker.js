/* ════════════════════════════════════════════════════════════════════════
   Pikidex — Worker de synchronisation de config entre appareils
   ────────────────────────────────────────────────────────────────────────
   POST  /          body = JSON de config  → stocke et renvoie { "code": "K7P2QX" }  (partage ponctuel)
   PUT   /<CLE>      body = JSON de config  → stocke sous la clé perso (synchro auto)  → { "ok": true }
   GET   /<CODE|CLE>                        → renvoie le JSON stocké (404 si absent)
   POST  /ocr       body = { image, lang, engine } → OCR via OCR.space → { "text": "…" }
   POST  /price     body = { ids: [idProduct…], lang } → cotes Cardmarket par langue

   OCR (scan de cartes) : créer une clé gratuite sur https://ocr.space/ocrapi/freekey,
   puis Worker → Settings → Variables and Secrets → Add → type Secret →
   Name = OCR_KEY, Value = <ta clé> → Deploy.

   PRIX PAR LANGUE : la cote publique (TCGdex) est une moyenne toutes langues.
   Pour obtenir le prix des exemplaires FRANÇAIS, on passe par un service tiers
   interrogé ICI (la clé ne peut pas vivre dans une page statique) :
   Worker → Settings → Variables and Secrets → Add → type Secret →
   Name = CM_KEY, Value = <ta clé> → Deploy.
   Le quota gratuit est petit (100 requêtes/jour) : le cache KV ci-dessous fait
   l'essentiel du travail, et un compteur journalier empêche de le dépasser.
   ⚠ Cette route peut coûter de l'argent au-delà du quota : ajoute AUSSI un secret
   CM_ALLOW_KEY (une phrase au hasard) et renseigne-la dans l'app, sinon /price
   refuse tout. Sans ce garde-fou, n'importe qui pourrait dépenser ton quota.

   Déploiement (tableau de bord Cloudflare, sans CLI) :
   1. Workers & Pages → Create → Worker → nomme-le (ex. pikidex-sync) → Deploy
   2. Edit code → colle ce fichier → Deploy
   3. Storage & Databases → KV → Create a namespace (ex. "pikidex")
   4. Le Worker → Settings → Bindings → Add → KV namespace
        Variable name : CONFIGS        Namespace : pikidex
   5. Deploy. Copie l'URL du Worker (https://pikidex-sync.<sous-domaine>.workers.dev)
      et colle-la dans l'app : Réglages → Importer/exporter → « Service de synchronisation ».
   ════════════════════════════════════════════════════════════════════════ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const KEY_RE = /^[A-Z0-9][A-Z0-9-]{3,39}$/; // clés perso autorisées (4–40 car.)
const TTL = 60 * 60 * 24 * 60;          // 60 jours
const MAX_BYTES = 3 * 1024 * 1024;      // 3 Mo de garde-fou

/* ── Cotes par langue ──────────────────────────────────────────────────── */
const PRICE_TTL   = 60 * 60 * 24 * 7;   // 7 jours en cache : un prix ne bouge pas en une journée
const PRICE_DAILY = 100;                // quota du palier gratuit
const PRICE_BATCH = 40;                 // < 50 sous-requêtes par invocation (plan gratuit Cloudflare)
const PRICE_LANGS = { fr: 'French', en: 'English', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ja: 'Japanese' };

// Code sans caractères ambigus (pas de I, O, 0, 1, L).
function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[buf[i] % chars.length];
  return s;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const code = new URL(request.url).pathname.replace(/^\/+/, '').toUpperCase();

    // POST /ocr → lecture OCR d'une image de carte via OCR.space (clé côté serveur).
    if (request.method === 'POST' && code === 'OCR') {
      if (!env.OCR_KEY) return json({ error: 'OCR non configuré (secret OCR_KEY manquant)' }, 200);
      let payload;
      try { payload = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      if (!payload || !payload.image) return json({ error: 'no image' }, 400);
      try {
        const form = new FormData();
        form.append('apikey', env.OCR_KEY);
        form.append('base64Image', payload.image);   // data:image/jpeg;base64,…
        form.append('OCREngine', String(payload.engine || 2));
        form.append('scale', 'true');
        form.append('detectOrientation', 'true');
        if (payload.lang) form.append('language', payload.lang);
        const r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form });
        const j = await r.json();
        if (j.IsErroredOnProcessing) return json({ error: (j.ErrorMessage && j.ErrorMessage[0]) || 'ocr error' }, 200);
        const text = (j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || '';
        return json({ text }, 200);
      } catch (e) { return json({ error: 'ocr fetch failed' }, 200); }
    }

    // POST /price → cotes par langue, servies d'abord par le cache KV.
    if (request.method === 'POST' && code === 'PRICE') {
      if (!env.CM_KEY) return json({ error: 'prix non configuré (secret CM_KEY manquant)' }, 200);
      let payload;
      try { payload = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      // Cette route dépense un quota facturable au-delà du palier gratuit : elle
      // ne doit pas être ouverte à tout venant. On exige la clé de synchro perso,
      // que seul le propriétaire de l'appli connaît.
      if (!env.CM_ALLOW_KEY || String((payload && payload.key) || '') !== env.CM_ALLOW_KEY) {
        return json({ error: 'non autorisé' }, 403);
      }
      const lang = String((payload && payload.lang) || 'en').toLowerCase();
      if (!PRICE_LANGS[lang]) return json({ error: 'langue non gérée' }, 400);
      const ids = [...new Set(((payload && payload.ids) || [])
        .map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, PRICE_BATCH);
      if (!ids.length) return json({ prices: {}, quotaLeft: null }, 200);

      // Compteur journalier. KV est à cohérence différée : ce compteur est une
      // garde approximative, pas une comptabilité exacte — on vise en dessous.
      const dayKey = 'pxq:' + new Date().toISOString().slice(0, 10);
      let used = parseInt(await env.CONFIGS.get(dayKey), 10) || 0;

      const prices = {};
      const pending = [];
      for (const id of ids) {
        const hit = await env.CONFIGS.get(`cm:${id}:${lang}`);
        if (hit != null) { const v = parseFloat(hit); if (v > 0) prices[id] = v; }
        else pending.push(id);
      }

      for (const id of pending) {
        if (used >= PRICE_DAILY) break;   // quota épuisé : on rendra le reste demain
        used++;
        const v = await fetchLangPrice(env, id, lang);
        if (v == null) continue;
        prices[id] = v;
        await env.CONFIGS.put(`cm:${id}:${lang}`, String(v), { expirationTtl: PRICE_TTL });
      }
      await env.CONFIGS.put(dayKey, String(used), { expirationTtl: 60 * 60 * 48 });

      return json({ prices, quotaLeft: Math.max(0, PRICE_DAILY - used), at: Date.now() }, 200);
    }

    // POST / (sans clé) → partage ponctuel : génère un code aléatoire.
    if (request.method === 'POST') {
      const body = await request.text();
      if (!body) return json({ error: 'empty' }, 400);
      if (body.length > MAX_BYTES) return json({ error: 'too large' }, 413);
      let newCode = genCode();
      // évite l'écrasement très improbable d'un code existant
      for (let i = 0; i < 3 && (await env.CONFIGS.get(newCode)); i++) newCode = genCode();
      await env.CONFIGS.put(newCode, body, { expirationTtl: TTL });
      return json({ code: newCode }, 200);
    }

    // PUT /<clé> → écrit la config sous une clé perso choisie (synchro auto).
    if (request.method === 'PUT' && code) {
      if (!KEY_RE.test(code)) return json({ error: 'bad key' }, 400);
      const body = await request.text();
      if (!body) return json({ error: 'empty' }, 400);
      if (body.length > MAX_BYTES) return json({ error: 'too large' }, 413);
      await env.CONFIGS.put(code, body, { expirationTtl: TTL });
      return json({ ok: true }, 200);
    }

    if (request.method === 'GET' && code) {
      const val = await env.CONFIGS.get(code);
      if (!val) return new Response('not found', { status: 404, headers: CORS });
      return new Response(val, { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response('Pikidex sync OK', { headers: CORS });
  },
};

/* ────────────────────────────────────────────────────────────────────────
   SEUL point de contact avec le fournisseur de cotes. Si son URL, son mode
   d'authentification ou ses noms de champs diffèrent, TOUT se corrige ici.
   Le format exact n'a pas encore été confirmé sur un appel réel : la lecture
   ci-dessous accepte donc plusieurs noms de champs plausibles et renvoie null
   plutôt que d'inventer un prix.
   ──────────────────────────────────────────────────────────────────────── */
async function fetchLangPrice(env, idProduct, lang) {
  // Le service est distribué via RapidAPI : hôte en .p.rapidapi.com et clé dans
  // l'en-tête X-RapidAPI-Key. L'hôte et le chemin sont paramétrables (variables
  // CM_HOST / CM_PATH) pour être ajustés sans redéployer ce fichier : le
  // « playground » RapidAPI donne l'URL exacte une fois l'abonnement pris.
  const host = env.CM_HOST || 'cardmarket-api-tcg.p.rapidapi.com';
  const path = (env.CM_PATH || '/card/{id}').replace('{id}', encodeURIComponent(idProduct));
  const url = `https://${host}${path}`
    + `${path.includes('?') ? '&' : '?'}language=${encodeURIComponent(PRICE_LANGS[lang])}&condition=NM`;
  try {
    const r = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': env.CM_KEY,
        'X-RapidAPI-Host': host,
        'Accept': 'application/json',
      },
    });
    if (!r.ok) return null;
    return pickLangPrice(await r.json(), lang);
  } catch (e) { return null; }
}

// Extraction tolérante : champ dédié à la langue (lowest_near_mint_FR), sinon
// champ générique quand la requête était déjà filtrée par ?language=.
function pickLangPrice(d, lang) {
  if (!d || typeof d !== 'object') return null;
  const src = d.prices && typeof d.prices === 'object' ? d.prices : d;
  const suffix = lang.toUpperCase();
  const candidates = [
    `lowest_near_mint_${suffix}`, `lowest_near_mint`,
    `lowestNearMint${suffix}`,    `lowestNearMint`,
    'lowest', 'low', 'price',
  ];
  for (const k of candidates) {
    const v = num(src[k]);
    if (v != null) return v;
  }
  return null;
}
function num(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  return (typeof n === 'number' && isFinite(n) && n > 0) ? n : null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
