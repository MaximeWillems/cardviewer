/* ════════════════════════════════════════════════════════════════════════
   Pikidex — Worker de synchronisation de config entre appareils
   ────────────────────────────────────────────────────────────────────────
   POST  /          body = JSON de config  → stocke et renvoie { "code": "K7P2QX" }  (partage ponctuel)
   PUT   /<CLE>      body = JSON de config  → stocke sous la clé perso (synchro auto)  → { "ok": true }
   GET   /<CODE|CLE>                        → renvoie le JSON stocké (404 si absent)
   POST  /ocr       body = { image, lang, engine } → OCR via OCR.space → { "text": "…" }

   OCR (scan de cartes) : créer une clé gratuite sur https://ocr.space/ocrapi/freekey,
   puis Worker → Settings → Variables and Secrets → Add → type Secret →
   Name = OCR_KEY, Value = <ta clé> → Deploy.

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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
