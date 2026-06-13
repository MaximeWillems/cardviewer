/* ════════════════════════════════════════════════════════════════════════
   Pikidex — Worker de synchronisation de config entre appareils
   ────────────────────────────────────────────────────────────────────────
   POST  /          body = JSON de config  → stocke et renvoie { "code": "K7P2QX" }
   GET   /<CODE>                            → renvoie le JSON stocké (404 si absent)

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
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
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
