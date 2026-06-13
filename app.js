'use strict';

/* ════════════════════════════════════════════════════════════════════════
   Pikidex — encyclopédie d'illustrations de cartes Pokémon
   Architecture :
     source de données  →  filterCards()  →  sortByConfig()  →  paintGrid()
   Un seul moteur de filtrage et un seul moteur de rendu, paramétrés par un
   contexte ('explore' | 'collection'). Chaque contexte a son propre état
   dans S[ctx] ; la seule différence est la SOURCE des cartes :
     - explore    : toutes les cartes
     - collection : les cartes marquées (owned | wanted | trade)
   ════════════════════════════════════════════════════════════════════════ */

const API_BASE = 'https://api.tcgdex.net/v2';
const PAGE_SIZE = 24;

// Cache des cartes dans IndexedDB (gros volume → pas le plafond ~5 Mo du
// localStorage). Bump CACHE_VERSION si la logique de récupération change.
const CACHE_VERSION = 4;
const CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 jours

// Types de rareté filtrables (dimension des pastilles). 'promo' n'a pas de
// libellé API : les promos sont récupérées par set, pas par rareté.
const RARITY_KINDS = ['ir', 'sir', 'alt', 'special', 'promo'];

// Libellés de rareté à récupérer via l'API, par langue. Chaque libellé est
// classé dans un type (kind). Ajouter une rareté ici suffit à la faire
// apparaître dans l'app (et dans le filtre via son kind).
const RARITY_LABELS_BY_LANG = {
  fr: [
    { label: 'Illustration rare',          kind: 'ir' },
    { label: 'Illustration spéciale rare', kind: 'sir' },
    { label: 'Ultra Rare',                 kind: 'alt' },
    // ── Cartes chase / spéciales ──────────────────────────────────────────
    { label: 'Hyper rare',                 kind: 'special' },
    { label: 'Méga Hyper Rare',            kind: 'special' },
    { label: 'Chromatique ultra rare',     kind: 'special' },
    { label: 'Shiny rare',                 kind: 'special' },
    { label: 'Shiny rare V',               kind: 'special' },
    { label: 'Shiny rare VMAX',            kind: 'special' },
    { label: 'Radieux Rare',               kind: 'special' },
    { label: 'Magnifique rare',            kind: 'special' },
    { label: 'Magnifique',                 kind: 'special' },
    { label: 'Couronne',                   kind: 'special' },
    { label: 'Dresseur Full Art',          kind: 'special' },
    { label: 'Rare Noir Blanc',            kind: 'special' },
    { label: 'LÉGENDE',                    kind: 'special' },
    { label: 'Collection Classique',       kind: 'special' },
    { label: 'Rare Holo LV.X',             kind: 'special' },
    { label: 'Rare Prime',                 kind: 'special' },
  ],
  en: [
    { label: 'Illustration rare',          kind: 'ir' },
    { label: 'Special illustration rare',  kind: 'sir' },
    { label: 'Ultra Rare',                 kind: 'alt' },
    // ── Cartes chase / spéciales ──────────────────────────────────────────
    { label: 'Hyper rare',                 kind: 'special' },
    { label: 'Mega Hyper Rare',            kind: 'special' },
    { label: 'Shiny Ultra Rare',           kind: 'special' },
    { label: 'Shiny rare',                 kind: 'special' },
    { label: 'Shiny rare V',               kind: 'special' },
    { label: 'Shiny rare VMAX',            kind: 'special' },
    { label: 'Radiant Rare',               kind: 'special' },
    { label: 'Amazing Rare',               kind: 'special' },
    { label: 'Crown',                      kind: 'special' },
    { label: 'Full Art Trainer',           kind: 'special' },
    { label: 'Black White Rare',           kind: 'special' },
    { label: 'Secret Rare',                kind: 'special' },
    { label: 'LEGEND',                     kind: 'special' },
    { label: 'Classic Collection',         kind: 'special' },
    { label: 'Rare Holo LV.X',             kind: 'special' },
    { label: 'Rare PRIME',                 kind: 'special' },
  ],
};

// IDs de sets promos connus dans TCGdex (svp = Scarlet & Violet Promos,
// mep = Méga-Évolution Promos, etc.)
const PROMO_SET_IDS = ['svp', 'swshp', 'smp', 'xyp', 'bwp', 'mep'];

const RARITY_FILTERS = [
  { kind: 'all', label: 'Toutes' },
  { kind: 'ir', label: '✦ AR' },
  { kind: 'sir', label: '✦✦ SAR' },
  { kind: 'alt', label: 'Alt Art' },
  { kind: 'special', label: '◆ Spéciale' },
  { kind: 'promo', label: '★ Promo' },
];

// Filtres de rareté disponibles dans la vue Master Set
// 'trainer' est un pseudo-kind basé sur l'absence de dexId (carte dresseur/énergie)
const MASTER_RARITY_FILTERS = [
  { kind: 'trainer', label: '👤 Dresseur' },
  { kind: 'ir',      label: '✦ AR' },
  { kind: 'sir',     label: '✦✦ SAR' },
  { kind: 'alt',     label: 'Alt Art' },
  { kind: 'special', label: '◆ Spéciale' },
  { kind: 'promo',   label: '★ Promo' },
];

const SORT_FILTERS_HTML = `
  <option value="pokedex">Pokédex</option>
  <option value="name-asc">A → Z</option>
  <option value="name-desc">Z → A</option>
  <option value="set-release">Extension (sortie)</option>
  <option value="set">Extension (A→Z)</option>
  <option value="rarity">Rareté</option>
  <option value="artist-count">Artiste (volume)</option>
  <option value="artist-name">Artiste A → Z</option>
  <optgroup label="── Prix saisis ──">
    <option value="price-asc">Prix ↑</option>
    <option value="price-desc">Prix ↓</option>
  </optgroup>
  <optgroup label="── Prix marché ──">
    <option value="market-asc">Marché ↑</option>
    <option value="market-desc">Marché ↓</option>
  </optgroup>`;

/* ── Persistance (localStorage) ───────────────────────────────────────── */
// Anciennes clés — désormais en LECTURE SEULE, servent à migrer une fois vers
// illusdex_collection (modèle par carte × langue).
const LS_OWNED  = 'illusdex_owned';
const LS_WANTED = 'illusdex_wanted';
const LS_TRADE  = 'illusdex_trade';
const LS_PRICES = 'illusdex_prices';
const LS_PREFS  = 'illusdex_prefs';
const LS_MASTERS = 'illusdex_masters';
const LS_PRESETS = 'illusdex_presets';
const LS_TAGS = 'illusdex_tags';
const LS_COLLECTION = 'illusdex_collection';
const LS_CARDSNAP = 'illusdex_cardsnap';
const LS_BINDER = 'illusdex_binder';

/* ── Collection par (carte × langue) ──────────────────────────────────────
   Source de vérité unique :
     collection[id][lang] = { qty, wanted, trade, paid:{val,min,max}, target:{…} }
   La région (internationale / asiatique) est portée par l'id de la carte ; la
   langue est le seul attribut stocké. ownedSet / wantedSet / tradeSet sont des
   PROJECTIONS « toutes langues confondues » reconstruites à chaque écriture —
   elles gardent tout le code de lecture existant inchangé.
   ──────────────────────────────────────────────────────────────────────── */
let collection = JSON.parse(localStorage.getItem(LS_COLLECTION) || 'null');
if (!collection) collection = migrateLegacyCollection();

let ownedSet  = new Set();
let wantedSet = new Set();
let tradeSet  = new Set();
rebuildProjections();

let startedMasters = JSON.parse(localStorage.getItem(LS_MASTERS) || '[]'); // [{mode,key,label,lang}]
// Compat : les master sets suivis avant la gestion des langues sont en 'fr'.
startedMasters = startedMasters.map(m => (m && m.lang) ? m : { ...m, lang: 'fr' });
let filterPresets  = JSON.parse(localStorage.getItem(LS_PRESETS) || '[]'); // [{id,ctx,name,...}]
let tagsMap        = JSON.parse(localStorage.getItem(LS_TAGS) || '{}');    // { cardId: [tags] }

// Instantanés des cartes possédées/voulues, pour afficher « Ma Collection »
// quel que soit le catalogue chargé (les cartes JP ne sont dans allCards que
// quand le catalogue asiatique est chargé, et inversement).
let cardSnapshots  = JSON.parse(localStorage.getItem(LS_CARDSNAP) || '{}');
function saveCardSnapshots() { localStorage.setItem(LS_CARDSNAP, JSON.stringify(cardSnapshots)); }

// Classeur : pages de 9 emplacements (3×3). slot = { id, lang } ou null.
let binder = JSON.parse(localStorage.getItem(LS_BINDER) || 'null');
if (!binder || !Array.isArray(binder.slots)) binder = { pages: 5, slots: new Array(45).fill(null) };
// Couleur de fond par page (migration depuis l'ancien fond global binder.bg).
if (!Array.isArray(binder.pageBgs)) binder.pageBgs = new Array(binder.pages).fill(binder.bg || null);
while (binder.pageBgs.length < binder.pages) binder.pageBgs.push(null);
let binderPage = 0;
function saveBinder() { localStorage.setItem(LS_BINDER, JSON.stringify(binder)); }
function snapshotCard(c) {
  return {
    id: c.id, image: c.image, altImage: c.altImage, name: c.name, nameEn: c.nameEn, romaji: c.romaji,
    localId: c.localId, rarity: c.rarity, rarityKind: c.rarityKind,
    types: c.types, dexId: c.dexId, illustrator: c.illustrator,
    apiPrice: c.apiPrice, region: c.region,
    set: c.set ? { id: c.set.id, name: c.set.name, order: c.set.order,
                   serie: c.set.serie ? { name: c.set.serie.name } : null } : null,
  };
}
// Met à jour les instantanés pour toutes les cartes de la collection présentes
// dans le catalogue courant. Appelé après chaque chargement de catalogue.
function snapshotCollectionCards() {
  const ids = new Set([...ownedSet, ...wantedSet, ...tradeSet]);
  if (!ids.size) return;
  let changed = false;
  allCards.forEach(c => { if (ids.has(c.id)) { cardSnapshots[c.id] = snapshotCard(c); changed = true; } });
  if (changed) saveCardSnapshots();
}
// Pool de la collection : données vivantes du catalogue courant + instantanés
// pour les cartes des autres régions → la collection est inter-régions.
function getCollectionPool() {
  const ids = new Set([...ownedSet, ...wantedSet, ...tradeSet]);
  const live = new Map(allCards.map(c => [c.id, c]));
  return [...ids].map(id => live.get(id) || cardSnapshots[id]).filter(Boolean);
}

// Construit une collection neuve depuis l'ancien format (tableaux d'ids +
// pricesMap). Tout est rangé en langue 'fr' (collection existante = FR/INT).
function legacyToCollection(owned, wanted, trade, prices) {
  const col = {};
  const lang = 'fr';
  const ensure = id => {
    const byLang = (col[id] || (col[id] = {}));
    return (byLang[lang] || (byLang[lang] = { qty: 0, wanted: false, trade: false, paid: {}, target: {} }));
  };
  (owned  || []).forEach(id => { ensure(id).qty = 1; });
  (wanted || []).forEach(id => { ensure(id).wanted = true; });
  (trade  || []).forEach(id => { ensure(id).trade = true; });
  Object.entries(prices || {}).forEach(([id, p]) => {
    const r = ensure(id);
    if (p && p.owned)  r.paid   = p.owned;
    if (p && p.wanted) r.target = p.wanted;
  });
  return col;
}
function migrateLegacyCollection() {
  const col = legacyToCollection(
    JSON.parse(localStorage.getItem(LS_OWNED)  || '[]'),
    JSON.parse(localStorage.getItem(LS_WANTED) || '[]'),
    JSON.parse(localStorage.getItem(LS_TRADE)  || '[]'),
    JSON.parse(localStorage.getItem(LS_PRICES) || '{}'),
  );
  localStorage.setItem(LS_COLLECTION, JSON.stringify(col));
  return col;
}

const defaultPrefs = {
  pricesVisible: true, sort: 'pokedex', collSort: 'pokedex', lang: 'fr', tab: 'explore',
  theme: 'light',
  listOrder: { type: 'alpha', artist: 'alpha', set: 'release', series: 'release' },
  // masterExcludes : kinds exclus du comptage, PAR master set (clé "mode:key")
  // Stocké comme { "set:sv03.5": [...kinds], "artist:Mitsuhiro Arita": [...kinds] }
  masterExcludes: {},
  syncKey: '',        // clé perso de synchro auto entre appareils (vide = désactivé)
  syncAppliedTs: 0,   // horodatage de la dernière version synchronisée reflétée localement
};
let prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(LS_PREFS) || '{}') };
prefs.listOrder = { ...defaultPrefs.listOrder, ...(prefs.listOrder || {}) };
// Exclusions par master set (compat versions antérieures où c'était global).
if (!prefs.masterExcludes || typeof prefs.masterExcludes !== 'object' || Array.isArray(prefs.masterExcludes)) {
  prefs.masterExcludes = {};
}

// État de synchro (déclaré tôt : les fonctions de sauvegarde ci-dessous déclenchent
// le push auto, et scheduleSyncPush lit syncReady — pas de zone morte au chargement).
let syncBusy = false, syncPushTimer = null, syncReady = false;

function savePrefs()  { localStorage.setItem(LS_PREFS,  JSON.stringify(prefs)); }
function saveCollection() { localStorage.setItem(LS_COLLECTION, JSON.stringify(collection)); scheduleSyncPush(); }
// Conservés comme alias (anciens appelants) — toute la donnée vit dans collection.
function saveOwned()  { saveCollection(); }
function saveWanted() { saveCollection(); }
function saveTrade()  { saveCollection(); }
function savePrices() { saveCollection(); }
function saveTags()   { localStorage.setItem(LS_TAGS,   JSON.stringify(tagsMap)); scheduleSyncPush(); }

/* ── Tags personnalisés par carte ─────────────────────────────────────── */
function getTags(id) { return tagsMap[id] || []; }
function addTag(id, tag) {
  tag = (tag || '').trim();
  if (!tag) return;
  const t = getTags(id);
  if (!t.includes(tag)) { tagsMap[id] = [...t, tag]; saveTags(); }
}
function removeTag(id, tag) {
  const t = getTags(id).filter(x => x !== tag);
  if (t.length) tagsMap[id] = t; else delete tagsMap[id];
  saveTags();
}
function allTags() {
  const s = new Set();
  Object.values(tagsMap).forEach(arr => arr.forEach(t => s.add(t)));
  return [...s].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
}

// Affiche les tags d'une carte dans la modale (chips + suppression) + suggestions.
function renderModalTags(id) {
  const el = document.getElementById('modal-tags');
  if (!el) return;
  const tags = getTags(id);
  el.innerHTML = tags.length
    ? tags.map(t => `<span class="tag-chip">${escapeHtml(t)}<button class="tag-remove" data-tag="${escapeHtml(t)}" aria-label="Retirer le tag">×</button></span>`).join('')
    : '<span class="tags-empty">Aucun tag</span>';
  el.querySelectorAll('.tag-remove').forEach(b => b.addEventListener('click', () => {
    removeTag(id, b.dataset.tag);
    renderModalTags(id);
    onTagsChanged();
  }));
  const dl = document.getElementById('tag-suggestions');
  if (dl) dl.innerHTML = allTags().map(t => `<option value="${escapeHtml(t)}"></option>`).join('');
}

// Après modification des tags : MAJ des menus de filtre + ré-affichage si on filtre par tag.
function onTagsChanged() {
  refreshTagFilters();
  const st = S[currentTab];
  if (st && st.tag && st.tag !== 'all' && (currentTab === 'explore' || currentTab === 'collection')) refresh(currentTab);
}
function saveMasters() { localStorage.setItem(LS_MASTERS, JSON.stringify(startedMasters)); scheduleSyncPush(); }
function savePresetsLS() { localStorage.setItem(LS_PRESETS, JSON.stringify(filterPresets)); scheduleSyncPush(); }

/* ── Régions de catalogue & langues ───────────────────────────────────────
   Le « type de série » (région) définit l'espace d'ids = quelles cartes
   existent ; la langue n'est que le texte affiché. Les langues asiatiques
   partagent les ids japonais (catalogue chargé en Phase 2).
   ──────────────────────────────────────────────────────────────────────── */
const REGIONS = {
  international: { label: 'Internationale', flag: '🌍', langs: ['fr', 'en'] },
  // Asiatique : seul le japonais est exploitable via TCGdex (le filtre de rareté
  // renvoie 0 pour zh-cn/zh-tw/ko). Les ids JP servent de base aux autres langues
  // asiatiques — elles pourront être ajoutées si l'API les supporte un jour.
  asian:        { label: 'Asiatique', flag: '🗾', langs: ['ja'] },
};
const LANG_LABELS = {
  fr: 'Français', en: 'English', de: 'Deutsch', es: 'Español', it: 'Italiano', pt: 'Português',
  ja: '日本語', 'zh-cn': '中文 (简)', 'zh-tw': '中文 (繁)', ko: '한국어',
};
const LANG_FLAGS = {
  fr: '🇫🇷', en: '🇬🇧', de: '🇩🇪', es: '🇪🇸', it: '🇮🇹', pt: '🇵🇹',
  ja: '🇯🇵', 'zh-cn': '🇨🇳', 'zh-tw': '🇹🇼', ko: '🇰🇷',
};
function regionOfLang(lang) {
  return Object.keys(REGIONS).find(r => REGIONS[r].langs.includes(lang)) || 'international';
}

/* ── État global ──────────────────────────────────────────────────────── */
let currentLang = prefs.lang || 'fr';
let currentRegion = prefs.region || regionOfLang(currentLang);
// Garde-fou : la langue doit appartenir à la région courante.
if (!REGIONS[currentRegion] || !REGIONS[currentRegion].langs.includes(currentLang)) {
  currentRegion = 'international';
  currentLang = REGIONS.international.langs[0];
}
let API         = API_BASE + '/' + currentLang;
// Le filtre ?rarity= de TCGdex accepte les libellés anglais quelle que soit la
// langue → on retombe sur l'anglais pour les langues sans table dédiée (ja…).
let RARITY_LABELS = RARITY_LABELS_BY_LANG[currentLang] || RARITY_LABELS_BY_LANG.en;
let pricesVisible = prefs.pricesVisible !== false;
let currentTab    = prefs.tab || 'explore';

let allCards = [];
let filtered = [];   // résultat courant de la vue Explorer (pour pagination + modale)
let displayed = 0;   // nombre de cartes affichées dans Explorer (pagination)

// Mode sélection (collection)
let selectionMode = false;
let selectedIds   = new Set();
let lastClickedId = null;

// Modale
let modalList = [];        // liste sur laquelle naviguent les flèches de la modale
let currentModalIndex = -1;

// Master Set / complétion
let masterMode = 'set';    // 'set' | 'artist'
let masterQuery = '';
let masterSelected = null;  // clé du groupe ouvert en détail (null = liste)
let masterSelectedLang = null; // langue du master ouvert (défini à l'ouverture)
let masterCards = [];       // cartes affichées dans le détail (pour la modale)

function rarityKinds() { return RARITY_KINDS; }

// État de filtre unifié : un objet par contexte. La source des cartes est la
// seule chose qui diffère entre 'explore' et 'collection' (voir getCards).
function makeFilterState(sort) {
  return {
    query: '', rarities: new Set(rarityKinds()), type: 'all', artist: 'all',
    set: 'all', series: 'all', tag: 'all', lang: 'all', dupOnly: false,
    sort: sort || 'pokedex', priceMin: '', priceMax: '', artistCounts: new Map(),
  };
}
const S = {
  explore:    makeFilterState(prefs.sort),
  collection: makeFilterState(prefs.collSort),
};
S.collection.collTab = 'owned'; // 'owned' | 'wanted' | 'trade'
coerceAsianSort(); // si on démarre déjà sur le catalogue asiatique

/* ── Références DOM (assignées dans init) ─────────────────────────────── */
let grid, countEl, loadMoreBtn, errorMsg, sourceLabel, modalOverlay,
    scrollLoader, scrollSentinel;

/* ════════════════════════════════════════════════════════════════════════
   COLLECTION : appartenance + prix
   ════════════════════════════════════════════════════════════════════════ */
/* ── Accès au store collection (par carte × langue) ─────────────────────── */
function collRec(id, lang) { return collection[id] && collection[id][lang]; }
function ensureRec(id, lang) {
  const byLang = (collection[id] || (collection[id] = {}));
  return (byLang[lang] || (byLang[lang] = { qty: 0, wanted: false, trade: false, paid: {}, target: {}, sell: {} }));
}
function hasPriceData(p) { return !!(p && (p.val || p.min || p.max)); }
// Supprime un enregistrement (id,langue) devenu vide pour ne pas laisser de scories.
function pruneRec(id, lang) {
  const r = collRec(id, lang);
  if (!r) return;
  if (!r.qty && !r.wanted && !r.trade && !hasPriceData(r.paid) && !hasPriceData(r.target) && !hasPriceData(r.sell)) {
    delete collection[id][lang];
    if (collection[id] && Object.keys(collection[id]).length === 0) delete collection[id];
  }
}
function isOwned(id, lang)  { return ((collRec(id, lang) || {}).qty || 0) > 0; }
function isWanted(id, lang) { return !!(collRec(id, lang) || {}).wanted; }
function isTrade(id, lang)  { return !!(collRec(id, lang) || {}).trade; }
// Langues dans lesquelles la carte est possédée / voulue / à vendre (pour les drapeaux).
function langsWith(id, flag) {
  const byLang = collection[id];
  if (!byLang) return [];
  return Object.keys(byLang).filter(l => flag === 'qty' ? byLang[l].qty > 0 : byLang[l][flag]);
}
function ownedLangs(id) { return langsWith(id, 'qty'); }
// Langue dans laquelle une carte est mise en vente (pour son prix de vente).
function tradeLangOf(id) { return langsWith(id, 'trade')[0] || currentLang; }
// Langue à utiliser pour LIRE le prix d'une carte selon le type : celle où elle
// est effectivement possédée / voulue / à vendre (sinon le prix d'une carte JP
// ne s'afficherait pas quand on est en catalogue international, et inversement).
function priceLangOf(id, type) {
  const flag = type === 'owned' ? 'qty' : type; // owned↔qty, wanted↔wanted, trade↔trade
  return langsWith(id, flag)[0] || currentLang;
}

// Reconstruit les projections « toutes langues » depuis collection (mutation en place).
function rebuildProjections() {
  ownedSet.clear(); wantedSet.clear(); tradeSet.clear();
  for (const id in collection) {
    const byLang = collection[id];
    for (const lang in byLang) {
      const r = byLang[lang];
      if (r.qty > 0) ownedSet.add(id);
      if (r.wanted)  wantedSet.add(id);
      if (r.trade)   tradeSet.add(id);
    }
  }
}
function afterCollectionChange() { rebuildProjections(); saveCollection(); updateCollStat(); } // saveCollection déclenche le push auto
// Mémorise les données d'affichage d'une carte qu'on vient d'ajouter à la
// collection, pour qu'elle reste visible depuis l'autre catalogue.
function snapshotById(id) {
  const c = allCards.find(x => x.id === id);
  if (c) { cardSnapshots[id] = snapshotCard(c); saveCardSnapshots(); }
}

function toggleOwned(id, lang = currentLang) {
  const r = ensureRec(id, lang);
  r.qty = r.qty > 0 ? 0 : 1;
  if (!r.qty) r.trade = false; // plus possédée → plus à vendre
  pruneRec(id, lang);
  snapshotById(id);
  afterCollectionChange();
}
function toggleWanted(id, lang = currentLang) {
  const r = ensureRec(id, lang);
  r.wanted = !r.wanted;
  pruneRec(id, lang);
  snapshotById(id);
  afterCollectionChange();
}
function toggleTrade(id, lang = currentLang) {
  if (!isOwned(id, lang)) return; // une carte ne peut être à vendre que si possédée (dans cette langue)
  const r = ensureRec(id, lang);
  r.trade = !r.trade;
  pruneRec(id, lang);
  snapshotById(id);
  afterCollectionChange();
}
// Quantité d'exemplaires possédés (par langue).
function qtyOf(id, lang) { return (collRec(id, lang) || {}).qty || 0; }
function totalQty(id) {
  const byLang = collection[id]; if (!byLang) return 0;
  let n = 0; for (const l in byLang) n += byLang[l].qty || 0; return n;
}
function setQty(id, lang, n) {
  n = Math.max(0, n | 0);
  const r = ensureRec(id, lang);
  r.qty = n;
  if (n === 0) r.trade = false; // plus possédée → plus à vendre
  pruneRec(id, lang);
  snapshotById(id);
  afterCollectionChange();
}

// Marque/retire « à obtenir » sans rebuild (utilisé en masse par startMaster).
function setWanted(id, lang, val) {
  const r = ensureRec(id, lang);
  r.wanted = !!val;
  pruneRec(id, lang);
}

// type : 'owned' (prix payé) · 'wanted' (budget cible) · 'trade' (prix de vente)
function priceKeyOf(type) { return type === 'owned' ? 'paid' : type === 'wanted' ? 'target' : 'sell'; }
function setPriceData(cardId, type, data, lang = currentLang) {
  const r = ensureRec(cardId, lang);
  r[priceKeyOf(type)] = data;
  pruneRec(cardId, lang);
  saveCollection();
  const gridCard = document.querySelector(`.card[data-id="${cardId}"]`);
  if (gridCard) updateCardPricePill(gridCard, cardId);
  refreshAfterPriceChange();
}
function getPriceData(cardId, type, lang = currentLang) {
  const r = collRec(cardId, lang);
  const p = r ? r[priceKeyOf(type)] : null;
  return { val: (p && p.val) || '', min: (p && p.min) || '', max: (p && p.max) || '' };
}
function getPriceLabel(cardId, type, lang = currentLang) {
  const d = getPriceData(cardId, type, lang);
  if (d.val) return fmtEur(parseFloat(d.val));
  if (d.min && d.max) return `${fmtEur(parseFloat(d.min))}–${fmtEur(parseFloat(d.max))}`;
  if (d.min) return `≥${fmtEur(parseFloat(d.min))}`;
  if (d.max) return `≤${fmtEur(parseFloat(d.max))}`;
  return '';
}
function updateCardPricePill(el, cardId) {
  const ownedPill  = el.querySelector('.owned-price');
  const wantedPill = el.querySelector('.wanted-price');
  const sellPill   = el.querySelector('.sell-price');
  if (ownedPill)  ownedPill.textContent  = getPriceLabel(cardId, 'owned',  priceLangOf(cardId, 'owned'));
  if (wantedPill) wantedPill.textContent = getPriceLabel(cardId, 'wanted', priceLangOf(cardId, 'wanted'));
  if (sellPill)   sellPill.textContent   = getPriceLabel(cardId, 'trade',  tradeLangOf(cardId));
}

function getBestPrice(cardId) {
  for (const type of ['owned', 'wanted']) {
    const d = getPriceData(cardId, type, priceLangOf(cardId, type)); // langue de possession
    if (d.val && !isNaN(parseFloat(d.val))) return parseFloat(d.val);
    if (d.min && !isNaN(parseFloat(d.min))) return parseFloat(d.min);
  }
  const card = allCards.find(c => c.id === cardId);
  return card?.apiPrice ?? null;
}
// Valeurs utilisées pour le tri : une carte sans prix vaut 0 (elle se range
// donc tout en bas d'un tri décroissant et tout en haut d'un tri croissant).
function getUserPriceValue(card) {
  for (const type of ['owned', 'wanted']) {
    const d = getPriceData(card.id, type, priceLangOf(card.id, type)); // langue de possession
    if (d.val && !isNaN(parseFloat(d.val))) return parseFloat(d.val);
    if (d.min && !isNaN(parseFloat(d.min))) return parseFloat(d.min);
  }
  return 0;
}
function getMarketPriceValue(card) {
  if (card.apiPrice != null && !isNaN(card.apiPrice)) return card.apiPrice;
  return 0;
}

/* ════════════════════════════════════════════════════════════════════════
   MOTEUR DE FILTRAGE (unifié)
   ════════════════════════════════════════════════════════════════════════ */
function matchesRarities(card, rarities) {
  if (rarities.size >= RARITY_KINDS.length) return true; // toutes sélectionnées
  return rarities.has(card.rarityKind);
}

function membershipSet(ctx) {
  if (ctx !== 'collection') return null;
  const t = S.collection.collTab;
  return t === 'owned' ? ownedSet : t === 'wanted' ? wantedSet : tradeSet;
}

/* ── Translittération katakana/hiragana → romaji ──────────────────────────
   Permet de chercher une carte japonaise en alphabet latin (ex. « rizaado »
   pour リザードン). Couvre les noms de Pokémon (kana) ; les kanji (noms de
   dresseurs / d'extensions) ne sont pas convertis (nécessiterait un dico).
   ──────────────────────────────────────────────────────────────────────── */
const KATA_COMBO = {
  'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho',
  'チャ':'cha','チュ':'chu','チョ':'cho','ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
  'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
  'ジャ':'ja','ジュ':'ju','ジョ':'jo','ビャ':'bya','ビュ':'byu','ビョ':'byo',
  'ピャ':'pya','ピュ':'pyu','ピョ':'pyo','ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo',
  'ティ':'ti','ディ':'di','チェ':'che','ジェ':'je','シェ':'she','ヴァ':'va','ヴィ':'vi','ヴェ':'ve','ヴォ':'vo',
};
const KATA_MAP = {
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o','カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so','タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no','ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo','ヤ':'ya','ユ':'yu','ヨ':'yo',
  'ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro','ワ':'wa','ヲ':'wo','ン':'n',
  'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go','ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do','バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
  'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po','ヴ':'vu',
};
function toRomaji(str) {
  if (!str) return '';
  // Hiragana → katakana (décalage de 0x60) pour réutiliser la même table.
  const s = String(str).replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const combo = KATA_COMBO[s.substr(i, 2)];
    if (combo) { out += combo; i++; continue; }
    const ch = s[i];
    if (ch === 'ッ') { // sokuon : double la consonne suivante
      const nr = KATA_COMBO[s.substr(i + 1, 2)] || KATA_MAP[s[i + 1]];
      if (nr) out += nr[0];
      continue;
    }
    if (ch === 'ー') { const last = out[out.length - 1]; if ('aeiou'.includes(last)) out += last; continue; }
    out += KATA_MAP[ch] || ch;
  }
  return out.toLowerCase();
}

/* ── Moteur de correspondance pour le scan ────────────────────────────────
   À partir de signaux lus sur la carte (nom, numéro X, total Y), classe les
   cartes du catalogue chargé par vraisemblance. Renvoie les meilleures pour
   laisser l'utilisateur choisir en cas de doute. 100 % local (hors-ligne).
   ──────────────────────────────────────────────────────────────────────── */
function normalizeForMatch(s) {
  // garde lettres latines, chiffres et caractères japonais (hiragana/katakana/kanji)
  return String(s || '').toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]/g, '');
}
function diceSimilarity(a, b) {
  a = normalizeForMatch(a); b = normalizeForMatch(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const map = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.substr(i, 2); map.set(g, (map.get(g) || 0) + 1); }
  let inter = 0, total = (a.length - 1) + (b.length - 1);
  for (let i = 0; i < b.length - 1; i++) { const g = b.substr(i, 2); const c = map.get(g); if (c > 0) { inter++; map.set(g, c - 1); } }
  return (2 * inter) / total;
}
// Similarité d'un nom lu vs une carte : compare au nom ET au romaji (et au
// romaji du nom lu, si l'OCR a rendu du katakana).
function nameScore(query, card) {
  if (!query) return 0;
  let best = Math.max(diceSimilarity(query, card.name), card.nameEn ? diceSimilarity(query, card.nameEn) : 0);
  if (card.romaji) best = Math.max(best, diceSimilarity(query, card.romaji), diceSimilarity(toRomaji(query), card.romaji));
  return best;
}
function setOfficialCount(card) {
  const cc = card.set && card.set.cardCount;
  return cc ? (cc.official != null ? cc.official : cc.total) : null;
}
const normNum = v => String(v == null ? '' : v).replace(/^0+/, '').toLowerCase();

// signals: { name?, number? (X), total? (Y) }
function findScanCandidates(signals, pool, limit = 8) {
  pool = pool || allCards;
  const X = (signals.number != null && signals.number !== '') ? normNum(signals.number) : null;
  const Y = (signals.total != null && signals.total !== '') ? Number(signals.total) : null;
  const name = signals.name ? String(signals.name).trim() : '';

  // On part des cartes au bon numéro ; si rien et qu'on a un nom, on élargit.
  let base = X != null ? pool.filter(c => normNum(c.localId) === X) : pool;
  if (X != null && name && base.length === 0) base = pool;

  const scored = [];
  for (const c of base) {
    let score = 0;
    if (X != null && normNum(c.localId) === X) score += 5;
    if (Y != null && setOfficialCount(c) === Y) score += 3;
    if (name) score += nameScore(name, c) * 6;
    if (score > 0) scored.push({ card: c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function filterCards(cards, st) {
  const q   = st.query.toLowerCase().trim();
  const min = st.priceMin !== '' ? Number(st.priceMin) : null;
  const max = st.priceMax !== '' ? Number(st.priceMax) : null;

  return cards.filter(c => {
    if (!matchesRarities(c, st.rarities)) return false;
    if (st.type !== 'all' && !(Array.isArray(c.types) && c.types.includes(st.type))) return false;
    if (st.artist !== 'all' && c.illustrator !== st.artist) return false;
    if (st.set !== 'all' && (c.set?.id || '') !== st.set) return false;
    if (st.series !== 'all' && (c.set?.serie?.name || '') !== st.series) return false;
    if (st.tag !== 'all' && !getTags(c.id).includes(st.tag)) return false;
    if (q && !(
      (c.name || '').toLowerCase().includes(q) ||
      (c.romaji && c.romaji.includes(q)) ||
      (c.illustrator || '').toLowerCase().includes(q) ||
      (c.set?.name || '').toLowerCase().includes(q) ||
      (c.set?.serie?.name || '').toLowerCase().includes(q)
    )) return false;
    if (min !== null || max !== null) {
      const price = getBestPrice(c.id);
      if (min !== null && (price == null || price < min)) return false;
      if (max !== null && (price == null || price > max)) return false;
    }
    return true;
  });
}

// Source → filtre → tri. Unique point d'entrée pour les deux vues.
function getCards(ctx) {
  const st = S[ctx];
  // Ma Collection : pool inter-régions (toutes les cartes possédées, quel que
  // soit le catalogue chargé). Explorer : catalogue courant uniquement.
  let cards = ctx === 'collection' ? getCollectionPool() : allCards;
  const ms = membershipSet(ctx);
  if (ms) cards = cards.filter(c => ms.has(c.id));
  // Doublons : ne garder que les cartes possédées en ≥ 2 exemplaires.
  if (ctx === 'collection' && st.dupOnly) cards = cards.filter(c => totalQty(c.id) >= 2);
  return sortByConfig(filterCards(cards, st), st.sort, st.artistCounts);
}

/* ════════════════════════════════════════════════════════════════════════
   TRI + SECTIONS (partagés)
   ════════════════════════════════════════════════════════════════════════ */
// Région d'une carte (l'asiatique est taguée à l'ingestion ; sinon international).
function cardRegionOf(card) { return (card && card.region) === 'asian' ? 'asian' : 'international'; }
// Langue de collection à utiliser pour une carte donnée (utile en collection
// inter-régions : une carte JP s'édite en 'ja' même si on affiche l'international).
function cardLangFor(card) {
  if (cardRegionOf(card) === 'asian') return 'ja';
  return REGIONS.international.langs.includes(currentLang) ? currentLang : 'fr';
}
// Base d'API correspondant à la région de la carte (pour ouvrir une carte d'un
// autre catalogue que celui affiché, depuis la collection inter-régions).
function cardApiBase(card) {
  if (cardRegionOf(card) === 'asian') return API_BASE + '/ja';
  return API_BASE + '/' + (REGIONS.international.langs.includes(currentLang) ? currentLang : 'fr');
}

// Catalogue asiatique : pas de n° Pokédex dans les briefs → tri par extension.
function defaultSort() { return currentRegion === 'asian' ? 'set' : 'pokedex'; }
function coerceAsianSort() {
  if (currentRegion !== 'asian') return;
  ['explore', 'collection'].forEach(ctx => { if (S[ctx].sort === 'pokedex') S[ctx].sort = 'set'; });
}

function getDexNumber(card) {
  return Array.isArray(card.dexId) && card.dexId.length ? Math.min(...card.dexId) : Number.MAX_SAFE_INTEGER;
}
function getSetName(card) { return card.set?.name || ''; }

// Repli d'image pour les cartes sans illustration chez TCGdex (surtout des
// promos : sets smp/mep entiers, etc.). pokemontcg.io a ces visuels et son URL
// est déterministe à partir de l'id TCGdex "setid-localId".
function pokeAltBase(id) {
  const i = String(id).indexOf('-');
  return i < 0 ? null : `https://images.pokemontcg.io/${String(id).slice(0, i)}/${String(id).slice(i + 1)}`;
}
// Renseigne c.altImage sur les cartes internationales sans image TCGdex.
function applyAltImages(cards) {
  if (currentRegion === 'asian') return; // ids JP non mappables sur pokemontcg.io
  cards.forEach(c => { if (!c.image && !c.altImage) { const b = pokeAltBase(c.id); if (b) c.altImage = b; } });
}
// Source d'image unifiée. q : 'low' (grille), 'high' (modale, webp), 'highpng' (3D).
// TCGdex = base + suffixe ; repli pokemontcg.io = URL complète (.png / _hires.png).
function imgSrc(card, q = 'low') {
  if (!card) return '';
  if (card.image) return card.image + (q === 'highpng' ? '/high.png' : q === 'high' ? '/high.webp' : '/low.webp');
  if (card.altImage) return q === 'low' ? card.altImage + '.png' : card.altImage + '_hires.png';
  return '';
}

function sortByConfig(cards, sort, artistCounts = new Map()) {
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
  return [...cards].sort((a, b) => {
    switch (sort) {
      case 'name-asc':     return collator.compare(a.name || '', b.name || '');
      case 'name-desc':    return collator.compare(b.name || '', a.name || '');
      case 'set':          return collator.compare(a.set?.name || '', b.set?.name || '') || collator.compare(a.localId || '', b.localId || '') || collator.compare(a.name || '', b.name || '');
      case 'set-release':  return ((b.set?.order ?? -1) - (a.set?.order ?? -1)) || collator.compare(a.localId || '', b.localId || '') || collator.compare(a.name || '', b.name || '');
      case 'rarity':       return collator.compare(a.rarity || '', b.rarity || '') || getDexNumber(a) - getDexNumber(b) || collator.compare(a.name || '', b.name || '');
      case 'artist-count': return (artistCounts.get(b.illustrator) || 0) - (artistCounts.get(a.illustrator) || 0) || collator.compare(a.illustrator || '', b.illustrator || '') || getDexNumber(a) - getDexNumber(b);
      case 'artist-name':  return collator.compare(a.illustrator || '', b.illustrator || '') || getDexNumber(a) - getDexNumber(b);
      case 'price-asc':    return getUserPriceValue(a) - getUserPriceValue(b) || collator.compare(a.name || '', b.name || '');
      case 'price-desc':   return getUserPriceValue(b) - getUserPriceValue(a) || collator.compare(a.name || '', b.name || '');
      case 'market-asc':   return getMarketPriceValue(a) - getMarketPriceValue(b) || collator.compare(a.name || '', b.name || '');
      case 'market-desc':  return getMarketPriceValue(b) - getMarketPriceValue(a) || collator.compare(a.name || '', b.name || '');
      default:             return getDexNumber(a) - getDexNumber(b) || collator.compare(a.name || '', b.name || '') || collator.compare(a.id || '', b.id || '');
    }
  });
}

function shouldShowSections(sort) {
  return ['pokedex', 'name-asc', 'name-desc', 'set', 'set-release', 'rarity', 'artist-count', 'artist-name'].includes(sort);
}

function priceBucket(v, noneLabel) {
  if (!(v > 0)) return noneLabel; // 0 / sans prix
  if (v < 5)  return '< 5 €';
  if (v < 15) return '5 € – 15 €';
  if (v < 30) return '15 € – 30 €';
  if (v < 60) return '30 € – 60 €';
  return '60 € +';
}

function getSectionKey(card, sort) {
  if (sort === 'artist-count' || sort === 'artist-name') return card.illustrator || 'Artiste inconnu';
  if (sort === 'set' || sort === 'set-release') return getSetName(card) || 'Extension inconnue';
  if (sort === 'rarity') return card.rarity || 'Rareté inconnue';
  if (sort === 'pokedex') {
    const dex = getDexNumber(card);
    return dex === Number.MAX_SAFE_INTEGER ? 'Pokédex inconnu' : `#${String(dex).padStart(4, '0')}`;
  }
  if (sort === 'name-asc' || sort === 'name-desc') {
    const first = (card.name || '#').trim().charAt(0).toUpperCase();
    return first.match(/[A-ZÀ-ÖØ-Ý]/) ? first : '#';
  }
  if (sort === 'price-asc'  || sort === 'price-desc')  return priceBucket(getUserPriceValue(card), 'Sans prix saisi');
  if (sort === 'market-asc' || sort === 'market-desc') return priceBucket(getMarketPriceValue(card), 'Prix non consulté');
  return '';
}

function getSectionLabel(key, sort, list) {
  if (!key) return null;
  const count = list.filter(card => getSectionKey(card, sort) === key).length;
  const suffix = `${count} carte${count > 1 ? 's' : ''}`;
  if (sort === 'pokedex') return { title: `Pokédex ${key}`, count: suffix };
  return { title: key, count: suffix };
}

/* ════════════════════════════════════════════════════════════════════════
   UTILITAIRES
   ════════════════════════════════════════════════════════════════════════ */
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function fmtEur(val) {
  if (val == null || isNaN(val)) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

const TYPE_COLORS = {
  Fire: '#e8654a', Feu: '#e8654a',
  Water: '#4f9fe0', Eau: '#4f9fe0',
  Grass: '#5bb96a', Plante: '#5bb96a',
  Lightning: '#f0c23e', Électrique: '#f0c23e', Electrique: '#f0c23e',
  Psychic: '#b65fc0', Psy: '#b65fc0',
  Fighting: '#c2683e', Combat: '#c2683e',
  Darkness: '#46506a', Obscurité: '#46506a', Obscurite: '#46506a',
  Metal: '#8493a6', Métal: '#8493a6',
  Dragon: '#c79b2a',
  Fairy: '#e286bb', Fée: '#e286bb', Fee: '#e286bb',
  Colorless: '#b3b0aa', Incolore: '#b3b0aa',
};
function typeAccent(types) {
  const t = Array.isArray(types) ? types[0] : types;
  return TYPE_COLORS[t] || 'rgba(var(--fg-rgb),0.32)';
}

// Reconstruit une « carte sans visuel » lisible à partir des métadonnées
// disponibles (nom, numéro, extension, type) plutôt qu'un simple « ? ».
function imagePlaceholder(card, isModal = false) {
  const c = (card && typeof card === 'object') ? card : { name: card };
  const name = (currentLang === 'en' && c.nameEn) ? c.nameEn : (c.name || 'Carte');
  const num     = c.localId != null && c.localId !== '' ? `N° ${escapeHtml(String(c.localId))}` : '';
  const setName = c.set?.name || '';
  const mono    = (String(name).trim()[0] || '?').toUpperCase();
  return `
    <div class="image-placeholder ${isModal ? 'modal-placeholder' : ''}" style="--ph-accent:${typeAccent(c.types)}">
      <div class="ph-head"><span class="ph-num">${num}</span></div>
      <div class="ph-center">
        <div class="placeholder-mark">${escapeHtml(mono)}</div>
        <div class="placeholder-title">${escapeHtml(name)}</div>
      </div>
      <div class="ph-foot">
        ${setName ? `<div class="ph-set">${escapeHtml(setName)}</div>` : ''}
        <div class="placeholder-text">Aucun visuel disponible</div>
      </div>
    </div>`;
}

// pokemontcg.io renvoie un dos de carte générique (exactement 640×892) avec un
// statut 200 quand elle n'a pas le vrai visuel (ex. set MEP). Les vignettes sont
// masquées (CSS img[onload]) tant qu'on n'a pas vérifié : si c'est un dos, on
// affiche notre placeholder (jamais le dos) ; sinon on révèle l'image.
function checkCardBack(img) {
  if (img.naturalWidth === 640 && img.naturalHeight === 892 && /pokemontcg\.io/.test(img.currentSrc || img.src)) {
    handleImageError(img); // dos → placeholder enrichi (l'image masquée n'est jamais montrée)
  } else {
    img.style.opacity = '1'; // vraie image → on révèle
  }
}

function handleImageError(img) {
  const d = img.dataset;
  const card = {
    name: img.alt || 'Carte',
    localId: d.phNum || '',
    set: { name: d.phSet || '' },
    types: d.phType ? [d.phType] : [],
  };
  const isModal = img.classList.contains('modal-img');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = imagePlaceholder(card, isModal).trim();
  img.replaceWith(wrapper.firstElementChild);
}

// Drapeaux des langues dans lesquelles la carte est possédée (visualisation).
function langFlagsHtml(id) {
  const langs = ownedLangs(id);
  if (!langs.length) return '';
  return `<div class="card-langs">${langs.map(l =>
    `<span class="card-lang-flag" title="${escapeHtml(LANG_LABELS[l] || l)}">${LANG_FLAGS[l] || '🏳️'}</span>`
  ).join('')}</div>`;
}
// Badge « ×N » quand on possède plusieurs exemplaires (toutes langues).
function qtyBadgeHtml(id) {
  const n = totalQty(id);
  return n >= 2 ? `<div class="card-qty">×${n}</div>` : '';
}

// Rappel textuel des langues possédées (affiché dans la modale).
function ownedLangsHint(id) {
  const langs = ownedLangs(id);
  if (!langs.length) return '';
  return 'Possédée : ' + langs.map(l => `${LANG_FLAGS[l] || ''} ${LANG_LABELS[l] || l}`).join(' · ');
}

function getBadge(rarity, rarityKind) {
  if (rarityKind === 'promo') return '<span class="card-badge badge-promo">PROMO</span>';
  if (!rarity) return '';
  const r = rarity.toLowerCase();
  if (r.includes('special illustration') || r.includes('illustration spéciale') || r.includes('sar') || r.includes('sir'))
    return '<span class="card-badge badge-sir">SAR</span>';
  if (r.includes('illustration'))
    return '<span class="card-badge badge-ir">AR</span>';
  // ── Raretés chase / spéciales (badge doré, libellé court) ──────────────
  const sp = (txt) => `<span class="card-badge badge-special">${txt}</span>`;
  if (r.includes('noir blanc') || r.includes('black white')) return sp('BW');
  if (r.includes('hyper'))                                    return sp('HR');   // couvre « Méga Hyper Rare »
  if (r.includes('chromatique') || r.includes('shiny'))       return sp('SHINY');
  if (r.includes('radieux') || r.includes('radiant'))         return sp('RAD');
  if (r.includes('magnifique') || r.includes('amazing'))      return sp('AMZ');
  if (r.includes('couronne') || r.includes('crown'))          return sp('CRN');
  if (r.includes('full art'))                                 return sp('FA');
  if (r.includes('légende') || r.includes('legend'))          return sp('LGD');
  if (r.includes('classique') || r.includes('classic'))       return sp('CC');
  if (r.includes('lv.x'))                                     return sp('LV.X');
  if (r.includes('prime'))                                    return sp('PRM');
  if (r.includes('ultra rare'))
    return '<span class="card-badge badge-alt">ALT</span>';
  if (rarityKind === 'special') return sp('SPÉ');
  return '';
}

/* ════════════════════════════════════════════════════════════════════════
   MOTEUR DE RENDU DE GRILLE (unifié)
   buildCardEl construit le balisage d'une carte — identique pour les deux
   vues, à l'exception de la méta (Explorer préfixe le numéro de Pokédex) et
   du comportement au clic.
   ════════════════════════════════════════════════════════════════════════ */
function buildCardEl(c, ctx, idx) {
  const img = imgSrc(c);
  const name = (currentLang === 'en' && c.nameEn) ? c.nameEn : (c.name || '—');

  let meta;
  if (ctx === 'collection') {
    meta = c.set?.name || '';
  } else {
    const dex = getDexNumber(c);
    const prefix = dex === Number.MAX_SAFE_INTEGER ? '' : `#${String(dex).padStart(4, '0')} · `;
    meta = `${prefix}${c.set?.name || c.rarity || ''}`;
  }

  const isOwned    = ownedSet.has(c.id);
  const isWanted   = wantedSet.has(c.id);
  const isTrade    = tradeSet.has(c.id);
  const isSelected = ctx === 'collection' && selectedIds.has(c.id);
  const ownedLabel  = getPriceLabel(c.id, 'owned',  priceLangOf(c.id, 'owned'));
  const wantedLabel = getPriceLabel(c.id, 'wanted', priceLangOf(c.id, 'wanted'));
  const sellLabel   = getPriceLabel(c.id, 'trade',  tradeLangOf(c.id));

  const div = document.createElement('div');
  div.className = 'card'
    + (isOwned ? ' owned' : '') + (isWanted ? ' wanted' : '') + (isTrade ? ' trade' : '')
    + (ctx === 'collection' && selectionMode ? ' selectable' : '')
    + (isSelected ? ' selected' : '');
  div.dataset.id = c.id;
  if (ctx === 'collection') div.dataset.idx = idx;

  div.innerHTML = `
    ${img
      ? `<img class="card-img" src="${img}" alt="${escapeHtml(name)}" loading="lazy" data-ph-num="${escapeHtml(c.localId ?? '')}" data-ph-set="${escapeHtml(c.set?.name ?? '')}" data-ph-type="${escapeHtml((c.types && c.types[0]) ?? '')}" onerror="handleImageError(this)" onload="checkCardBack(this)">`
      : imagePlaceholder(c)}
    ${langFlagsHtml(c.id)}
    ${qtyBadgeHtml(c.id)}
    <div class="card-body">
      ${getBadge(c.rarity, c.rarityKind)}
      <div class="card-price-tag">
        <span class="card-price-pill owned-price">${ownedLabel}</span>
        <span class="card-price-pill wanted-price">${wantedLabel}</span>
        <span class="card-price-pill sell-price">${sellLabel}</span>
      </div>
      <div class="card-name">${escapeHtml(name)}</div>
      <div class="card-meta">${escapeHtml(meta)}</div>
    </div>`;

  div.addEventListener('click', e => onCardClick(e, c, ctx, idx));
  return div;
}

function onCardClick(e, c, ctx, idx) {
  if (ctx === 'collection' && selectionMode) {
    if (e.shiftKey && lastClickedId != null) {
      const list = getCards('collection');
      const lastIdx = list.findIndex(x => x.id === lastClickedId);
      const [from, to] = lastIdx < idx ? [lastIdx, idx] : [idx, lastIdx];
      list.slice(from, to + 1).forEach(x => {
        selectedIds.add(x.id);
        const el = document.querySelector(`#coll-grid .card[data-id="${x.id}"]`);
        if (el) el.classList.add('selected');
      });
    } else {
      const el = e.currentTarget;
      if (selectedIds.has(c.id)) { selectedIds.delete(c.id); el.classList.remove('selected'); }
      else { selectedIds.add(c.id); el.classList.add('selected'); }
      lastClickedId = c.id;
    }
    updateTotalsBar();
    return;
  }
  const list = ctx === 'collection' ? getCards('collection')
             : ctx === 'master'     ? masterCards
             : ctx === 'echange'    ? echangeCards
             : filtered;
  openModal(c, list);
}

// Peint une liste de cartes dans une grille, avec en-têtes de section.
// fullList sert à calculer la section de la carte précédente (utile pour la
// pagination d'Explorer où `cards` n'est qu'une tranche).
function paintGrid(gridEl, cards, ctx, { append = false, startIndex = 0, fullList = null, sections = true } = {}) {
  if (!append) gridEl.innerHTML = '';
  const list = fullList || cards;

  if (cards.length === 0 && !append) {
    if (ctx === 'explore') {
      gridEl.innerHTML = `<div id="empty" style="display:block; grid-column:1/-1; text-align:center; padding:4rem 2rem; color:var(--muted);">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="display:block;margin:0 auto 1rem;opacity:0.3"><circle cx="12" cy="12" r="10"/><path d="M8 15s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>
        Aucune carte trouvée
      </div>`;
    }
    return;
  }

  const sort = S[ctx]?.sort || 'pokedex';
  const showSections = sections && !!S[ctx];
  const frag = document.createDocumentFragment();

  cards.forEach((c, i) => {
    const globalIndex = startIndex + i;
    if (showSections && shouldShowSections(sort)) {
      const key = getSectionKey(c, sort);
      const prevKey = globalIndex > 0 ? getSectionKey(list[globalIndex - 1], sort) : '';
      if (key && key !== prevKey) {
        const section = getSectionLabel(key, sort, list);
        if (section) {
          const heading = document.createElement('div');
          heading.className = 'section-heading';
          heading.innerHTML = `<div class="section-title">${escapeHtml(section.title)}</div><div class="section-count">${escapeHtml(section.count)}</div>`;
          frag.appendChild(heading);
        }
      }
    }
    frag.appendChild(buildCardEl(c, ctx, globalIndex));
  });

  gridEl.appendChild(frag);
}

function showSkeletons(n = 12) {
  grid.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div');
    s.className = 'skeleton';
    s.innerHTML = '<div class="skeleton-img"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div>';
    grid.appendChild(s);
  }
}

/* ── Rendu des deux vues (mêmes moteurs, sources différentes) ──────────── */
function applyFilters() {
  filtered = getCards('explore');
  countEl.textContent = filtered.length;
  updateExplorePriceTotal();
  const slice = filtered.slice(0, PAGE_SIZE);
  displayed = slice.length;
  paintGrid(grid, slice, 'explore', { append: false, startIndex: 0, fullList: filtered });
  loadMoreBtn.style.display = displayed < filtered.length ? 'block' : 'none';
}

function renderCollection() {
  const gridEl = document.getElementById('coll-grid');
  const empty  = document.getElementById('coll-empty');
  if (!gridEl) return;

  const cards = getCards('collection');
  updateTotalsBar();

  if (cards.length === 0) {
    gridEl.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  paintGrid(gridEl, cards, 'collection', { append: false, startIndex: 0, fullList: cards });
}

function refresh(ctx) { ctx === 'collection' ? renderCollection() : applyFilters(); }

/* ════════════════════════════════════════════════════════════════════════
   MASTER SET / COMPLÉTION
   Regroupe toutes les cartes (du périmètre de l'app) par extension ou par
   artiste, et montre la progression possédé/total. Réutilise le moteur de
   grille pour le détail d'un groupe.
   ════════════════════════════════════════════════════════════════════════ */

/* ── Exclusion du comptage, PAR master set ─────────────────────────────────
   Les kinds exclus sont stockés dans prefs.masterExcludes["mode:key"].
   'trainer' est un pseudo-kind : cartes sans dexId (dresseurs, énergies…).
   ──────────────────────────────────────────────────────────────────────── */
function masterKeyOf(mode, key) { return mode + ':' + key; }

function getMasterExcludes(mode, key) {
  return new Set(prefs.masterExcludes[masterKeyOf(mode, key)] || []);
}

function setMasterExcludes(mode, key, kindsSet) {
  const arr = [...kindsSet];
  if (arr.length) prefs.masterExcludes[masterKeyOf(mode, key)] = arr;
  else            delete prefs.masterExcludes[masterKeyOf(mode, key)];
  savePrefs();
}

function isTrainerCard(card) {
  return !(Array.isArray(card.dexId) && card.dexId.length > 0);
}

function masterCardMatchesFilter(card, excludes) {
  if (excludes.has('trainer') && isTrainerCard(card)) return false;
  if (card.rarityKind && excludes.has(card.rarityKind)) return false;
  return true;
}

// Retourne les cartes d'un groupe après application de SES exclusions (par master set).
function masterFilteredCards(cards, mode, key) {
  const excludes = getMasterExcludes(mode, key);
  if (excludes.size === 0) return cards;
  return cards.filter(c => masterCardMatchesFilter(c, excludes));
}

function masterGroups(mode, lang = currentLang) {
  const groups = new Map();
  allCards.forEach(c => {
    const key   = mode === 'set' ? (c.set?.id || '__?') : (c.illustrator || '__?');
    const label = mode === 'set' ? (c.set?.name || 'Extension inconnue') : (c.illustrator || 'Artiste inconnu');
    if (!groups.has(key)) groups.set(key, { key, label, total: 0, owned: 0, cards: [] });
    const g = groups.get(key);
    g.cards.push(c);
  });
  // Recalcule total/owned : possession comptée DANS LA LANGUE du master set.
  groups.forEach(g => {
    const filtered = masterFilteredCards(g.cards, mode, g.key);
    g.total = filtered.length;
    g.owned = filtered.filter(c => isOwned(c.id, lang)).length;
  });
  return [...groups.values()];
}

// ── Suivi des master sets démarrés ────────────────────────────────────
function isMasterStarted(mode, key, lang) {
  return startedMasters.some(m => m.mode === mode && m.key === key && (m.lang || 'fr') === lang);
}

// Démarre un master set DANS UNE LANGUE : marque ses cartes « à obtenir » dans
// cette langue (sauf celles déjà possédées/voulues dans la même langue).
function startMaster(mode, key, label, lang = currentLang) {
  const group = masterGroups(mode, lang).find(g => g.key === key);
  if (!group) return;
  const cards = masterFilteredCards(group.cards, mode, key);
  let added = 0;
  cards.forEach(c => {
    if (!isOwned(c.id, lang) && !isWanted(c.id, lang)) { setWanted(c.id, lang, true); added++; }
  });
  rebuildProjections(); saveCollection();
  if (!isMasterStarted(mode, key, lang)) { startedMasters.push({ mode, key, label, lang }); saveMasters(); }
  updateCollStat();
  showToast(`✓ Master set ${LANG_FLAGS[lang] || ''} démarré — ${added} carte${added > 1 ? 's' : ''} à obtenir`);
}

function stopMaster(mode, key, lang) {
  startedMasters = startedMasters.filter(m => !(m.mode === mode && m.key === key && (m.lang || 'fr') === lang));
  saveMasters();
}

function masterRowHtml(g, extraClass = '', removable = false) {
  const pct = g.total ? Math.round(g.owned / g.total * 100) : 0;
  const done = g.total > 0 && g.owned === g.total;
  const icon = removable ? (g.mode === 'set' ? '📦 ' : '🎨 ') : '';
  const flag = g.lang ? `<span class="master-row-flag" title="${escapeHtml(LANG_LABELS[g.lang] || g.lang)}">${LANG_FLAGS[g.lang] || ''}</span> ` : '';
  const remove = removable ? `<button class="master-remove" data-mode="${escapeHtml(g.mode)}" data-key="${escapeHtml(g.key)}" data-lang="${escapeHtml(g.lang || '')}" title="Retirer du suivi">×</button>` : '';
  return `<div class="master-row${done ? ' done' : ''}${extraClass}" data-mode="${escapeHtml(g.mode || masterMode)}" data-key="${escapeHtml(g.key)}" data-lang="${escapeHtml(g.lang || '')}">
    <div class="master-row-top">
      <span class="master-row-label">${icon}${flag}${escapeHtml(g.label)}</span>
      <span class="master-row-count">${g.owned} / ${g.total}${done ? ' ✓' : ''}</span>
    </div>
    <div class="master-bar-track"><div class="master-bar-fill" style="width:${pct}%"></div></div>
    ${remove}
  </div>`;
}

function openMasterGroup(mode, key, lang = currentLang) {
  masterMode = mode;
  masterSelected = key;
  masterSelectedLang = lang;
  document.querySelectorAll('.master-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === masterMode));
  renderMaster();
}

function renderStartedMasters(el) {
  // On ne montre que les master sets du catalogue courant (les cartes des autres
  // régions ne sont pas chargées → progression incalculable ici).
  const visible = startedMasters.filter(m => regionOfLang(m.lang || 'fr') === currentRegion);
  if (!visible.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const rows = visible.map(m => {
    const lang = m.lang || 'fr';
    const group = masterGroups(m.mode, lang).find(g => g.key === m.key) || { key: m.key, label: m.label, owned: 0, total: 0 };
    return masterRowHtml({ ...group, mode: m.mode, label: m.label, lang }, ' started', true);
  }).join('');
  el.innerHTML = `<div class="master-section-title">★ Mes master sets en cours</div><div class="master-started-grid">${rows}</div>`;

  el.querySelectorAll('.master-row.started').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.master-remove')) return;
      openMasterGroup(row.dataset.mode, row.dataset.key, row.dataset.lang || 'fr');
    });
  });
  el.querySelectorAll('.master-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      stopMaster(btn.dataset.mode, btn.dataset.key, btn.dataset.lang || 'fr');
      renderMaster();
      showToast('Master set retiré du suivi', 'info');
    });
  });
}

function renderMaster() {
  const startedEl = document.getElementById('master-started');
  const listEl = document.getElementById('master-list');
  const detail = document.getElementById('master-detail');
  if (!listEl) return;

  if (masterSelected) { startedEl.style.display = 'none'; renderMasterDetail(); return; }

  detail.style.display = 'none';
  listEl.style.display = '';
  renderStartedMasters(startedEl);

  // L'exclusion du comptage est désormais propre à chaque master set (réglée
  // dans son détail), il n'y a donc plus de filtre global ici.
  let groups = masterGroups(masterMode);
  const q = masterQuery.toLowerCase().trim();
  if (q) groups = groups.filter(g => g.label.toLowerCase().includes(q));
  groups = groups.filter(g => g.total > 0);
  groups.sort((a, b) => (b.owned / b.total) - (a.owned / a.total) || a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));

  if (groups.length === 0) { listEl.innerHTML = '<div class="master-empty">Aucun résultat</div>'; return; }

  listEl.innerHTML = `<div class="master-rows-container">${groups.map(g => masterRowHtml(g)).join('')}</div>`;
  listEl.querySelector('.master-rows-container').querySelectorAll('.master-row').forEach(row => {
    row.addEventListener('click', () => openMasterGroup(masterMode, row.dataset.key));
  });
}

// Hydrate à la volée (dexId) les cartes d'un master set asiatique : les briefs
// JP n'ont pas de dexId → toutes seraient vues comme « Dresseur ». On complète
// depuis /cards/{id} pour que l'exclusion Dresseur soit fiable.
async function ensureMasterCardsHydrated(group) {
  const targets = group.cards.filter(c => !c.detailsLoaded && !(Array.isArray(c.dexId) && c.dexId.length));
  if (!targets.length) return;
  const prog = document.getElementById('master-detail-progress');
  if (prog) prog.innerHTML = '<span class="master-progress-num">Chargement des détails…</span>';
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const c = targets[next++];
      try {
        const res = await fetch(`${API}/cards/${encodeURIComponent(c.id)}`);
        if (res.ok) {
          const d = await res.json();
          Object.assign(c, { dexId: d.dexId, category: d.category,
            illustrator: c.illustrator || d.illustrator, rarity: c.rarity || d.rarity, types: d.types, detailsLoaded: true });
        } else c.detailsLoaded = true;
      } catch (e) { c.detailsLoaded = true; }
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  idbSet(cacheKey(), { cards: allCards, savedAt: Date.now() });
}

// Quand l'exclusion change sur un master set DÉMARRÉ, on réaligne « à obtenir » :
// les cartes désormais exclues sortent, les réincluses (non possédées) rentrent.
function resyncStartedMaster(mode, key, lang) {
  if (!isMasterStarted(mode, key, lang)) return;
  const group = masterGroups(mode, lang).find(g => g.key === key);
  if (!group) return;
  const keep = new Set(masterFilteredCards(group.cards, mode, key).map(c => c.id));
  let changed = false;
  group.cards.forEach(c => {
    if (isOwned(c.id, lang)) return;
    if (!keep.has(c.id) && isWanted(c.id, lang)) { setWanted(c.id, lang, false); changed = true; }
    else if (keep.has(c.id) && !isWanted(c.id, lang)) { setWanted(c.id, lang, true); changed = true; }
  });
  if (changed) { rebuildProjections(); saveCollection(); updateCollStat(); }
}

let masterExcludeOpen = false; // état d'ouverture de la « tag box » d'exclusion

async function renderMasterDetail() {
  const listEl = document.getElementById('master-list');
  const detail = document.getElementById('master-detail');
  const gridEl = document.getElementById('master-grid');

  const lang = masterSelectedLang || currentLang;
  let allGroup = masterGroups(masterMode, lang).find(g => g.key === masterSelected);
  if (!allGroup) { masterSelected = null; renderMaster(); return; }

  listEl.style.display = 'none';
  detail.style.display = '';

  document.getElementById('master-detail-title').innerHTML =
    `<span class="master-detail-flag" title="${escapeHtml(LANG_LABELS[lang] || lang)}">${LANG_FLAGS[lang] || ''}</span> ${escapeHtml(allGroup.label)}`;

  // Sous-titre
  let subtitle = '';
  if (masterMode === 'artist') {
    const sets = [...new Set(allGroup.cards.map(c => c.set?.id).filter(Boolean))];
    const ordered = allGroup.cards.filter(c => c.set?.order != null).sort((a, b) => a.set.order - b.set.order);
    const first = ordered[0]?.set?.name, last = ordered[ordered.length - 1]?.set?.name;
    subtitle = `${sets.length} extension${sets.length > 1 ? 's' : ''}`
      + (first && last && first !== last ? ` · de ${first} à ${last}` : (first ? ` · ${first}` : ''));
  } else {
    const serie = allGroup.cards[0]?.set?.serie?.name;
    if (serie) subtitle = `Série : ${serie}`;
  }
  document.getElementById('master-detail-sub').textContent = subtitle;

  // JP : compléter les dexId avant de calculer l'exclusion Dresseur.
  if (currentRegion === 'asian') {
    await ensureMasterCardsHydrated(allGroup);
    if (masterSelected !== allGroup.key) return; // l'utilisateur a navigué ailleurs
  }

  // Cartes retenues après application des exclusions PROPRES à ce master set.
  const excludes = getMasterExcludes(masterMode, masterSelected);
  const filteredGroupCards = masterFilteredCards(allGroup.cards, masterMode, masterSelected);
  const ownedCount = filteredGroupCards.filter(c => isOwned(c.id, lang)).length;
  const totalCount = filteredGroupCards.length;
  const pct = totalCount ? Math.round(ownedCount / totalCount * 100) : 0;
  const excludedTotal = allGroup.cards.length - filteredGroupCards.length;

  // ── Tag box d'exclusion (multi-sélection compacte) ───────────────────
  // En asiatique, seule l'exclusion « Dresseur » est fiable (rareté non classée).
  const availKinds = currentRegion === 'asian'
    ? MASTER_RARITY_FILTERS.filter(f => f.kind === 'trainer')
    : MASTER_RARITY_FILTERS;
  const countOf = kind => allGroup.cards.filter(c => kind === 'trainer' ? isTrainerCard(c) : c.rarityKind === kind).length;
  const selectedTags = availKinds.filter(f => excludes.has(f.kind));
  const tagsHtml = selectedTags.length
    ? selectedTags.map(f => `<span class="mex-tag">${f.label}</span>`).join('')
    : '<span class="mex-none">Aucune</span>';
  const optsHtml = availKinds.map(({ kind, label }) => {
    const on = excludes.has(kind);
    return `<button type="button" class="mex-opt${on ? ' on' : ''}" data-kind="${escapeHtml(kind)}">
      <span class="mex-check">${on ? '✓' : ''}</span>
      <span class="mex-opt-label">${label}</span>
      <span class="mex-opt-count">${countOf(kind)}</span>
    </button>`;
  }).join('');

  document.getElementById('master-detail-progress').innerHTML = `
    <div class="master-exclude" id="master-exclude">
      <button type="button" class="master-exclude-toggle" id="master-exclude-toggle" aria-expanded="${masterExcludeOpen}">
        <span class="mex-label">Exclure du comptage</span>
        <span class="mex-current">${tagsHtml}</span>
        <span class="mex-caret">▾</span>
      </button>
      <div class="master-exclude-menu" id="master-exclude-menu"${masterExcludeOpen ? '' : ' hidden'}>${optsHtml}</div>
    </div>
    ${excludedTotal > 0 ? `<span class="master-excluded-note">${excludedTotal} carte${excludedTotal > 1 ? 's' : ''} exclue${excludedTotal > 1 ? 's' : ''} du comptage</span>` : ''}
    <span class="master-progress-num">${ownedCount} / ${totalCount}</span> <span class="master-progress-pct">${pct}%</span>
    <div class="master-bar-track" style="margin-top:6px"><div class="master-bar-fill" style="width:${pct}%"></div></div>`;

  // Ouvrir / fermer la tag box (sans re-render).
  const toggleBtn = document.getElementById('master-exclude-toggle');
  const menu = document.getElementById('master-exclude-menu');
  toggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    masterExcludeOpen = !masterExcludeOpen;
    menu.hidden = !masterExcludeOpen;
    toggleBtn.setAttribute('aria-expanded', masterExcludeOpen);
  });
  menu.addEventListener('click', e => e.stopPropagation());
  // Cocher / décocher un type → exclusion propre à ce master set + resync.
  menu.querySelectorAll('.mex-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind;
      const ex = getMasterExcludes(masterMode, masterSelected);
      if (ex.has(kind)) ex.delete(kind); else ex.add(kind);
      setMasterExcludes(masterMode, masterSelected, ex);
      resyncStartedMaster(masterMode, masterSelected, lang);
      masterExcludeOpen = true; // garder la box ouverte pour enchaîner
      renderMasterDetail();
    });
  });

  // Action : démarrer / retirer du suivi (dans la langue du master ouvert)
  const started = isMasterStarted(masterMode, masterSelected, lang);
  const actions = document.getElementById('master-detail-actions');
  actions.innerHTML = started
    ? `<button class="master-start-btn started" id="master-start">✓ En cours — Retirer</button>`
    : `<button class="master-start-btn" id="master-start">+ Démarrer ce master set ${LANG_FLAGS[lang] || ''}</button>`;
  document.getElementById('master-start').onclick = () => {
    if (isMasterStarted(masterMode, masterSelected, lang)) {
      stopMaster(masterMode, masterSelected, lang);
      showToast('Master set retiré du suivi', 'info');
    } else {
      startMaster(masterMode, masterSelected, allGroup.label, lang);
    }
    renderMasterDetail();
  };

  masterCards = sortByConfig(filteredGroupCards, defaultSort());
  paintGrid(gridEl, masterCards, 'master', { sections: false });
}

/* ════════════════════════════════════════════════════════════════════════
   CLASSEUR (pages 3×3 d'emplacements où ranger ses cartes)
   ════════════════════════════════════════════════════════════════════════ */
function lookupCard(id) { return allCards.find(c => c.id === id) || cardSnapshots[id] || null; }
let binderPickSlot = -1; // emplacement en cours d'attribution

// Couleurs communes pour le fond du classeur (thèmes), + blanc cassé et noir cassé.
const BINDER_COLORS = ['#c0392b', '#e67e22', '#f39c12', '#f1c40f', '#7cb342', '#27ae60', '#16a085', '#0aa3c2',
                       '#2980b9', '#3f51b5', '#8e44ad', '#e84393', '#7b2d3a', '#8d6e63', '#607d8b', '#95a5a6',
                       '#ecf0f1', '#2b2b2b'];
function pageBg() { return binder.pageBgs[binderPage] || null; }
function applyBinderBg() {
  const grid = document.getElementById('binder-grid');
  if (grid) grid.style.background = pageBg() || '';
}
function renderBinderPalette() {
  const el = document.getElementById('binder-palette');
  if (!el) return;
  const cur = pageBg();
  el.innerHTML = `<span class="binder-palette-label">Fond de la page ${binderPage + 1} :</span>` + BINDER_COLORS.map(col =>
    `<button class="binder-swatch${cur === col ? ' selected' : ''}" style="background:${col}" data-col="${col}" aria-label="Fond ${col}"></button>`
  ).join('');
  el.querySelectorAll('.binder-swatch').forEach(b => b.addEventListener('click', () => {
    binder.pageBgs[binderPage] = (pageBg() === b.dataset.col) ? null : b.dataset.col; // re-clic = fond neutre
    saveBinder(); renderBinderPalette(); applyBinderBg();
  }));
}

function renderBinder() {
  const grid = document.getElementById('binder-grid');
  const info = document.getElementById('binder-pageinfo');
  if (!grid) return;
  if (binderPage >= binder.pages) binderPage = binder.pages - 1;
  if (binderPage < 0) binderPage = 0;
  if (info) info.textContent = `Page ${binderPage + 1} / ${binder.pages}`;
  renderBinderPalette();
  applyBinderBg();
  grid.innerHTML = '';
  const start = binderPage * 9;
  for (let i = 0; i < 9; i++) grid.appendChild(buildBinderSlot(start + i));
}

function buildBinderSlot(slotIndex) {
  const slot = binder.slots[slotIndex];
  const div = document.createElement('div');
  div.className = 'binder-slot' + (slot ? ' filled' : '');
  if (slot) {
    const c = lookupCard(slot.id);
    const img = imgSrc(c);
    div.innerHTML = `
      ${img ? `<img class="binder-slot-img" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="handleImageError(this)" onload="checkCardBack(this)">` : imagePlaceholder(c || { name: slot.id })}
      ${slot.lang && LANG_FLAGS[slot.lang] ? `<span class="binder-slot-flag">${LANG_FLAGS[slot.lang]}</span>` : ''}
      <button class="binder-slot-remove" title="Retirer">×</button>`;
    div.querySelector('.binder-slot-remove').addEventListener('click', e => {
      e.stopPropagation();
      binder.slots[slotIndex] = null; saveBinder(); renderBinder();
    });
    div.addEventListener('click', () => { if (c) openModal(c, [c], 0); });
  } else {
    div.innerHTML = '<span class="binder-slot-plus">+</span>';
    div.addEventListener('click', () => openBinderPicker(slotIndex));
  }
  return div;
}

function openBinderPicker(slotIndex) {
  binderPickSlot = slotIndex;
  document.getElementById('binder-picker-search').value = '';
  renderBinderPicker('');
  document.getElementById('binder-picker').classList.add('open');
}
function closeBinderPicker() {
  document.getElementById('binder-picker').classList.remove('open');
  binderPickSlot = -1;
}

function renderBinderPicker(query) {
  const grid = document.getElementById('binder-picker-grid');
  if (!grid) return;
  const q = (query || '').toLowerCase().trim();
  let cards = getCollectionPool().filter(c => ownedSet.has(c.id));
  if (q) cards = cards.filter(c =>
    (c.name || '').toLowerCase().includes(q) ||
    (c.romaji && c.romaji.includes(q)) ||
    String(c.localId || '').includes(q));
  cards = sortByConfig(cards, 'set').slice(0, 300);
  if (!cards.length) { grid.innerHTML = '<div class="scan-empty">Aucune carte possédée.</div>'; return; }
  grid.innerHTML = '';
  cards.forEach(c => {
    const lang = ownedLangs(c.id)[0] || currentLang;
    const img = imgSrc(c);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'binder-pick';
    el.innerHTML = `${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="handleImageError(this)" onload="checkCardBack(this)">` : imagePlaceholder(c)}
      <span class="binder-pick-name">${escapeHtml(c.name || '—')}</span>`;
    el.addEventListener('click', () => {
      binder.slots[binderPickSlot] = { id: c.id, lang };
      saveBinder(); closeBinderPicker(); renderBinder();
    });
    grid.appendChild(el);
  });
}

/* ════════════════════════════════════════════════════════════════════════
   TIER LIST (rangées S/A/B/C/D → cartes → export image). En mémoire (pas de
   sauvegarde) ; l'objectif est l'export PNG.
   ════════════════════════════════════════════════════════════════════════ */
const TIER_LABELS = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
let tierlist = {
  tiers: [
    { label: 'S', color: '#c0392b', cards: [] },
    { label: 'A', color: '#e67e22', cards: [] },
    { label: 'B', color: '#f1c40f', cards: [] },
    { label: 'C', color: '#2ecc71', cards: [] },
    { label: 'D', color: '#2980b9', cards: [] },
  ],
};
let tierPickTarget = -1;
let tierPickerSrc = 'owned';

function closeTierMenus() { document.querySelectorAll('.tier-menu').forEach(m => m.remove()); }

function renderTierlist() {
  const root = document.getElementById('tier-rows');
  if (!root) return;
  closeTierMenus();
  root.innerHTML = '';
  tierlist.tiers.forEach((tier, i) => root.appendChild(buildTierRow(tier, i)));
}

function buildTierRow(tier, index) {
  const row = document.createElement('div');
  row.className = 'tier-row';

  const label = document.createElement('div');
  label.className = 'tier-label';
  label.style.background = tier.color;
  label.textContent = tier.label;
  label.title = 'Renommer';
  label.addEventListener('click', () => {
    const v = prompt('Nom de la rangée :', tier.label);
    if (v != null) { tier.label = v.trim() || tier.label; renderTierlist(); }
  });

  const ctrls = document.createElement('div');
  ctrls.className = 'tier-ctrls';
  ctrls.innerHTML = `<button class="tier-ctrl tier-color-btn" title="Couleur">🎨</button>` +
    `<button class="tier-ctrl tier-remove" title="Supprimer la rangée">×</button>`;
  ctrls.querySelector('.tier-color-btn').addEventListener('click', e => { e.stopPropagation(); openTierColorMenu(index, e.currentTarget); });
  ctrls.querySelector('.tier-remove').addEventListener('click', () => {
    if (tierlist.tiers.length <= 1) return;
    tierlist.tiers.splice(index, 1); renderTierlist();
  });

  const left = document.createElement('div');
  left.className = 'tier-left';
  left.appendChild(label); left.appendChild(ctrls);

  const strip = document.createElement('div');
  strip.className = 'tier-strip';
  tier.cards.forEach((slot, ci) => strip.appendChild(buildTierCard(slot, index, ci)));
  const add = document.createElement('button');
  add.className = 'tier-add-card'; add.textContent = '+';
  add.addEventListener('click', () => openTierPicker(index));
  strip.appendChild(add);

  row.appendChild(left);
  row.appendChild(strip);
  return row;
}

function buildTierCard(slot, tierIndex, cardIndex) {
  const c = lookupCard(slot.id);
  const img = imgSrc(c);
  const el = document.createElement('div');
  el.className = 'tier-card';
  el.innerHTML = img
    ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="handleImageError(this)" onload="checkCardBack(this)">`
    : imagePlaceholder(c || { name: slot.id });
  el.addEventListener('click', e => { e.stopPropagation(); openTierCardMenu(tierIndex, cardIndex, el); });
  return el;
}

function openTierCardMenu(tierIndex, cardIndex, anchor) {
  closeTierMenus();
  const menu = document.createElement('div');
  menu.className = 'tier-menu';
  const targets = tierlist.tiers.map((t, i) =>
    i === tierIndex ? '' : `<button class="tm-move" data-to="${i}" style="background:${t.color}">${escapeHtml(t.label)}</button>`
  ).join('');
  menu.innerHTML = `<div class="tm-row">${targets}</div><button class="tm-remove">Retirer</button>`;
  anchor.appendChild(menu);
  menu.querySelectorAll('.tm-move').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const [card] = tierlist.tiers[tierIndex].cards.splice(cardIndex, 1);
    tierlist.tiers[+b.dataset.to].cards.push(card);
    renderTierlist();
  }));
  menu.querySelector('.tm-remove').addEventListener('click', e => {
    e.stopPropagation();
    tierlist.tiers[tierIndex].cards.splice(cardIndex, 1);
    renderTierlist();
  });
}

function openTierColorMenu(tierIndex, anchor) {
  closeTierMenus();
  const menu = document.createElement('div');
  menu.className = 'tier-menu tier-color-menu';
  menu.innerHTML = `<div class="tm-colors">${BINDER_COLORS.map(col => `<button class="tm-color" style="background:${col}" data-col="${col}"></button>`).join('')}</div>`;
  anchor.appendChild(menu);
  menu.querySelectorAll('.tm-color').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    tierlist.tiers[tierIndex].color = b.dataset.col; renderTierlist();
  }));
}
document.addEventListener('click', () => closeTierMenus());
// Fermer la tag box d'exclusion du master set au clic extérieur.
document.addEventListener('click', () => {
  if (!masterExcludeOpen) return;
  masterExcludeOpen = false;
  const menu = document.getElementById('master-exclude-menu');
  const tb = document.getElementById('master-exclude-toggle');
  if (menu) menu.hidden = true;
  if (tb) tb.setAttribute('aria-expanded', 'false');
});

function openTierPicker(tierIndex) {
  tierPickTarget = tierIndex;
  document.getElementById('tier-picker-search').value = '';
  renderTierPicker('');
  document.getElementById('tier-picker').classList.add('open');
}
function closeTierPicker() { document.getElementById('tier-picker').classList.remove('open'); tierPickTarget = -1; }

function renderTierPicker(query) {
  const grid = document.getElementById('tier-picker-grid');
  if (!grid) return;
  const q = (query || '').toLowerCase().trim();
  const set = tierPickerSrc === 'wanted' ? wantedSet : ownedSet;
  let cards = getCollectionPool().filter(c => set.has(c.id));
  if (q) cards = cards.filter(c =>
    (c.name || '').toLowerCase().includes(q) || (c.romaji && c.romaji.includes(q)) || String(c.localId || '').includes(q));
  cards = sortByConfig(cards, 'set').slice(0, 300);
  if (!cards.length) { grid.innerHTML = '<div class="scan-empty">Aucune carte ici.</div>'; return; }
  grid.innerHTML = '';
  cards.forEach(c => {
    const lang = (tierPickerSrc === 'wanted' ? langsWith(c.id, 'wanted')[0] : ownedLangs(c.id)[0]) || currentLang;
    const img = imgSrc(c);
    const el = document.createElement('button'); el.type = 'button'; el.className = 'binder-pick';
    el.innerHTML = `${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="handleImageError(this)" onload="checkCardBack(this)">` : imagePlaceholder(c)}<span class="binder-pick-name">${escapeHtml(c.name || '—')}</span>`;
    el.addEventListener('click', () => {
      if (tierPickTarget >= 0) tierlist.tiers[tierPickTarget].cards.push({ id: c.id, lang });
      closeTierPicker(); renderTierlist();
    });
    grid.appendChild(el);
  });
}

// Export PNG via une popup + html2canvas (même mécanisme que l'export de vue).
function exportTierImage() {
  const rowsHtml = tierlist.tiers.map(t => {
    const cards = t.cards.map(s => {
      const c = lookupCard(s.id);
      const img = c && c.image ? imgSrc(c, 'high') : ''; // pokemontcg.io = pas de CORS → exclu de l'export
      return img ? `<img class="tc" src="${img}" crossorigin="anonymous">` : `<div class="tc tc-none"></div>`;
    }).join('') || '<div class="tempty"></div>';
    return `<div class="trow"><div class="tlbl" style="background:${t.color}">${escapeHtml(t.label)}</div><div class="tstrip">${cards}</div></div>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tier list</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,sans-serif}
  body{background:#0d0d0f;color:#eee;padding:16px}
  .bar{display:flex;gap:10px;margin-bottom:14px;align-items:center}
  .btn{padding:9px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#1e1e24;color:#eee;font-weight:700;cursor:pointer}
  .btn.p{background:#2980b9;border-color:#2980b9;color:#fff}
  #tier-export{background:#16161a;border-radius:10px;padding:8px;width:fit-content;min-width:340px}
  .trow{display:flex;align-items:stretch;gap:6px;margin-bottom:6px}
  .trow:last-child{margin-bottom:0}
  .tlbl{min-width:64px;width:64px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;color:#fff;border-radius:6px;text-shadow:0 1px 2px rgba(0,0,0,.4);word-break:break-word;text-align:center;padding:4px}
  .tstrip{flex:1;display:flex;flex-wrap:wrap;gap:5px;background:#0d0d0f;border-radius:6px;padding:5px;min-height:84px}
  .tc{width:60px;height:84px;object-fit:cover;border-radius:4px;background:#222}
  .tc-none{background:#222}
  .prog{font-size:12px;color:#999}
</style></head><body>
<div class="bar">
  <button class="btn p" id="gen">⬇ Générer le PNG</button>
  <span class="prog" id="prog"></span>
</div>
<div id="tier-export">${rowsHtml}</div>
<script>
document.getElementById('gen').addEventListener('click', async function(){
  var prog=document.getElementById('prog'); prog.textContent='Chargement des images…';
  var imgs=[].slice.call(document.querySelectorAll('#tier-export img'));
  await Promise.all(imgs.map(function(im){return new Promise(function(r){if(im.complete)return r();im.onload=r;im.onerror=r;});}));
  prog.textContent='Rendu…';
  try{
    var node=document.getElementById('tier-export');
    var canvas=await html2canvas(node,{backgroundColor:'#16161a',scale:2,useCORS:true,logging:false});
    var link=document.createElement('a'); link.download='tierlist.png'; link.href=canvas.toDataURL('image/png'); link.click();
    prog.textContent='✓ Image téléchargée';
  }catch(e){prog.textContent='⚠ '+e.message;}
});
<\/script></body></html>`;

  const w = window.open('', '_blank');
  if (!w) { showToast('Autorise les pop-ups pour exporter', 'info'); return; }
  w.document.write(html); w.document.close();
}

/* ════════════════════════════════════════════════════════════════════════
   ÉCHANGE (partage de listes + comparateur)
   App statique → le partage passe par un code copiable (base64) qui encode la
   wishlist + la liste à vendre. Le comparateur croise avec mes propres listes.
   ════════════════════════════════════════════════════════════════════════ */
let echangeCards = [];     // cartes affichées dans les résultats (navigation modale)
let lastFriendData = null; // dernières données comparées (pour rafraîchir)

function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => showToast(msg, 'info')).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    showToast(msg, 'info');
  });
}

function encodeShare(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeShare(str) {
  let s = (str || '').trim();
  const m = s.match(/[#&?]share=([^&\s]+)/); // extrait le code d'un lien éventuel
  if (m) s = m[1];
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(s))));
}

// Liste des paires [id, langue] portant un flag (wanted / trade), pour le partage.
function pairList(flag) {
  const out = [];
  for (const id in collection) {
    const byLang = collection[id];
    for (const lang in byLang) if (byLang[lang][flag]) out.push([id, lang]);
  }
  return out;
}
function buildShareCode() { return encodeShare({ v: 2, w: pairList('wanted'), t: pairList('trade') }); }
function buildShareLink() { return location.origin + location.pathname + '#share=' + buildShareCode(); }

// Convertit une liste reçue en Set de clés "id|langue". Accepte l'ancien format
// (tableau d'ids → langue joker '*', compatible avec les codes v1) et le v2
// (tableau de [id, langue]).
function toPairSet(arr) {
  const s = new Set();
  (arr || []).forEach(item => s.add(Array.isArray(item) ? `${item[0]}|${item[1]}` : `${item}|*`));
  return s;
}

// Tolérant : code base64, lien #share=…, ou JSON d'export complet → { wanted, trade }
function parseFriendData(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  try {
    const d = JSON.parse(raw); // JSON direct (export complet ou {w,t})
    if (Array.isArray(d.wanted) || Array.isArray(d.trade) || Array.isArray(d.w) || Array.isArray(d.t)) {
      return { wanted: toPairSet(d.wanted || d.w), trade: toPairSet(d.trade || d.t) };
    }
  } catch (e) {}
  try {
    const d = decodeShare(raw); // code / lien base64
    return { wanted: toPairSet(d.w || d.wanted), trade: toPairSet(d.t || d.trade) };
  } catch (e) {}
  return null;
}

// Correspondances en tenant compte de la LANGUE : un Dracaufeu FR voulu ne
// matche pas un Dracaufeu JP proposé. '*' (ancien format) matche n'importe quelle langue.
function computeMatches(theirWanted, theirTrade) {
  const theirHas = (set, id, lang) => set.has(`${id}|${lang}`) || set.has(`${id}|*`);
  const matches = (id, myFlag, theirSet) => {
    const byLang = collection[id];
    if (!byLang) return false;
    for (const lang in byLang) {
      const r = byLang[lang];
      const mine = myFlag === 'owned' ? r.qty > 0 : r[myFlag];
      if (mine && theirHas(theirSet, id, lang)) return true;
    }
    return false;
  };
  return {
    give:    allCards.filter(c => matches(c.id, 'trade',  theirWanted)),
    receive: allCards.filter(c => matches(c.id, 'wanted', theirTrade)),
    have:    allCards.filter(c => matches(c.id, 'owned',  theirWanted) && !matches(c.id, 'trade', theirWanted)),
  };
}

function renderEchangeResults(data) {
  lastFriendData = data;
  const { give, receive, have } = computeMatches(data.wanted, data.trade);
  echangeCards = [...give, ...receive, ...have];

  const fill = (gridId, titleId, label, cards) => {
    document.getElementById(titleId).textContent = `${label} (${cards.length})`;
    const grid = document.getElementById(gridId);
    if (cards.length === 0) { grid.innerHTML = '<div class="echange-empty">Aucune carte</div>'; return; }
    paintGrid(grid, sortByConfig(cards, defaultSort()), 'echange', { sections: false });
  };
  fill('echange-give-grid',    'echange-give-title',    'Ce que je peux lui céder', give);
  fill('echange-receive-grid', 'echange-receive-title', 'Ce qu\'il peut me céder', receive);
  fill('echange-have-grid',    'echange-have-title',    'Tu possèdes ce qu\'il cherche (non listé à vendre)', have);
  document.getElementById('echange-results').style.display = 'block';
}

function compareWith(text) {
  const data = parseFriendData(text);
  if (!data) { showToast('⚠ Code d\'échange invalide', 'info'); return; }
  if (!data.wanted.size && !data.trade.size) { showToast('Liste reçue vide', 'info'); }
  renderEchangeResults(data);
}

// Affiche/rafraîchit mon code dans l'onglet Échange (les résultats persistent).
function renderEchange() {
  const codeEl = document.getElementById('echange-code');
  if (codeEl) codeEl.value = buildShareCode();
}

function handleShareLink() {
  const hash = window.location.hash;
  if (!hash.startsWith('#share=')) return;
  setActiveTab('echange');
  const input = document.getElementById('echange-input');
  input.value = hash.slice(7);
  compareWith(input.value);
}

/* ════════════════════════════════════════════════════════════════════════
   CONTRÔLES DE FILTRE (rendus + remplis + câblés de façon unifiée)
   ════════════════════════════════════════════════════════════════════════ */
function renderFilterControls(ctx) {
  const isColl = ctx === 'collection';
  const root = document.getElementById(isColl ? 'collection-controls' : 'explore-controls');
  if (!root) return;

  const st         = S[ctx];
  const prefix     = isColl ? 'coll-' : '';
  const rarityAttr = isColl ? 'data-coll-rarity' : 'data-rarity';
  const searchId   = isColl ? 'coll-search' : 'search';
  const sortId     = isColl ? 'coll-sort' : 'sort';
  const pillsId    = isColl ? ' id="coll-rarity-pills"' : '';
  const searchStyle= isColl ? ' style="padding-top:0.5rem;padding-bottom:0"' : '';
  const wrapStyle  = isColl ? ' style="max-width:100%"' : '';
  const ord        = prefs.listOrder;

  const rarityButtons = RARITY_FILTERS.map(({ kind, label }) => {
    const active = kind === 'all' ? st.rarities.size >= RARITY_KINDS.length : st.rarities.has(kind);
    const cls = active ? (kind === 'all' ? 'active-all' : `active-${kind}`) : '';
    return `<button class="pill ${cls}" ${rarityAttr}="${kind}">${label}</button>`;
  }).join('');

  const cell = (id, label, allLabel, order) => `
    <div class="adv-field">
      <label>${label}</label>
      <span class="filter-cell">
        <select id="${prefix}${id}-filter" aria-label="Filtrer par ${label.toLowerCase()}"><option value="all">${allLabel}</option></select>
        <button class="order-btn" data-order="${order}" title="${orderTitle(ord[order])}">${orderShort(ord[order])}</button>
      </span>
    </div>`;

  root.innerHTML = `
    <div class="search-row"${searchStyle}>
      <div class="search-wrap"${wrapStyle}>
        <input type="text" id="${searchId}" placeholder="Pokémon, artiste ou extension…" autocomplete="off">
      </div>
      <select id="${sortId}" class="sort-select" aria-label="Trier les cartes">
        ${SORT_FILTERS_HTML}
      </select>
      <button type="button" class="filters-toggle" id="${prefix}filters-toggle" aria-expanded="false" title="Afficher / masquer les filtres">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
        Filtres<span class="filters-count" id="${prefix}filters-count" style="display:none"></span>
      </button>
      ${isColl ? '' : `
        <div class="explore-info-box" id="explore-info-box">
          <span class="stat-count" id="count">–</span>
          <span class="stat-label">cartes</span>
          <div class="divider" id="price-divider" style="display:none"></div>
          <span class="explore-price-total" id="explore-price-total"></span>
          <div class="divider"></div>
          <span class="stat-label" id="source-label">via TCGdex</span>
        </div>`}
    </div>
    <div class="pills-row rarity-pills"${pillsId}>
      ${rarityButtons}
    </div>
    <div class="advanced-filters" id="${prefix}advanced">
      <div class="adv-grid">
        ${cell('type', 'Type', 'Tous les types', 'type')}
        ${cell('artist', 'Artiste', 'Tous les artistes', 'artist')}
        ${cell('set', 'Extension', 'Toutes les extensions', 'set')}
        ${cell('series', 'Série', 'Toutes les séries', 'series')}
        <div class="adv-field">
          <label>Tag</label>
          <select id="${prefix}tag-filter" aria-label="Filtrer par tag"><option value="all">Tous les tags</option></select>
        </div>
        ${isColl ? `
        <div class="adv-field price-field">
          <label>Prix (€)</label>
          <div class="adv-price">
            <input type="number" id="price-min-filter" class="price-filter" placeholder="min">
            <input type="number" id="price-max-filter" class="price-filter" placeholder="max">
          </div>
        </div>` : ''}
      </div>
      <div class="adv-footer">
        <div class="presets-row">
          <select id="${prefix}preset-select" aria-label="Filtres enregistrés"><option value="">★ Filtres enregistrés…</option></select>
          <button class="preset-btn" id="${prefix}preset-save">Enregistrer</button>
          <button class="preset-btn" id="${prefix}preset-delete" title="Supprimer le filtre sélectionné">Suppr.</button>
        </div>
        <button class="preset-btn adv-reset" id="${prefix}filters-reset">Réinitialiser</button>
      </div>
    </div>`;
}

// Compte les filtres avancés actifs (hors recherche/rareté/tri) pour le badge.
function updateAdvCount(ctx) {
  const st = S[ctx];
  let n = 0;
  if (st.type !== 'all') n++;
  if (st.artist !== 'all') n++;
  if (st.set !== 'all') n++;
  if (st.series !== 'all') n++;
  if (st.tag !== 'all') n++;
  if (st.priceMin !== '' || st.priceMax !== '') n++;
  const badge = document.getElementById((ctx === 'collection' ? 'coll-' : '') + 'filters-count');
  if (badge) { badge.textContent = n || ''; badge.style.display = n ? '' : 'none'; }
  return n;
}

// Réinitialise tous les filtres d'un contexte (garde le tri).
function resetFilters(ctx) {
  const st = S[ctx];
  const prefix = ctx === 'collection' ? 'coll-' : '';
  st.query = ''; st.rarities = new Set(rarityKinds());
  st.type = 'all'; st.artist = 'all'; st.set = 'all'; st.series = 'all'; st.tag = 'all';
  st.priceMin = ''; st.priceMax = '';
  const s = document.getElementById(ctx === 'collection' ? 'coll-search' : 'search'); if (s) s.value = '';
  ['type-filter', 'artist-filter', 'set-filter', 'series-filter', 'tag-filter'].forEach(id => {
    const el = document.getElementById(prefix + id); if (el) el.value = 'all';
  });
  const mn = document.getElementById('price-min-filter'), mx = document.getElementById('price-max-filter');
  if (mn) mn.value = ''; if (mx) mx.value = '';
  updateRarityButtons(ctx);
  updateAdvCount(ctx);
  refresh(ctx);
  showToast('Filtres réinitialisés', 'info');
}

// Remplit les listes Type / Artiste / Extension / Série / Tri à partir d'un
// jeu de cartes source, en respectant l'ordre choisi (prefs.listOrder).
const LIST_COLLATOR = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

// entries: [{ value, label, text?, count, release? }] — remplit un <select>
// en triant selon `order` ('alpha' | 'count' | 'release') et en conservant
// la sélection courante. Renvoie la valeur sélectionnée.
function fillSelect(el, allLabel, entries, order) {
  if (order === 'count')        entries.sort((a, b) => (b.count - a.count) || LIST_COLLATOR.compare(a.label, b.label));
  else if (order === 'release') entries.sort((a, b) => ((b.release ?? -1) - (a.release ?? -1)) || LIST_COLLATOR.compare(a.label, b.label)); // récent → ancien
  else                          entries.sort((a, b) => LIST_COLLATOR.compare(a.label, b.label));
  const prev = el.value;
  el.innerHTML = `<option value="all">${allLabel}</option>`;
  entries.forEach(e => { const o = document.createElement('option'); o.value = e.value; o.textContent = e.text || e.label; el.appendChild(o); });
  el.value = entries.some(e => e.value === prev) ? prev : 'all';
  return el.value;
}

function populateSelectsForCtx(ctx, sourceCards) {
  const st = S[ctx];
  const prefix = ctx === 'collection' ? 'coll-' : '';
  const ord = prefs.listOrder;

  // Types
  const typeEl = document.getElementById(prefix + 'type-filter');
  if (typeEl) {
    const counts = new Map();
    sourceCards.forEach(c => (Array.isArray(c.types) ? c.types : []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
    const entries = [...counts.entries()].map(([t, n]) => ({ value: t, label: t, text: `${t} (${n})`, count: n }));
    st.type = fillSelect(typeEl, 'Tous les types', entries, ord.type);
  }

  // Artistes
  const artistEl = document.getElementById(prefix + 'artist-filter');
  if (artistEl) {
    const counts = new Map();
    sourceCards.forEach(c => { if (c.illustrator) counts.set(c.illustrator, (counts.get(c.illustrator) || 0) + 1); });
    const entries = [...counts.entries()].map(([a, n]) => ({ value: a, label: a, text: `${a} (${n})`, count: n }));
    st.artist = fillSelect(artistEl, 'Tous les artistes', entries, ord.artist);
    st.artistCounts = counts;
  }

  // Extensions (valeur = set.id, release = index de sortie)
  const setEl = document.getElementById(prefix + 'set-filter');
  if (setEl) {
    const seen = new Map();
    sourceCards.forEach(c => {
      const id = c.set?.id; if (!id) return;
      if (!seen.has(id)) seen.set(id, { value: id, label: c.set?.name || id, count: 0, release: c.set?.order });
      seen.get(id).count++;
    });
    st.set = fillSelect(setEl, 'Toutes les extensions', [...seen.values()], ord.set);
  }

  // Séries (release = plus petite position de set de la série)
  const seriesEl = document.getElementById(prefix + 'series-filter');
  if (seriesEl) {
    const seen = new Map();
    sourceCards.forEach(c => {
      const name = c.set?.serie?.name; if (!name) return;
      if (!seen.has(name)) seen.set(name, { value: name, label: name, count: 0, release: c.set?.order });
      const e = seen.get(name); e.count++;
      if (c.set?.order != null && (e.release == null || c.set.order < e.release)) e.release = c.set.order;
    });
    st.series = fillSelect(seriesEl, 'Toutes les séries', [...seen.values()], ord.series);
  }

  populateTagSelect(ctx);

  const sortEl = document.getElementById(prefix ? 'coll-sort' : 'sort');
  if (sortEl) sortEl.value = st.sort;

  updateAdvCount(ctx);
}

// Menu « Tag » alimenté par tous les tags existants (global, indépendant des cartes affichées).
function populateTagSelect(ctx) {
  const prefix = ctx === 'collection' ? 'coll-' : '';
  const el = document.getElementById(prefix + 'tag-filter');
  if (!el) return;
  const prev = el.value;
  const tags = allTags();
  el.innerHTML = '<option value="all">Tous les tags</option>'
    + tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  el.value = tags.includes(prev) ? prev : 'all';
  S[ctx].tag = el.value;
}

function refreshTagFilters() {
  populateTagSelect('explore');
  populateTagSelect('collection');
}

/* ── Ordre des listes (boutons à côté des menus) ──────────────────────── */
const LIST_ORDERS = { type: ['alpha', 'count'], artist: ['alpha', 'count'], set: ['release', 'alpha'], series: ['release', 'alpha'] };
function orderShort(order) { return order === 'count' ? 'Nb' : order === 'release' ? '⏱' : 'A‑Z'; }
function orderTitle(order) {
  return order === 'count'   ? 'Ordre : nombre de cartes (cliquer pour changer)'
       : order === 'release' ? 'Ordre : date de sortie (cliquer pour changer)'
       :                       'Ordre : alphabétique (cliquer pour changer)';
}
function updateOrderButtons() {
  document.querySelectorAll('.order-btn').forEach(btn => {
    const o = prefs.listOrder[btn.dataset.order];
    btn.textContent = orderShort(o);
    btn.title = orderTitle(o);
  });
}
function cycleListOrder(list) {
  const opts = LIST_ORDERS[list];
  prefs.listOrder[list] = opts[(opts.indexOf(prefs.listOrder[list]) + 1) % opts.length];
  savePrefs();
  populateFilters('explore');
  populateFilters('collection');
  updateOrderButtons();
}

// Le "monde" d'un contexte : Explorer = toutes les cartes ;
// Collection = les cartes de l'onglet courant (owned | wanted | trade).
function populateFilters(ctx) {
  if (ctx === 'collection') {
    const ms = membershipSet('collection');
    populateSelectsForCtx('collection', getCollectionPool().filter(c => ms.has(c.id)));
  } else {
    populateSelectsForCtx('explore', allCards);
  }
}

function updateRarityButtons(ctx) {
  const isColl = ctx === 'collection';
  const attr = isColl ? 'data-coll-rarity' : 'data-rarity';
  const key  = isColl ? 'collRarity' : 'rarity';
  const sel  = S[ctx].rarities;
  document.querySelectorAll(`[${attr}]`).forEach(btn => {
    const r = btn.dataset[key];
    btn.className = 'pill';
    if (r === 'all' && sel.size >= RARITY_KINDS.length) btn.classList.add('active-all');
    if (r !== 'all' && sel.has(r)) btn.classList.add(`active-${r}`);
  });
}

/* ── Filtres enregistrés (presets) ────────────────────────────────────── */
function buildPresetFromState(ctx) {
  const st = S[ctx];
  return {
    query: st.query, rarities: [...st.rarities], type: st.type, artist: st.artist,
    set: st.set, series: st.series, tag: st.tag, sort: st.sort, priceMin: st.priceMin, priceMax: st.priceMax,
    collTab: ctx === 'collection' ? st.collTab : null,
  };
}

function populatePresetSelect(ctx) {
  const prefix = ctx === 'collection' ? 'coll-' : '';
  const sel = document.getElementById(prefix + 'preset-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">★ Filtres enregistrés…</option>';
  filterPresets.filter(p => p.ctx === ctx).forEach(p => {
    const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
  });
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : '';
}

function savePreset(ctx, name) {
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  filterPresets.push({ id, ctx, name, ...buildPresetFromState(ctx) });
  savePresetsLS();
  populatePresetSelect(ctx);
  const sel = document.getElementById((ctx === 'collection' ? 'coll-' : '') + 'preset-select');
  if (sel) sel.value = id;
  showToast('★ Filtre enregistré');
}

function deletePreset(ctx, id) {
  if (!id) return;
  filterPresets = filterPresets.filter(p => p.id !== id);
  savePresetsLS();
  populatePresetSelect(ctx);
  showToast('Filtre supprimé', 'info');
}

// Applique un preset : met à jour l'état ET les contrôles, puis ré-affiche.
function applyPreset(ctx, p) {
  const st = S[ctx];
  if (ctx === 'collection' && p.collTab && p.collTab !== st.collTab) {
    st.collTab = p.collTab;
    document.querySelectorAll('.coll-tab-btn').forEach(b => b.classList.toggle(`active-${b.dataset.coll}`, b.dataset.coll === st.collTab));
    selectedIds.clear(); lastClickedId = null;
  }
  st.query    = p.query || '';
  st.sort     = p.sort || 'pokedex';
  st.priceMin = p.priceMin || '';
  st.priceMax = p.priceMax || '';
  st.rarities = new Set((p.rarities && p.rarities.length) ? p.rarities : rarityKinds());

  const search = document.getElementById(ctx === 'collection' ? 'coll-search' : 'search');
  if (search) search.value = st.query;
  updateRarityButtons(ctx);

  // Repeuple les listes pour l'univers courant, puis applique les valeurs du
  // preset (en retombant sur « all » si une valeur n'existe pas ici).
  populateFilters(ctx);
  const prefix = ctx === 'collection' ? 'coll-' : '';
  const setSel = (id, v) => { const el = document.getElementById(id); if (!el) return 'all'; const ok = [...el.options].some(o => o.value === v); el.value = ok ? v : 'all'; return el.value; };
  st.type   = setSel(prefix + 'type-filter', p.type || 'all');
  st.artist = setSel(prefix + 'artist-filter', p.artist || 'all');
  st.set    = setSel(prefix + 'set-filter', p.set || 'all');
  st.series = setSel(prefix + 'series-filter', p.series || 'all');
  st.tag    = setSel(prefix + 'tag-filter', p.tag || 'all');
  const sortEl = document.getElementById(ctx === 'collection' ? 'coll-sort' : 'sort');
  if (sortEl) sortEl.value = st.sort;
  if (ctx === 'collection') {
    const mn = document.getElementById('price-min-filter'), mx = document.getElementById('price-max-filter');
    if (mn) mn.value = st.priceMin;
    if (mx) mx.value = st.priceMax;
    updateCollStat();
  }
  refresh(ctx);
}

function wireFilters(ctx) {
  const isColl     = ctx === 'collection';
  const prefix     = isColl ? 'coll-' : '';
  const rarityAttr = isColl ? 'data-coll-rarity' : 'data-rarity';
  const dataKey    = isColl ? 'collRarity' : 'rarity';
  const st         = S[ctx];
  const apply      = () => { refresh(ctx); updateAdvCount(ctx); };

  // Bouton « Filtres » : ouvrir/fermer le panneau avancé
  const toggle = document.getElementById(prefix + 'filters-toggle');
  const panel  = document.getElementById(prefix + 'advanced');
  if (toggle && panel) toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    toggle.classList.toggle('active', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  const resetBtn = document.getElementById(prefix + 'filters-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => resetFilters(ctx));

  const searchEl = document.getElementById(isColl ? 'coll-search' : 'search');
  if (searchEl) searchEl.addEventListener('input', e => { st.query = e.target.value; apply(); });

  document.querySelectorAll(`[${rarityAttr}]`).forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset[dataKey];
      if (val === 'all') {
        st.rarities = new Set(rarityKinds());
      } else if (st.rarities.has(val)) {
        st.rarities.delete(val);
        if (st.rarities.size === 0) st.rarities.add(val); // jamais zéro
      } else {
        st.rarities.add(val);
      }
      updateRarityButtons(ctx);
      apply();
    });
  });

  const typeEl = document.getElementById(prefix + 'type-filter');
  if (typeEl) typeEl.addEventListener('change', e => { st.type = e.target.value; apply(); });

  const artistEl = document.getElementById(prefix + 'artist-filter');
  if (artistEl) artistEl.addEventListener('change', e => { st.artist = e.target.value; apply(); });

  const setEl = document.getElementById(prefix + 'set-filter');
  if (setEl) setEl.addEventListener('change', e => { st.set = e.target.value; apply(); });

  const seriesEl = document.getElementById(prefix + 'series-filter');
  if (seriesEl) seriesEl.addEventListener('change', e => { st.series = e.target.value; apply(); });

  const tagEl = document.getElementById(prefix + 'tag-filter');
  if (tagEl) tagEl.addEventListener('change', e => { st.tag = e.target.value; apply(); });

  const sortEl = document.getElementById(isColl ? 'coll-sort' : 'sort');
  if (sortEl) {
    sortEl.value = st.sort;
    sortEl.addEventListener('change', e => {
      st.sort = e.target.value;
      if (isColl) prefs.collSort = st.sort; else prefs.sort = st.sort;
      savePrefs();
      apply();
    });
  }

  if (isColl) {
    const minEl = document.getElementById('price-min-filter');
    const maxEl = document.getElementById('price-max-filter');
    if (minEl) minEl.addEventListener('input', e => { st.priceMin = e.target.value.trim(); apply(); });
    if (maxEl) maxEl.addEventListener('input', e => { st.priceMax = e.target.value.trim(); apply(); });
  }

  // Filtres enregistrés
  const presetSel = document.getElementById(prefix + 'preset-select');
  if (presetSel) presetSel.addEventListener('change', e => {
    const p = filterPresets.find(x => x.id === e.target.value);
    if (p) applyPreset(ctx, p);
  });
  const presetSave = document.getElementById(prefix + 'preset-save');
  if (presetSave) presetSave.addEventListener('click', () => {
    const name = (window.prompt('Nom du filtre enregistré :') || '').trim();
    if (name) savePreset(ctx, name);
  });
  const presetDel = document.getElementById(prefix + 'preset-delete');
  if (presetDel) presetDel.addEventListener('click', () => {
    if (presetSel && presetSel.value) deletePreset(ctx, presetSel.value);
    else showToast('Sélectionne un filtre à supprimer', 'info');
  });
}

/* ════════════════════════════════════════════════════════════════════════
   TOTAUX (collection) + total prix (explore)
   ════════════════════════════════════════════════════════════════════════ */
// Reflète la visibilité des prix : variable d'affichage + classe globale
// (pour masquer le filtre prix quand les prix sont cachés).
function applyPricesVisible() {
  document.documentElement.style.setProperty('--prices-display', pricesVisible ? '' : 'none');
  document.documentElement.classList.toggle('prices-on', pricesVisible);
}

function updateCollStat() {
  document.querySelectorAll('.coll-tab-btn').forEach(btn => {
    const t = btn.dataset.coll;
    btn.classList.toggle(`active-${t}`, S.collection.collTab === t);
  });
  const pb = document.getElementById('btn-hide-prices');
  if (pb) pb.classList.toggle('active', pricesVisible);
  // « Partager la liste » : seulement sur l'onglet À vendre, avec des cartes.
  const shareBtn = document.getElementById('btn-share-sell');
  if (shareBtn) shareBtn.style.display = (S.collection.collTab === 'trade' && tradeSet.size > 0) ? '' : 'none';
  // « Doublons » : seulement sur l'onglet possédé.
  const dupBtn = document.getElementById('btn-dup-only');
  if (dupBtn) {
    dupBtn.style.display = S.collection.collTab === 'owned' ? '' : 'none';
    dupBtn.classList.toggle('active', !!S.collection.dupOnly);
  }
  applyPricesVisible();
}

function computeTotal(ids) {
  let sum = 0, known = 0, unknown = 0;
  ids.forEach(id => {
    const v = getBestPrice(id);
    if (v != null) { sum += v; known++; } else unknown++;
  });
  return { sum, known, unknown, total: ids.size ?? ids.length };
}

function updateTotalsBar() {
  const countEl = document.getElementById('coll-info-count');
  const priceEl = document.getElementById('coll-info-price');
  const sepEl   = document.getElementById('coll-info-price-sep');
  if (!countEl) return;

  const hidePrice = () => { priceEl.style.display = 'none'; if (sepEl) sepEl.style.display = 'none'; };
  const showPrice = (sum, cls) => {
    priceEl.textContent = fmtEur(sum);
    priceEl.className = 'coll-info-price ' + cls;
    priceEl.style.display = '';
    if (sepEl) sepEl.style.display = '';
  };

  if (selectionMode && selectedIds.size > 0) {
    const { sum, total } = computeTotal(selectedIds);
    countEl.textContent = total;
    (pricesVisible && sum > 0) ? showPrice(sum, 'green') : hidePrice();
  } else {
    const cards = getCards('collection');
    countEl.textContent = cards.length;
    const tab = S.collection.collTab;
    // En « possédé », afficher aussi le nombre total d'exemplaires (doublons compris).
    const labelEl = document.querySelector('.coll-info-label');
    if (labelEl) {
      const copies = tab === 'owned' ? cards.reduce((s, c) => s + totalQty(c.id), 0) : 0;
      labelEl.textContent = (tab === 'owned' && copies > cards.length) ? `cartes · ${copies} ex.` : 'cartes';
    }
    if (pricesVisible && cards.length > 0) {
      // En « À vendre », le total = somme des PRIX DE VENTE saisis (repli marché).
      let sum;
      if (tab === 'trade') sum = computeSellTotal(cards);
      else sum = computeTotal(new Set(cards.map(c => c.id))).sum;
      const cls = tab === 'owned' ? 'green' : tab === 'wanted' ? 'blue' : 'orange';
      sum > 0 ? showPrice(sum, cls) : hidePrice();
    } else hidePrice();
  }
}

// Total potentiel de la liste de vente : prix de vente saisi, sinon prix marché.
function computeSellTotal(cards) {
  let sum = 0;
  cards.forEach(c => {
    const d = getPriceData(c.id, 'trade', tradeLangOf(c.id));
    const v = d.val ? parseFloat(d.val) : (d.min ? parseFloat(d.min) : (c.apiPrice != null ? c.apiPrice : null));
    if (v != null && !isNaN(v)) sum += v;
  });
  return sum;
}

function updateExplorePriceTotal() {
  const el = document.getElementById('explore-price-total');
  const pd = document.getElementById('price-divider');
  if (!el) return;
  if (!pricesVisible) { el.style.display = 'none'; if (pd) pd.style.display = 'none'; return; }
  let sum = 0, count = 0;
  filtered.forEach(c => { const v = getBestPrice(c.id); if (v != null) { sum += v; count++; } });
  if (count === 0) { el.style.display = 'none'; if (pd) pd.style.display = 'none'; return; }
  el.style.display = 'block';
  if (pd) pd.style.display = '';
  el.textContent = fmtEur(sum);
}

// Rafraîchit tout ce qui dépend des prix après un changement (saisie modale,
// remplissage auto depuis le prix marché). Met à jour les totaux et, si le tri
// courant dépend du prix, ré-affiche la vue pour réordonner.
const PRICE_SORTS = ['price-asc', 'price-desc', 'market-asc', 'market-desc'];
function refreshAfterPriceChange() {
  updateExplorePriceTotal();
  updateTotalsBar();
  if (currentTab === 'collection' && PRICE_SORTS.includes(S.collection.sort)) renderCollection();
  else if (currentTab === 'explore' && PRICE_SORTS.includes(S.explore.sort)) applyFilters();
}

/* ════════════════════════════════════════════════════════════════════════
   CACHE INDEXEDDB (cartes hydratées)
   localStorage est plafonné (~5 Mo) — IndexedDB encaisse plusieurs Mo sans
   souci. On ne met en cache QUE les données de cartes (pas la collection).
   ════════════════════════════════════════════════════════════════════════ */
const IDB_NAME = 'pikidex';
const IDB_STORE = 'cards-cache';
function cacheKey() { return `cards-${currentLang}-v${CACHE_VERSION}`; }

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror   = () => reject(r.error);
    });
  } catch (e) { return null; }
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch (e) {}
}

/* ════════════════════════════════════════════════════════════════════════
   API TCGdex
   ════════════════════════════════════════════════════════════════════════ */
async function fetchCardDetails(card) {
  const res = await fetch(`${API}/cards/${encodeURIComponent(card.id)}`);
  if (!res.ok) return card;
  const details = await res.json();
  return { ...card, ...details, rarity: card.rarity || details.rarity, detailsLoaded: true };
}

async function hydrateCards(cards, concurrency = 12) {
  const hydrated = new Array(cards.length);
  let next = 0;
  async function worker() {
    while (next < cards.length) {
      const index = next++;
      try { hydrated[index] = await fetchCardDetails(cards[index]); }
      catch (e) { hydrated[index] = cards[index]; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return hydrated;
}

// Hydratation progressive : on a déjà affiché les briefs, on complète chaque
// carte (dexId, illustrateur, prix, set complet) en tâche de fond et on
// re-rafraîchit l'Explorer par à-coups → le tri Pokédex se met en place tout
// seul, premiers Pokémon en tête. `hydrateRunId` annule un run précédent quand
// on change de catalogue (région/langue) ou qu'on force une actualisation.
let hydrateRunId = 0;
async function hydrateProgressive(cards, seriesMap) {
  const myRun = ++hydrateRunId;
  let next = 0, lastPaint = performance.now();
  const repaint = () => {
    enrichSeries(cards, seriesMap);
    // On ne re-peint que si l'utilisateur regarde le haut de l'Explorer sans
    // recherche en cours (sinon on perturberait son défilement / ses résultats).
    if (currentTab === 'explore' && window.scrollY < 300 && !S.explore.query) {
      populateFilters('explore');
      applyFilters();
    }
  };
  async function worker() {
    while (next < cards.length && myRun === hydrateRunId) {
      const c = cards[next++];
      try {
        const res = await fetch(`${API}/cards/${encodeURIComponent(c.id)}`);
        if (res.ok) {
          const d = await res.json();
          const rarity = c.rarity, rarityKind = c.rarityKind; // on garde la rareté du fetch
          Object.assign(c, d, { rarity, rarityKind, detailsLoaded: true });
        } else c.detailsLoaded = true;
      } catch (e) { c.detailsLoaded = true; }
      if (performance.now() - lastPaint > 900) { lastPaint = performance.now(); repaint(); }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
  if (myRun !== hydrateRunId) return; // catalogue changé entre-temps → run obsolète
  enrichSeries(cards, seriesMap);
  snapshotCollectionCards();
  if (currentTab === 'explore' && window.scrollY < 300 && !S.explore.query) { populateFilters('explore'); applyFilters(); }
  countEl.textContent = cards.length;
  idbSet(cacheKey(), { cards, savedAt: Date.now() }); // cache complet pour les prochaines visites
  if (sourceLabel) sourceLabel.textContent = 'via TCGdex API';
}

async function fetchCardsByRarity({ label, kind }) {
  const pageSize = 500;
  const pages = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}/cards?rarity=${encodeURIComponent(label)}&pagination:page=${page}&pagination:itemsPerPage=${pageSize}`);
    const cards = res.ok ? await res.json() : [];
    pages.push(...cards.map(card => ({ ...card, rarity: label, rarityKind: kind })));
    if (cards.length < pageSize) break;
  }
  return pages;
}

// L'API ne met pas la série sur la fiche d'une carte : on construit une fois
// la table set.id → série via /series/{id}, puis on enrichit les cartes.
async function fetchSeriesMap() {
  try {
    const res = await fetch(`${API}/series`);
    if (!res.ok) return null;
    const list = await res.json();
    const details = (await Promise.all(list.map(s =>
      fetch(`${API}/series/${encodeURIComponent(s.id)}`).then(r => r.ok ? r.json() : null).catch(() => null)
    ))).filter(Boolean);
    // Séries triées par date de sortie → index de sortie croissant par set
    details.sort((a, b) => String(a.releaseDate || '').localeCompare(String(b.releaseDate || '')));
    const serie = {}, order = {}, name = {};
    let idx = 0;
    details.forEach(d => (d.sets || []).forEach(set => {
      serie[set.id] = { id: d.id, name: d.name };
      order[set.id] = idx++;
      if (set.name) name[set.id] = set.name;
    }));
    return { serie, order, name };
  } catch (e) { return null; }
}

function enrichSeries(cards, data) {
  if (!data) return;
  const { serie, order, name } = data;
  cards.forEach(c => {
    if (!c.set?.id) return;
    const next = { ...c.set };
    if (serie[c.set.id]) next.serie = serie[c.set.id];
    if (order[c.set.id] != null) next.order = order[c.set.id];
    if (name && name[c.set.id] && !next.name) next.name = name[c.set.id]; // nom d'extension dès les briefs
    c.set = next;
  });
}

async function fetchPromoCards() {
  // PROMO_SET_IDS sont des sets internationaux (svp, swshp…) absents du catalogue
  // asiatique — on saute (les cartes illustrées JP arrivent via le fetch rareté).
  if (currentRegion === 'asian') return [];
  const allPromos = [];
  // Briefs uniquement (id/nom/image + rareté promo). Les détails (dexId, prix…)
  // arrivent via l'hydratation progressive, comme pour les cartes de rareté.
  await Promise.all(PROMO_SET_IDS.map(async (setId) => {
    try {
      const res = await fetch(`${API}/sets/${setId}`);
      if (!res.ok) return;
      const setData = await res.json();
      const setMeta = { id: setData.id, name: setData.name, serie: setData.serie || null };
      (setData.cards || []).forEach(ref => allPromos.push({ ...ref, set: setMeta, rarity: 'Promo', rarityKind: 'promo' }));
    } catch (e) {}
  }));
  return allPromos;
}

// Catalogue asiatique : ingestion PAR SET (les briefs de set contiennent les
// images), car beaucoup de cartes JP ont un champ rareté vide → introuvables
// par rareté. On garde toutes les cartes imagées. Détails (illustrateur, dexId,
// prix) chargés à l'ouverture d'une carte. Le nom romaji est précalculé.
async function fetchAsianCatalog() {
  const res = await fetch(`${API}/sets`);
  if (!res.ok) throw new Error('sets');
  const sets = await res.json();
  const cards = [];
  const BATCH = 12;
  for (let i = 0; i < sets.length; i += BATCH) {
    const batch = sets.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (s) => {
      try {
        const r = await fetch(`${API}/sets/${encodeURIComponent(s.id)}`);
        if (!r.ok) return [];
        const data = await r.json();
        const setMeta = { id: data.id, name: data.name, serie: data.serie || null, cardCount: data.cardCount || null };
        return (data.cards || []).filter(c => c.image).map(c => ({ ...c, set: setMeta, region: 'asian' }));
      } catch (e) { return []; }
    }));
    results.forEach(arr => cards.push(...arr));
    if (sourceLabel) sourceLabel.textContent = `chargement des sets japonais… ${Math.min(i + BATCH, sets.length)}/${sets.length}`;
  }
  return cards;
}

async function fetchCards({ force = false } = {}) {
  hydrateRunId++; // annule une hydratation progressive encore en cours
  showSkeletons();
  sourceLabel = document.getElementById('source-label');

  // 1) Cache local d'abord (affichage quasi instantané aux visites suivantes)
  if (!force) {
    const cached = await idbGet(cacheKey());
    if (cached && Array.isArray(cached.cards) && cached.cards.length &&
        (Date.now() - cached.savedAt) < CACHE_TTL) {
      allCards = cached.cards;
      applyAltImages(allCards); // repli image promos même depuis un ancien cache
      snapshotCollectionCards();
      countEl.textContent = allCards.length;
      populateFilters('explore');
      updateRarityButtons('explore');
      applyFilters();
      errorMsg.style.display = 'none';
      if (sourceLabel) sourceLabel.textContent = 'cache local';
      return;
    }
  }

  // 2) Sinon, récupération réseau complète
  if (sourceLabel) sourceLabel.textContent = 'chargement des cartes…';
  try {
    if (currentRegion === 'asian') {
      // Ingestion par set + enrichissement série, sans hydratation (briefs only).
      const [asianCards, seriesMap] = await Promise.all([
        fetchAsianCatalog(),
        fetchSeriesMap().catch(() => null),
      ]);
      enrichSeries(asianCards, seriesMap);
      asianCards.forEach(c => { c.romaji = toRomaji(c.name); });
      allCards = asianCards;
    } else {
      // Briefs rapides (image + nom + rareté) → affichage quasi immédiat (~0,6 s),
      // puis hydratation progressive en arrière-plan (dexId → tri Pokédex, prix…).
      const [rarityResults, promoCards, seriesMap] = await Promise.all([
        Promise.all(RARITY_LABELS.map(r => fetchCardsByRarity(r).catch(() => []))),
        fetchPromoCards().catch(() => []),
        fetchSeriesMap().catch(() => null),
      ]);
      allCards = [...rarityResults.flat(), ...promoCards];
      if (allCards.length === 0) throw new Error('empty');
      allCards.forEach(c => { if (!c.set) c.set = { id: String(c.id).split('-')[0] }; });
      enrichSeries(allCards, seriesMap);
      applyAltImages(allCards); // repli pokemontcg.io pour les cartes sans image TCGdex
      snapshotCollectionCards();
      countEl.textContent = allCards.length;
      populateFilters('explore');
      updateRarityButtons('explore');
      applyFilters();
      errorMsg.style.display = 'none';
      if (sourceLabel) sourceLabel.textContent = 'détails en cours…';
      hydrateProgressive(allCards, seriesMap);
      return;
    }
    if (allCards.length === 0) throw new Error('empty');

    snapshotCollectionCards();
    countEl.textContent = allCards.length;
    idbSet(cacheKey(), { cards: allCards, savedAt: Date.now() }); // sauvegarde en arrière-plan

    populateFilters('explore');
    updateRarityButtons('explore');
    applyFilters();
    errorMsg.style.display = 'none';
    if (sourceLabel) sourceLabel.textContent = 'via TCGdex API';
  } catch (e) {
    grid.innerHTML = '';
    errorMsg.style.display = 'block';
    countEl.textContent = '0';
    if (sourceLabel) sourceLabel.textContent = 'via TCGdex API';
  }
}

/* ── Pagination Explorer (bouton + scroll infini) ─────────────────────── */
function loadNextPage() {
  if (displayed >= filtered.length) { scrollLoader.classList.remove('visible'); return; }
  scrollLoader.classList.add('visible');
  setTimeout(() => {
    const slice = filtered.slice(displayed, displayed + PAGE_SIZE);
    const start = displayed;
    displayed += slice.length;
    paintGrid(grid, slice, 'explore', { append: true, startIndex: start, fullList: filtered });
    scrollLoader.classList.remove('visible');
    loadMoreBtn.style.display = displayed < filtered.length ? 'block' : 'none';
  }, 80);
}

/* ════════════════════════════════════════════════════════════════════════
   PRIX CARDMARKET (modale)
   ════════════════════════════════════════════════════════════════════════ */
function trendArrow(trend, avg30) {
  if (trend == null || avg30 == null) return '';
  const diff = ((trend - avg30) / avg30) * 100;
  if (Math.abs(diff) < 2) return '';
  return diff > 0
    ? `<span class="price-trend-up"> ▲ ${diff.toFixed(1)}%</span>`
    : `<span class="price-trend-down"> ▼ ${Math.abs(diff).toFixed(1)}%</span>`;
}

// Map TCGdex set id → { code: code Cardmarket, slug: slug d'URL Cardmarket }
const CM_SETS = {
  // ── Scarlet & Violet ──────────────────────────────────────────────────────
  'sv1':      { code:'SVI',  slug:'Scarlet-Violet' },
  'sv2':      { code:'PAL',  slug:'Paldea-Evolved' },
  'sv3':      { code:'OBF',  slug:'Obsidian-Flames' },
  'sv3pt5':   { code:'MEW',  slug:'151' },
  'sv3.5':    { code:'MEW',  slug:'151' },
  'sv03.5':   { code:'MEW',  slug:'151' },
  'sv4':      { code:'PAR',  slug:'Paradox-Rift' },
  'sv4pt5':   { code:'PAF',  slug:'Paldean-Fates' },
  'sv4.5':    { code:'PAF',  slug:'Paldean-Fates' },
  'sv04.5':   { code:'PAF',  slug:'Paldean-Fates' },
  'sv5':      { code:'TEF',  slug:'Temporal-Forces' },
  'sv6':      { code:'TWM',  slug:'Twilight-Masquerade' },
  'sv6pt5':   { code:'SFA',  slug:'Shrouded-Fable' },
  'sv6.5':    { code:'SFA',  slug:'Shrouded-Fable' },
  'sv06.5':   { code:'SFA',  slug:'Shrouded-Fable' },
  'sv7':      { code:'SCR',  slug:'Stellar-Crown' },
  'sv8':      { code:'SSP',  slug:'Surging-Sparks' },
  'sv8pt5':   { code:'PRE',  slug:'Prismatic-Evolutions' },
  'sv8.5':    { code:'PRE',  slug:'Prismatic-Evolutions' },
  'sv08.5':   { code:'PRE',  slug:'Prismatic-Evolutions' },
  'sv9':      { code:'JTG',  slug:'Journey-Together' },
  'sv10':     { code:'DRI',  slug:'Destined-Rivals' },
  'sv10.0':   { code:'DRI',  slug:'Destined-Rivals' },
  'sv10pt5':  { code:'BLK',  slug:'Black-Bolt' },
  'sv10.5':   { code:'BLK',  slug:'Black-Bolt' },
  'sv010.5':  { code:'BLK',  slug:'Black-Bolt' },
  'sv11':     { code:'WHT',  slug:'White-Flare' },
  'sv11.5':   { code:'WHT',  slug:'White-Flare' },
  // Legacy aliases
  'sv9pt5':   { code:'DRI',  slug:'Destined-Rivals' },
  'sv9.5':    { code:'DRI',  slug:'Destined-Rivals' },
  'sv09.5':   { code:'DRI',  slug:'Destined-Rivals' },
  // ── Sword & Shield ────────────────────────────────────────────────────────
  'swsh1':    { code:'SSH',  slug:'Sword-Shield' },
  'swsh2':    { code:'RCL',  slug:'Rebel-Clash' },
  'swsh3':    { code:'DAA',  slug:'Darkness-Ablaze' },
  'swsh3pt5': { code:'CPA',  slug:'Champions-Path' },
  'swsh4':    { code:'VIV',  slug:'Vivid-Voltage' },
  'swsh4pt5': { code:'SHF',  slug:'Shining-Fates' },
  'swsh5':    { code:'BST',  slug:'Battle-Styles' },
  'swsh6':    { code:'CRE',  slug:'Chilling-Reign' },
  'swsh7':    { code:'EVS',  slug:'Evolving-Skies' },
  'swsh7pt5': { code:'CEL',  slug:'Celebrations' },
  'swsh8':    { code:'FST',  slug:'Fusion-Strike' },
  'swsh9':    { code:'BRS',  slug:'Brilliant-Stars' },
  'swsh10':   { code:'ASR',  slug:'Astral-Radiance' },
  'swsh10pt5':{ code:'PGO',  slug:'Pokemon-GO' },
  'swsh11':   { code:'LOR',  slug:'Lost-Origin' },
  'swsh12':   { code:'SIT',  slug:'Silver-Tempest' },
  'swsh12pt5':{ code:'CRZ',  slug:'Crown-Zenith' },
  // ── Sun & Moon ────────────────────────────────────────────────────────────
  'sm1':      { code:'SUM',  slug:'Sun-Moon' },
  'sm2':      { code:'GRI',  slug:'Guardians-Rising' },
  'sm3':      { code:'BUS',  slug:'Burning-Shadows' },
  'sm3pt5':   { code:'SLG',  slug:'Shining-Legends' },
  'sm4':      { code:'CIN',  slug:'Crimson-Invasion' },
  'sm5':      { code:'UPR',  slug:'Ultra-Prism' },
  'sm6':      { code:'FLI',  slug:'Forbidden-Light' },
  'sm7':      { code:'CES',  slug:'Celestial-Storm' },
  'sm7pt5':   { code:'DRM',  slug:'Dragon-Majesty' },
  'sm8':      { code:'LOT',  slug:'Lost-Thunder' },
  'sm9':      { code:'TEU',  slug:'Team-Up' },
  'sm10':     { code:'UNB',  slug:'Unbroken-Bonds' },
  'sm11':     { code:'UNM',  slug:'Unified-Minds' },
  'sm11pt5':  { code:'HIF',  slug:'Hidden-Fates' },
  'sm12':     { code:'CEC',  slug:'Cosmic-Eclipse' },
  // ── XY ────────────────────────────────────────────────────────────────────
  'xy0':      { code:'KSS',  slug:'Kalos-Starter-Set' },
  'xy1':      { code:'XY',   slug:'XY' },
  'xy2':      { code:'FLF',  slug:'Flashfire' },
  'xy3':      { code:'FFI',  slug:'Furious-Fists' },
  'xy4':      { code:'PHF',  slug:'Phantom-Forces' },
  'xy5':      { code:'PRC',  slug:'Primal-Clash' },
  'xy6':      { code:'ROS',  slug:'Roaring-Skies' },
  'xy7':      { code:'AOR',  slug:'Ancient-Origins' },
  'xy8':      { code:'BKT',  slug:'BREAKthrough' },
  'xy9':      { code:'BKP',  slug:'BREAKpoint' },
  'xy10':     { code:'FCO',  slug:'Fates-Collide' },
  'xy11':     { code:'STS',  slug:'Steam-Siege' },
  'xy12':     { code:'EVO',  slug:'Evolutions' },
  // ── Promos ────────────────────────────────────────────────────────────────
  'svp':      { code:'SVP',  slug:'SV-Black-Star-Promos' },
  'swshp':    { code:'SWSH', slug:'SWSH-Black-Star-Promos' },
  'smp':      { code:'SM',   slug:'SM-Black-Star-Promos' },
  'xyp':      { code:'XY',   slug:'XY-Black-Star-Promos' },
};

function normalizeSetId(raw) {
  if (!raw) return '';
  return raw
    .replace(/^([a-z]+)0+(\d)/i, '$1$2')
    .replace(/\./g, 'pt')
    .replace(/pt(\d)/g, 'pt$1')
    .toLowerCase();
}

function buildCardmarketUrl(card) {
  const name = (card.nameEn || card.name || '').trim();
  const rawId = card.set?.id || '';
  const setMeta = CM_SETS[rawId] || CM_SETS[normalizeSetId(rawId)];
  const localId = card.localId || '';

  if (setMeta && name) {
    return 'https://www.cardmarket.com/fr/Pokemon/Products/Singles/'
      + setMeta.slug
      + '?searchString=' + encodeURIComponent(name)
      + '&language=2'
      + '&sortBy=collectorsnumber_desc';
  }

  const query = [name, localId].filter(Boolean).join(' ');
  return 'https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString='
    + encodeURIComponent(query)
    + '&language=2'
    + '&sortBy=collectorsnumber_desc';
}

function buildCmButton(card) {
  const url = buildCardmarketUrl(card);
  return `<a href="${url}" target="_blank" rel="noopener" class="btn-cardmarket">` +
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>` +
    `Voir sur Cardmarket</a>`;
}

async function renderCardPrice(card) {
  const el = document.getElementById('price-block');
  if (!el) return;

  let pricing = card.pricing;
  // Endpoint choisi selon la RÉGION de la carte (et pas du catalogue affiché) :
  // une carte JP ouverte depuis la collection inter-régions reste interrogée en /ja.
  const base = cardRegionOf(card) === 'asian' ? API_BASE + '/ja' : API_BASE + '/en';

  if (cardRegionOf(card) === 'asian') {
    if (!pricing) {
      try {
        const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`);
        if (res.ok) pricing = (await res.json()).pricing;
      } catch (e) {}
    }
  } else if (!card.nameEn) {
    try {
      const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`);
      if (res.ok) { const data = await res.json(); card.nameEn = data.name || card.name; if (!pricing) pricing = data.pricing; }
    } catch (e) {}
  } else if (!pricing) {
    try {
      const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`);
      if (res.ok) { const data = await res.json(); pricing = data.pricing; }
    } catch (e) {}
  }

  if (!el.isConnected) return;

  const cm = pricing?.cardmarket;
  if (!cm) {
    el.innerHTML = '<div class="price-na">Prix non encore disponible</div>';
    el.innerHTML += buildCmButton(card);
    return;
  }

  const updatedStr = cm.updated
    ? new Date(cm.updated).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : '';

  const hasHolo = cm['trend-holo'] != null;
  const trend  = hasHolo ? cm['trend-holo']  : cm.trend;
  const low    = hasHolo ? cm['low-holo']    : cm.low;
  const avg30  = hasHolo ? cm['avg30-holo']  : cm.avg30;
  const avg7   = hasHolo ? cm['avg7-holo']   : cm.avg7;
  const avg1   = hasHolo ? cm['avg1-holo']   : cm.avg1;

  if (trend != null && !isNaN(trend)) {
    card.apiPrice = trend;
    const plang = cardLangFor(card);
    for (const type of ['owned', 'wanted']) {
      if ((type === 'owned' && isOwned(card.id, plang)) || (type === 'wanted' && isWanted(card.id, plang))) {
        const existing = getPriceData(card.id, type, plang);
        if (!existing.val && !existing.min && !existing.max) {
          setPriceData(card.id, type, { val: trend.toFixed(2), min: '', max: '' }, plang);
        }
      }
    }
    refreshAfterPriceChange();
  }

  el.innerHTML = `
    <div class="price-block-header">
      <span class="price-source">Cardmarket (EUR)</span>
      ${updatedStr ? `<span class="price-updated">màj ${updatedStr}</span>` : ''}
    </div>
    <div class="price-main">
      <div class="price-tile highlight">
        <div class="price-tile-label">Tendance</div>
        <div class="price-tile-value">${fmtEur(trend)}${trendArrow(trend, avg30)}</div>
      </div>
      <div class="price-tile">
        <div class="price-tile-label">Prix bas</div>
        <div class="price-tile-value">${fmtEur(low)}</div>
      </div>
    </div>
    <div class="price-history">
      <span class="price-hist-item">24h <b>${fmtEur(avg1)}</b></span>
      <span class="price-hist-item">7j <b>${fmtEur(avg7)}</b></span>
      <span class="price-hist-item">30j <b>${fmtEur(avg30)}</b></span>
      ${hasHolo ? '<span class="price-hist-item" style="color:var(--accent2);font-size:10px">Holo</span>' : ''}
    </div>`;
  el.innerHTML += buildCmButton(card);
}

/* ════════════════════════════════════════════════════════════════════════
   MODALE
   ════════════════════════════════════════════════════════════════════════ */
// Verrou de défilement : empêche la liste en arrière-plan de défiler quand la
// modale est ouverte. La technique position:fixed marche aussi sur iOS Safari,
// où overflow:hidden seul ne suffit pas.
let lockedScrollY = 0;
function lockBodyScroll() {
  if (document.body.classList.contains('modal-open')) return;
  lockedScrollY = window.scrollY;
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.classList.add('modal-open');
}
function unlockBodyScroll() {
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, lockedScrollY);
}

function closeModal() {
  modalOverlay.classList.remove('open');
  unlockBodyScroll();
  currentModalIndex = -1;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

function getModalCard(offset) {
  if (!modalList.length || currentModalIndex < 0) return null;
  currentModalIndex = (currentModalIndex + offset + modalList.length) % modalList.length;
  return modalList[currentModalIndex];
}

function showAdjacentCard(offset) {
  const card = getModalCard(offset);
  if (card) openModal(card, null, currentModalIndex);
}

async function openModal(card, list, index) {
  lockBodyScroll();
  if (list) modalList = list;
  if (!modalList || !modalList.length) modalList = filtered;
  currentModalIndex = (index != null) ? index : modalList.findIndex(c => c.id === card.id);

  try {
    if (!card.detailsLoaded) {
      const res = await fetch(`${cardApiBase(card)}/cards/${encodeURIComponent(card.id)}`);
      if (res.ok) { const details = await res.json(); card = { ...card, ...details, rarity: card.rarity || details.rarity }; }
    }
  } catch (e) {}

  // Langue de collection de CETTE carte (asiatique → 'ja' même en affichage international).
  const mlang = cardLangFor(card);
  const img    = imgSrc(card, 'high');
  const rarity = card.rarity || '—';
  const set    = card.set?.name || '—';
  const series = card.set?.serie?.name || '—';
  const illus  = card.illustrator || '—';
  const num    = card.localId || card.id || '—';
  const types  = Array.isArray(card.types) ? card.types.join(', ') : (card.types || '—');
  const hp     = card.hp || '—';
  const position = currentModalIndex >= 0 ? `${currentModalIndex + 1} / ${modalList.length}` : '';

  document.getElementById('modal-media').innerHTML = img
    ? `<img class="modal-img" id="modal-img" src="${img}" alt="${escapeHtml(card.name || '')}" data-ph-num="${escapeHtml(card.localId ?? '')}" data-ph-set="${escapeHtml(card.set?.name ?? '')}" data-ph-type="${escapeHtml((card.types && card.types[0]) ?? '')}" onerror="handleImageError(this)" onload="checkCardBack(this)" style="cursor:zoom-in;transition:opacity 0.18s" title="Cliquer pour voir en 3D">`
    : imagePlaceholder(card, true);
  if (img) {
    setTimeout(() => {
      const mi = document.getElementById('modal-img');
      if (mi) mi.onclick = () => openCardViewer(img, card.name);
    }, 0);
  }

  const oPrices = getPriceData(card.id, 'owned', mlang);
  const wPrices = getPriceData(card.id, 'wanted', mlang);
  const tPrices = getPriceData(card.id, 'trade', mlang);
  document.getElementById('modal-info').innerHTML = `
    <div class="modal-position">${position}</div>
    <div class="modal-name">${escapeHtml(card.name || '—')}</div>
    <div style="margin:0.5rem 0 0.75rem;">
      <span style="font-size:13px;color:var(--muted)">${escapeHtml(rarity)}</span>
    </div>
    <div class="modal-lang-row">
      <span class="modal-lang-active" title="Langue de la carte que vous éditez">${LANG_FLAGS[mlang] || ''} ${escapeHtml(LANG_LABELS[mlang] || mlang)}</span>
      <span class="modal-lang-owned" id="modal-lang-owned">${ownedLangsHint(card.id)}</span>
    </div>
    <div class="modal-collection-btns">
      <button class="modal-coll-btn ${isOwned(card.id, mlang) ? 'active-owned' : ''}" id="modal-btn-owned">✦ En collection</button>
      <button class="modal-coll-btn ${isWanted(card.id, mlang) ? 'active-wanted' : ''}" id="modal-btn-wanted">⊕ À obtenir</button>
      <button class="modal-coll-btn ${isTrade(card.id, mlang) ? 'active-trade' : ''}" id="modal-btn-trade" style="${isOwned(card.id, mlang) ? '' : 'opacity:.35;pointer-events:none'}">⇄ Vendre</button>
    </div>
    <div class="modal-qty ${isOwned(card.id, mlang) ? 'visible' : ''}" id="modal-qty">
      <span class="modal-qty-label">Exemplaires possédés</span>
      <div class="modal-qty-stepper">
        <button class="qty-btn" id="qty-minus" aria-label="Retirer un exemplaire">−</button>
        <span class="qty-val" id="qty-val">${qtyOf(card.id, mlang)}</span>
        <button class="qty-btn" id="qty-plus" aria-label="Ajouter un exemplaire">+</button>
      </div>
    </div>
    <div class="tags-section">
      <div class="tags-title">Tags</div>
      <div class="tags-list" id="modal-tags"></div>
      <div class="tag-input-row">
        <input class="tag-input" id="tag-input" list="tag-suggestions" placeholder="Ajouter un tag…" autocomplete="off" maxlength="30">
        <button class="tag-add-btn" id="tag-add">Ajouter</button>
        <datalist id="tag-suggestions"></datalist>
      </div>
    </div>
    <div class="price-input-section ${isOwned(card.id, mlang) ? 'visible' : ''}" id="price-section-owned">
      <div class="price-input-title">Prix payé / estimé</div>
      <div class="price-input-wrap">
        <div class="price-input-group">
          <div class="price-input-label">Valeur fixe (€)</div>
          <input class="price-input" id="pi-owned-val" type="number" min="0" step="0.01" placeholder="ex: 12.50" value="${escapeHtml(oPrices.val)}">
        </div>
        <div class="price-input-group">
          <div class="price-input-label">Min (€)</div>
          <input class="price-input" id="pi-owned-min" type="number" min="0" step="0.01" placeholder="min" value="${escapeHtml(oPrices.min)}">
        </div>
        <div class="price-input-group">
          <div class="price-input-label">Max (€)</div>
          <input class="price-input" id="pi-owned-max" type="number" min="0" step="0.01" placeholder="max" value="${escapeHtml(oPrices.max)}">
        </div>
        <button class="price-input-save" id="pi-owned-save">OK</button>
      </div>
    </div>
    <div class="price-input-section ${isWanted(card.id, mlang) ? 'visible' : ''}" id="price-section-wanted">
      <div class="price-input-title">Budget cible</div>
      <div class="price-input-wrap">
        <div class="price-input-group">
          <div class="price-input-label">Valeur fixe (€)</div>
          <input class="price-input" id="pi-wanted-val" type="number" min="0" step="0.01" placeholder="ex: 8.00" value="${escapeHtml(wPrices.val)}">
        </div>
        <div class="price-input-group">
          <div class="price-input-label">Min (€)</div>
          <input class="price-input" id="pi-wanted-min" type="number" min="0" step="0.01" placeholder="min" value="${escapeHtml(wPrices.min)}">
        </div>
        <div class="price-input-group">
          <div class="price-input-label">Max (€)</div>
          <input class="price-input" id="pi-wanted-max" type="number" min="0" step="0.01" placeholder="max" value="${escapeHtml(wPrices.max)}">
        </div>
        <button class="price-input-save" id="pi-wanted-save">OK</button>
      </div>
    </div>
    <div class="price-input-section ${isTrade(card.id, mlang) ? 'visible' : ''}" id="price-section-trade">
      <div class="price-input-title">Prix de vente</div>
      <div class="price-input-wrap">
        <div class="price-input-group">
          <div class="price-input-label">Valeur fixe (€)</div>
          <input class="price-input" id="pi-trade-val" type="number" min="0" step="0.01" placeholder="ex: 5.00" value="${escapeHtml(tPrices.val)}">
        </div>
        <div class="price-input-group">
          <div class="price-input-label">Min (€)</div>
          <input class="price-input" id="pi-trade-min" type="number" min="0" step="0.01" placeholder="min" value="${escapeHtml(tPrices.min)}">
        </div>
        <div class="price-input-group">
          <div class="price-input-label">Max (€)</div>
          <input class="price-input" id="pi-trade-max" type="number" min="0" step="0.01" placeholder="max" value="${escapeHtml(tPrices.max)}">
        </div>
        <button class="price-input-save" id="pi-trade-save">OK</button>
      </div>
    </div>
    <div class="price-block" id="price-block">
      <div class="price-loading">Chargement du prix…</div>
    </div>
    <div class="modal-row"><span class="key">Extension</span><span class="val">${escapeHtml(set)}</span></div>
    <div class="modal-row" style="margin-top:2px;">
      <span class="key">Rareté</span>
      <span class="val" style="display:flex;align-items:center;gap:6px;">${getBadge(rarity, card.rarityKind)}</span>
    </div>
    <div class="modal-row"><span class="key">Série</span><span class="val">${escapeHtml(series)}</span></div>
    <div class="modal-row"><span class="key">Numéro</span><span class="val">${escapeHtml(num)}</span></div>
    <div class="modal-row"><span class="key">Illustrateur</span><span class="val">${illus !== '—' ? `<button class="modal-artist-link" id="modal-artist">${escapeHtml(illus)}</button>` : '—'}</span></div>
    <div class="modal-row"><span class="key">Type(s)</span><span class="val">${escapeHtml(types)}</span></div>
    <div class="modal-row"><span class="key">PV</span><span class="val">${escapeHtml(hp)}</span></div>
  `;

  history.replaceState(null, '', '#card-' + encodeURIComponent(card.id));

  const artistBtn = document.getElementById('modal-artist');
  if (artistBtn) artistBtn.onclick = () => { closeModal(); setActiveTab('master'); openMasterGroup('artist', illus); };

  renderModalTags(card.id);
  const tagInput = document.getElementById('tag-input');
  const addCurrentTag = () => {
    const v = tagInput.value.trim();
    if (!v) return;
    addTag(card.id, v);
    tagInput.value = '';
    renderModalTags(card.id);
    onTagsChanged();
  };
  document.getElementById('tag-add').addEventListener('click', addCurrentTag);
  tagInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCurrentTag(); } });

  renderCardPrice(card);

  document.getElementById('modal-share').onclick = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => showToast('🔗 Lien copié !', 'info')).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      showToast('🔗 Lien copié !', 'info');
    });
  };

  const syncModalBtns = (id) => {
    const bo = document.getElementById('modal-btn-owned');
    const bw = document.getElementById('modal-btn-wanted');
    const bt = document.getElementById('modal-btn-trade');
    if (!bo || !bw) return;
    // Boutons & sections prix : état pour la langue de CETTE carte (mlang).
    const owned = isOwned(id, mlang);
    bo.className = 'modal-coll-btn' + (owned ? ' active-owned' : '');
    bw.className = 'modal-coll-btn' + (isWanted(id, mlang) ? ' active-wanted' : '');
    if (bt) {
      bt.className = 'modal-coll-btn' + (isTrade(id, mlang) ? ' active-trade' : '');
      bt.style.opacity = owned ? '1' : '0.35';
      bt.style.pointerEvents = owned ? '' : 'none';
    }
    const so = document.getElementById('price-section-owned');
    const sw = document.getElementById('price-section-wanted');
    const stp = document.getElementById('price-section-trade');
    if (so) so.classList.toggle('visible', owned);
    if (sw) sw.classList.toggle('visible', isWanted(id, mlang));
    if (stp) stp.classList.toggle('visible', isTrade(id, mlang));
    const mq = document.getElementById('modal-qty');
    if (mq) mq.classList.toggle('visible', owned);
    const qv = document.getElementById('qty-val');
    if (qv) qv.textContent = qtyOf(id, mlang);
    const hint = document.getElementById('modal-lang-owned');
    if (hint) hint.textContent = ownedLangsHint(id);
    // Vignette : classes « toutes langues » + rafraîchissement des drapeaux.
    const gridCard = document.querySelector(`.card[data-id="${id}"]`);
    if (gridCard) {
      gridCard.classList.toggle('owned',  ownedSet.has(id));
      gridCard.classList.toggle('wanted', wantedSet.has(id));
      gridCard.classList.toggle('trade',  tradeSet.has(id));
      const body = gridCard.querySelector('.card-body');
      gridCard.querySelector('.card-langs')?.remove();
      gridCard.querySelector('.card-qty')?.remove();
      const wrap = document.createElement('div');
      wrap.innerHTML = langFlagsHtml(id) + qtyBadgeHtml(id);
      [...wrap.children].forEach(el => gridCard.insertBefore(el, body));
      updateCardPricePill(gridCard, id);
    }
  };

  document.getElementById('modal-btn-owned').addEventListener('click', () => {
    toggleOwned(card.id, mlang); syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'master') renderMaster();
    if (currentTab === 'echange' && lastFriendData) renderEchangeResults(lastFriendData);
  });
  document.getElementById('modal-btn-wanted').addEventListener('click', () => {
    toggleWanted(card.id, mlang); syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'echange' && lastFriendData) renderEchangeResults(lastFriendData);
  });
  document.getElementById('modal-btn-trade')?.addEventListener('click', () => {
    toggleTrade(card.id, mlang); syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'echange' && lastFriendData) renderEchangeResults(lastFriendData);
  });
  const onQty = (delta) => {
    setQty(card.id, mlang, qtyOf(card.id, mlang) + delta);
    syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'master') renderMaster();
  };
  document.getElementById('qty-minus')?.addEventListener('click', () => onQty(-1));
  document.getElementById('qty-plus')?.addEventListener('click', () => onQty(1));

  document.getElementById('pi-owned-save')?.addEventListener('click', () => {
    setPriceData(card.id, 'owned', {
      val: document.getElementById('pi-owned-val').value,
      min: document.getElementById('pi-owned-min').value,
      max: document.getElementById('pi-owned-max').value,
    }, mlang);
    showToast('✦ Prix collection sauvegardé');
  });
  document.getElementById('pi-wanted-save')?.addEventListener('click', () => {
    setPriceData(card.id, 'wanted', {
      val: document.getElementById('pi-wanted-val').value,
      min: document.getElementById('pi-wanted-min').value,
      max: document.getElementById('pi-wanted-max').value,
    }, mlang);
    showToast('⊕ Budget cible sauvegardé');
  });
  document.getElementById('pi-trade-save')?.addEventListener('click', () => {
    setPriceData(card.id, 'trade', {
      val: document.getElementById('pi-trade-val').value,
      min: document.getElementById('pi-trade-min').value,
      max: document.getElementById('pi-trade-max').value,
    }, mlang);
    showToast('⇄ Prix de vente sauvegardé');
  });

  modalOverlay.classList.add('open');
}

/* ════════════════════════════════════════════════════════════════════════
   VISIONNEUSE 3D
   ════════════════════════════════════════════════════════════════════════ */
function openCardViewer(imgUrl, altText) {
  const overlay = document.getElementById('card-viewer-overlay');
  const img     = document.getElementById('card-viewer-img');
  const inner   = document.getElementById('card-viewer-inner');
  // Affiche d'abord le webp (déjà en cache, instantané), puis bascule sur le
  // PNG sans perte une fois téléchargé — plus net, sans artefacts de compression.
  const webpUrl = imgUrl.replace(/\/(?:low|high)\.\w+$/, '/high.webp');
  const pngUrl  = imgUrl.replace(/\/(?:low|high)\.\w+$/, '/high.png');
  img.src = webpUrl;
  img.alt = altText || '';
  if (pngUrl !== webpUrl) {
    const hi = new Image();
    hi.onload = () => { if (overlay.classList.contains('open')) img.src = pngUrl; };
    hi.src = pngUrl;
  }
  inner.style.transform = 'rotateY(0deg) rotateX(0deg)';
  inner.style.setProperty('--glare-x', '50%');
  inner.style.setProperty('--glare-y', '36%');
  overlay.classList.add('open');

  let isDragging = false;
  let startX = 0, startY = 0, rotX = 0, rotY = 0;
  const scene = document.getElementById('card-viewer-scene');

  function applyRotation(dx, dy) {
    rotY = Math.max(-35, Math.min(35, rotY + dx * 0.4));
    rotX = Math.max(-25, Math.min(25, rotX - dy * 0.4));
    inner.style.transform = `rotateY(${rotY}deg) rotateX(${rotX}deg)`;
    // Le reflet spéculaire se déplace à l'inverse de l'inclinaison (effet brillance).
    inner.style.setProperty('--glare-x', (50 - rotY * 1.5) + '%');
    inner.style.setProperty('--glare-y', (36 + rotX * 1.6) + '%');
  }
  function onDown(e) {
    isDragging = true;
    startX = e.touches ? e.touches[0].clientX : e.clientX;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    e.stopPropagation();
  }
  function onMove(e) {
    if (!isDragging) return;
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    applyRotation(cx - startX, cy - startY);
    startX = cx; startY = cy;
    e.preventDefault();
  }
  function onUp() { isDragging = false; }

  const newScene = scene.cloneNode(false);
  newScene.appendChild(inner);
  scene.parentNode.replaceChild(newScene, scene);

  newScene.addEventListener('mousedown',  onDown);
  newScene.addEventListener('touchstart', onDown, { passive: true });
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('touchmove',  onMove, { passive: false });
  window.addEventListener('mouseup',    onUp);
  window.addEventListener('touchend',   onUp);
}

/* ════════════════════════════════════════════════════════════════════════
   TOAST
   ════════════════════════════════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show toast-' + type;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = ''; }, 2200);
}

/* ════════════════════════════════════════════════════════════════════════
   EXPORT IMAGE (popup html2canvas)
   ════════════════════════════════════════════════════════════════════════ */
function buildExportRows(cards) {
  return cards.map(c => {
    const img    = c.image ? imgSrc(c, 'high') : ''; // pokemontcg.io = pas de CORS → exclu de l'export

    const name   = (currentLang === 'en' && c.nameEn) ? c.nameEn : (c.name || '—');
    const set    = c.set?.name || '';
    const rarity = c.rarity || '';
    const num    = c.localId || '';
    const illus  = c.illustrator || '';
    const ownedLabel  = ownedSet.has(c.id)  ? getPriceLabel(c.id, 'owned')  : '';
    const wantedLabel = wantedSet.has(c.id) ? getPriceLabel(c.id, 'wanted') : '';
    const langFlags   = [...new Set([...langsWith(c.id, 'qty'), ...langsWith(c.id, 'wanted'), ...langsWith(c.id, 'trade')])]
                          .map(l => LANG_FLAGS[l] || '').join('');
    const apiLabel    = c.apiPrice != null ? fmtEur(c.apiPrice) : '';
    const statusClass = ownedSet.has(c.id) ? 'owned' : wantedSet.has(c.id) ? 'wanted' : '';
    const badgeHtml   = c.rarityKind === 'sir'    ? '<span class="b sir">SIR</span>'
                      : c.rarityKind === 'ir'     ? '<span class="b ir">IR</span>'
                      : c.rarityKind === 'promo'  ? '<span class="b promo">PROMO</span>'
                      : '<span class="b alt">ALT</span>';

    const priceHtml = [
      ownedLabel  ? `<span class="p own">${ownedLabel}</span>`   : '',
      wantedLabel ? `<span class="p want">${wantedLabel}</span>` : '',
      (!ownedLabel && !wantedLabel && apiLabel) ? `<span class="p api">${apiLabel}</span>` : '',
    ].filter(Boolean).join('');

    return `<div class="card ${statusClass}" data-img="${img}">
      ${img ? `<img src="${img}" alt="" crossorigin="anonymous">` : '<div class="no-img">?</div>'}
      <div class="info">
        ${badgeHtml}
        <div class="name">${name}${langFlags ? ` <span class="langflags">${langFlags}</span>` : ''}</div>
        <div class="meta">${set}${num ? ' #' + num : ''}</div>
        ${illus ? `<div class="artist">${illus}</div>` : ''}
        ${priceHtml ? `<div class="prices">${priceHtml}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function getExportDesc() {
  if (currentTab === 'collection') {
    const t = S.collection.collTab;
    return t === 'owned' ? 'En collection' : t === 'wanted' ? 'À obtenir' : 'À vendre';
  }
  return 'Explorer';
}

function generateExport() {
  let cards;
  if (currentTab === 'collection') {
    cards = (selectionMode && selectedIds.size > 0)
      ? allCards.filter(c => selectedIds.has(c.id))
      : getCards('collection');
  } else {
    cards = filtered;
  }
  if (!cards.length) { showToast('Aucune carte à exporter', 'info'); return; }

  const rows       = buildExportRows(cards);
  const filterDesc = getExportDesc();

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pikidex — Export</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0f;color:#f0f0ee;font-family:'DM Sans',sans-serif;padding:1.5rem}
  .toolbar{display:flex;align-items:center;gap:12px;margin-bottom:1.25rem;flex-wrap:wrap}
  h1{font-family:'Syne',sans-serif;font-size:1.3rem;font-weight:800}
  .sub{font-size:11px;color:#888}
  .btn{padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:#1e1e24;color:#f0f0ee;font-family:'Syne',sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .18s;white-space:nowrap}
  .btn:hover{background:#2a2a32;border-color:rgba(255,255,255,.3)}
  .btn.primary{background:rgba(200,240,96,.12);border-color:rgba(200,240,96,.4);color:#c8f060}
  .btn.primary:hover{background:rgba(200,240,96,.2)}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .progress{font-size:11px;color:#888;display:none}
  .progress.show{display:block}
  #size-slider{accent-color:#c8f060;width:120px;cursor:pointer}
  label{font-size:11px;color:#888}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--card-w,160px),1fr));gap:10px}
  .card{background:#16161a;border:1px solid rgba(255,255,255,.07);border-radius:10px;overflow:hidden;break-inside:avoid}
  .card.owned{border-color:rgba(200,240,96,.45)}
  .card.wanted{border-color:rgba(96,160,240,.45)}
  .card img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
  .no-img{width:100%;aspect-ratio:3/4;background:#1e1e24;display:flex;align-items:center;justify-content:center;font-size:2rem;color:#444}
  .info{padding:6px 8px 8px;position:relative}
  .name{font-family:'Syne',sans-serif;font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:18px}
  .meta{font-size:9px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .artist{font-size:9px;color:#666;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .b{position:absolute;top:5px;left:6px;font-size:8px;font-weight:700;padding:2px 5px;border-radius:100px;font-family:'Syne',sans-serif}
  .b.ir   {background:rgba(200,240,96,.2);color:#c8f060;border:1px solid rgba(200,240,96,.35)}
  .b.sir  {background:rgba(96,240,200,.2);color:#60f0c8;border:1px solid rgba(96,240,200,.35)}
  .b.alt  {background:rgba(240,160,96,.2);color:#f0a060;border:1px solid rgba(240,160,96,.35)}
  .b.promo{background:rgba(200,140,255,.2);color:#c88cff;border:1px solid rgba(200,140,255,.35)}
  .prices{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
  .p{font-size:9px;font-weight:700;font-family:'Syne',sans-serif;padding:1px 5px;border-radius:100px}
  .p.own {background:rgba(200,240,96,.12);color:#c8f060}
  .p.want{background:rgba(96,160,240,.12);color:#60a0f0}
  .p.api {background:rgba(255,255,255,.06);color:#aaa}
  @media print{
    .toolbar{display:none!important}
    body{padding:.5cm}
  }
</style>
</head>
<body>
<div class="toolbar">
  <div>
    <h1>Pikidex</h1>
    <div class="sub">${filterDesc} · ${cards.length} cartes · ${new Date().toLocaleDateString('fr-FR')}</div>
  </div>
  <label>Taille <input type="range" id="size-slider" min="100" max="240" value="160" step="10"></label>
  <button class="btn" id="btn-prices">💰 Cacher les prix</button>
  <button class="btn primary" id="btn-img">⬇ Générer image PNG</button>
  <span class="progress" id="progress">Chargement des images…</span>
</div>
<div class="grid" id="export-grid">${rows}</div>
<script>
const slider = document.getElementById('size-slider');
slider.addEventListener('input', () => {
  document.querySelector('.grid').style.setProperty('--card-w', slider.value + 'px');
});

let pricesVisible = true;
const priceStyle = document.createElement('style');
document.head.appendChild(priceStyle);
document.getElementById('btn-prices').addEventListener('click', function() {
  pricesVisible = !pricesVisible;
  priceStyle.textContent = pricesVisible ? '' : '.prices { display: none !important; }';
  this.textContent = pricesVisible ? '💰 Cacher les prix' : '💰 Afficher les prix';
});

document.querySelectorAll('img').forEach(img => { img.onerror = () => { img.style.opacity = '.15'; }; });

document.getElementById('btn-img').addEventListener('click', async () => {
  const btn = document.getElementById('btn-img');
  const prog = document.getElementById('progress');
  btn.disabled = true; btn.textContent = '⏳ En cours…';
  prog.classList.add('show'); prog.textContent = 'Chargement des images…';
  const imgs = [...document.querySelectorAll('#export-grid img')];
  await Promise.all(imgs.map(img => new Promise(res => {
    if (img.complete) return res();
    img.onload = res; img.onerror = res;
  })));
  prog.textContent = 'Rendu en cours…';
  try {
    const grid = document.getElementById('export-grid');
    const canvas = await html2canvas(grid, {
      backgroundColor: '#0d0d0f', scale: 2, useCORS: true, allowTaint: false, logging: false,
      windowWidth: grid.scrollWidth, windowHeight: grid.scrollHeight,
    });
    prog.textContent = 'Téléchargement…';
    const link = document.createElement('a');
    link.download = 'illusdex-export.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    prog.textContent = '✓ Image téléchargée !';
    setTimeout(() => { prog.classList.remove('show'); }, 3000);
  } catch(e) { prog.textContent = '⚠ Erreur : ' + e.message; }
  btn.disabled = false; btn.textContent = '⬇ Générer image PNG';
});
<\/script>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
  showToast(`↗ Export ouvert (${cards.length} cartes)`, 'info');
}

/* ════════════════════════════════════════════════════════════════════════
   IMPORT / EXPORT DE LA COLLECTION (JSON)
   ════════════════════════════════════════════════════════════════════════ */
function buildConfigPayload() {
  // La clé de sync et son horodatage sont propres à l'appareil → jamais transmis.
  const { syncKey, syncAppliedTs, ...prefsOut } = prefs;
  return JSON.stringify({
    app: 'pikidex', version: 2, exportedAt: new Date().toISOString(),
    collection,
    // Projections « toutes langues » conservées pour relecture par d'anciennes versions.
    owned: [...ownedSet], wanted: [...wantedSet], trade: [...tradeSet],
    prefs: prefsOut, masters: startedMasters, presets: filterPresets, tags: tagsMap,
  }, null, 2);
}

function openConfig()  { document.getElementById('config-overlay').classList.add('open'); }
function closeConfig() { document.getElementById('config-overlay').classList.remove('open'); }

function openSettings()  { document.getElementById('settings-overlay').classList.add('open'); }
function closeSettings() { document.getElementById('settings-overlay').classList.remove('open'); }

/* ── Panneau d'ajout / scan de cartes ─────────────────────────────────────
   Saisie du numéro (+ total / nom si doute) → candidats du catalogue courant
   via findScanCandidates → tap pour ajouter à la collection. La caméra (OCR)
   viendra alimenter les mêmes champs.
   ──────────────────────────────────────────────────────────────────────── */
let scanSessionCount = 0;

function addOwnedFromScan(card) {
  const lang = cardLangFor(card);
  if (isOwned(card.id, lang)) { showToast('Déjà en collection', 'info'); return; }
  ensureRec(card.id, lang).qty = 1;
  snapshotById(card.id);
  afterCollectionChange();
  scanSessionCount++;
  showToast('✦ Ajoutée : ' + (card.name || ''));
  // Prêt pour la carte suivante : on vide le numéro et on réarme l'auto-capture.
  const numEl = document.getElementById('scan-num'); if (numEl) numEl.value = '';
  lastCapturedSig = null;
  renderScanCandidates();
  updateScanSession();
}

function buildScanCandidateEl(card) {
  const lang = cardLangFor(card);
  const owned = isOwned(card.id, lang);
  const img = imgSrc(card);
  const sub = `${card.set?.name || ''}${card.localId ? ' · N°' + card.localId : ''}`;
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'scan-cand' + (owned ? ' owned' : '');
  el.innerHTML = `
    ${img ? `<img class="scan-cand-img" src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="scan-cand-noimg">?</div>'}
    <div class="scan-cand-info">
      <div class="scan-cand-name">${LANG_FLAGS[lang] || ''} ${escapeHtml(card.name || '—')}</div>
      <div class="scan-cand-sub">${escapeHtml(sub)}</div>
    </div>
    <span class="scan-cand-add">${owned ? '✓' : '+'}</span>`;
  el.addEventListener('click', () => { if (!isOwned(card.id, lang)) addOwnedFromScan(card); });
  return el;
}

// Lit le champ N° : accepte « 45 » ou « 45/198 ».
function parseScanNum() {
  const raw = (document.getElementById('scan-num').value || '').trim();
  const m = raw.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (m) return { number: m[1], total: m[2] };
  const n = raw.match(/\d{1,3}/);
  return { number: n ? n[0] : '', total: '' };
}

function renderScanCandidates() {
  const results = document.getElementById('scan-results');
  if (!results) return;
  const { number, total } = parseScanNum();
  if (!number) { results.innerHTML = ''; return; }
  if (!allCards.length) { results.innerHTML = '<div class="scan-empty">Catalogue non chargé.</div>'; return; }
  const cands = findScanCandidates({ number, total }, allCards, 12);
  if (!cands.length) { results.innerHTML = '<div class="scan-empty">Aucune carte trouvée dans ce catalogue.</div>'; return; }
  results.innerHTML = '';
  cands.forEach(c => results.appendChild(buildScanCandidateEl(c.card)));
}

function updateScanSession() {
  const el = document.getElementById('scan-session');
  if (el) el.textContent = scanSessionCount
    ? `✦ ${scanSessionCount} carte${scanSessionCount > 1 ? 's' : ''} ajoutée${scanSessionCount > 1 ? 's' : ''} dans cette session`
    : '';
}

function openScanPanel() {
  scanSessionCount = 0;
  const ctx = document.getElementById('scan-context');
  if (ctx) ctx.innerHTML = `Ajout au catalogue <b>${escapeHtml(REGIONS[currentRegion].label)}</b> · ${LANG_FLAGS[currentLang] || ''} ${escapeHtml(LANG_LABELS[currentLang] || currentLang)}`;
  const n = document.getElementById('scan-num'); if (n) n.value = '';
  document.getElementById('scan-results').innerHTML = '';
  updateScanSession();
  document.getElementById('scan-overlay').classList.add('open');
  lockBodyScroll();
  startCamera(); // scanner photo : la caméra démarre tout de suite
}

function closeScanPanel() {
  stopCamera();
  document.getElementById('scan-overlay').classList.remove('open');
  unlockBodyScroll();
  if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); updateTotalsBar(); }
}

/* ── Caméra + OCR (Tesseract.js chargé à la demande) ──────────────────────
   La caméra ne fait que LIRE le numéro / le nom et remplir les champs du
   panneau — le matching et l'ajout restent ceux de l'étape A. L'OCR est un
   accélérateur : si la lecture rate, la saisie manuelle prend le relais.
   ──────────────────────────────────────────────────────────────────────── */
let scanStream = null, ocrWorker = null, ocrWorkerLang = null, tesseractLoading = null;
// Auto-capture : on déclenche quand la carte est nette/détaillée ET immobile.
let scanLoopId = null, lastSig = null, lastCapturedSig = null, stableCount = 0, scanBusy = false;
const SCAN_CONTENT_VAR = 150;  // variance mini = la zone contient une carte (assoupli)
const SCAN_STABLE_DIFF = 18;   // diff inter-images tolérée = immobile (tolère le tremblement)
const SCAN_NEW_DIFF    = 16;   // diff vs dernière capturée = nouvelle carte

function setScanStatus(msg) { const el = document.getElementById('scan-cam-status'); if (el) el.textContent = msg || ''; }

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}
async function getOcrWorker(lang) {
  await loadTesseract();
  if (ocrWorker && ocrWorkerLang === lang) return ocrWorker;
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) {} ocrWorker = null; }
  ocrWorker = await Tesseract.createWorker(lang);
  ocrWorkerLang = lang;
  return ocrWorker;
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScanStatus('Caméra non supportée — saisis le N° ci-dessous.'); return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 }, height: { ideal: 1440 }, // résolution max raisonnable → texte plus net
        focusMode: 'continuous',
      },
    });
    const v = document.getElementById('scan-video');
    v.srcObject = scanStream;
    await v.play();
    await applyCameraTuning(); // autofocus + expo + balance des blancs continus si dispo
    setScanStatus('Place la carte et appuie sur « Capturer ».');
    startScanLoop();
  } catch (e) {
    setScanStatus('Caméra refusée — saisis le N° ci-dessous.');
  }
}

// Active la mise au point continue (et expo/balance auto) quand le matériel le
// permet — c'est ce qui évite les photos floues, fatales à l'OCR.
async function applyCameraTuning() {
  try {
    const track = scanStream && scanStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous'))               adv.push({ focusMode: 'continuous' });
    if (caps.exposureMode && caps.exposureMode.includes('continuous'))         adv.push({ exposureMode: 'continuous' });
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.push({ whiteBalanceMode: 'continuous' });
    if (adv.length) await track.applyConstraints({ advanced: adv });
  } catch (e) {}
}
// Re-déclenche la mise au point juste avant une capture (utile sur les appareils
// qui ne maintiennent pas l'autofocus en continu).
async function refocusOnce() {
  try {
    const track = scanStream && scanStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    if (caps.focusMode && caps.focusMode.includes('single-shot')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
      await new Promise(r => setTimeout(r, 450)); // laisse l'objectif faire le point
    }
  } catch (e) {}
}
function stopCamera() {
  stopScanLoop();
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  setScanStatus('');
}

// Petite empreinte (24×33 niveaux de gris) de la zone-carte + sa variance,
// pour détecter présence (détail) et immobilité (faible écart entre images).
function frameSignature(v) {
  const r = cardRectInVideo(v), W = 24, H = 33;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  c.getContext('2d').drawImage(v, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const arr = new Uint8Array(W * H); let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; arr[j] = g; sum += g; }
  const mean = sum / arr.length; let varr = 0;
  for (let j = 0; j < arr.length; j++) { const dd = arr[j] - mean; varr += dd * dd; }
  return { arr, variance: varr / arr.length };
}
function sigDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

function scanTick() {
  const v = document.getElementById('scan-video');
  if (!v || !v.videoWidth || scanBusy) return;
  const sig = frameSignature(v);
  const stable = lastSig && sigDiff(sig.arr, lastSig) < SCAN_STABLE_DIFF;
  const isNew  = !lastCapturedSig || sigDiff(sig.arr, lastCapturedSig) > SCAN_NEW_DIFF;
  lastSig = sig.arr;
  if (sig.variance > SCAN_CONTENT_VAR && stable && isNew) {
    if (++stableCount >= 1) { lastCapturedSig = sig.arr; stableCount = 0; autoCapture(); }
  } else stableCount = 0;
}
function startScanLoop() { stopScanLoop(); lastSig = lastCapturedSig = null; stableCount = 0; scanLoopId = setInterval(scanTick, 350); }
function stopScanLoop() { if (scanLoopId) { clearInterval(scanLoopId); scanLoopId = null; } }
async function autoCapture() {
  scanBusy = true;
  try { await captureAndOcr(); } finally { scanBusy = false; }
}

// Position de la carte (zone du cadre-guide) en pixels RÉELS de la vidéo, en
// tenant compte du recadrage object-fit:cover de l'affichage.
function cardRectInVideo(v) {
  const view = document.querySelector('.scan-cam-view');
  const cw = view.clientWidth, ch = view.clientHeight;
  const vw = v.videoWidth, vh = v.videoHeight;
  const scale = Math.max(cw / vw, ch / vh);
  const offX = (vw * scale - cw) / 2, offY = (vh * scale - ch) / 2;
  // cadre-guide : inset 8% vertical, 12% horizontal (cf. .scan-cam-frame)
  const fl = 0.12 * cw, ft = 0.08 * ch, fw = 0.76 * cw, fh = 0.84 * ch;
  return { x: (fl + offX) / scale, y: (ft + offY) / scale, w: fw / scale, h: fh / scale };
}

// Niveaux de gris + étirement de contraste : aide nettement Tesseract.
function preprocessForOcr(canvas) {
  const ctx = canvas.getContext('2d');
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = (g - 128) * 1.5 + 128;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(im, 0, 0);
  return canvas;
}

// Recadre une sous-zone (fractions DANS la carte) et la pré-traite pour l'OCR.
function cropCardRegion(v, rx, ry, rw, rh, upscale = 3) {
  const r = cardRectInVideo(v);
  const sx = r.x + rx * r.w, sy = r.y + ry * r.h, sw = rw * r.w, sh = rh * r.h;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * upscale));
  c.height = Math.max(1, Math.round(sh * upscale));
  c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return preprocessForOcr(c);
}

// Binarisation par seuil d'Otsu : texte sombre sur fond clair → noir/blanc pur,
// ce qui aide nettement Tesseract sur du petit texte.
function otsuThreshold(canvas) {
  const ctx = canvas.getContext('2d');
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data;
  const n = d.length / 4, g = new Uint8Array(n), hist = new Array(256).fill(0);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0; g[j] = v; hist[v]++; }
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thr = t; }
  }
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const val = g[j] > thr ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = val; }
  ctx.putImageData(im, 0, 0);
  return canvas;
}

// Extrait un numéro de carte d'un texte OCR. Accepte « 029/198 », « 029 198 »
// (slash manqué) ou un nombre seul.
function parseNumFromText(raw) {
  const nums = (raw.match(/\d{1,3}/g) || []);
  const xy = raw.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (xy) return { number: xy[1], total: xy[2], xy: true };
  if (nums.length >= 2) return { number: nums[0], total: nums[1], xy: true };
  if (nums.length === 1) return { number: nums[0], total: '', xy: false };
  return null;
}

// Fractions du n° de collection DANS LA CARTE (appliquées au rectangle de carte
// détecté, pas au cadre) : coin bas-gauche moderne → de plus en plus large.
const SCAN_NUM_REGIONS = {
  international: [
    { x: 0.03, y: 0.90, w: 0.50, h: 0.085 },
    { x: 0.00, y: 0.86, w: 0.62, h: 0.13 },
    { x: 0.00, y: 0.80, w: 1.00, h: 0.19 },
  ],
  asian: [
    { x: 0.02, y: 0.90, w: 0.55, h: 0.085 },
    { x: 0.00, y: 0.86, w: 0.66, h: 0.13 },
    { x: 0.00, y: 0.80, w: 1.00, h: 0.19 },
  ],
};

// Détecte le rectangle de la CARTE dans le cadre-guide (elle flotte dans sa
// pochette → marges sombres). Projection de luminosité : la carte = grande zone
// claire centrale. Renvoie un rect en px vidéo (repli sur le cadre si douteux).
function detectCardRect(v) {
  const r = cardRectInVideo(v);
  const W = 160, H = Math.max(1, Math.round(W * r.h / r.w));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H); let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const val = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; g[j] = val; sum += val; }
  const thr = (sum / (W * H)) * 0.92; // la carte est plus claire que le fond
  const col = new Int32Array(W), row = new Int32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] > thr) { col[x]++; row[y]++; }
  const span = (arr, len, perp) => {
    const need = perp * 0.4; let lo = 0, hi = len - 1;
    while (lo < len && arr[lo] < need) lo++;
    while (hi > lo && arr[hi] < need) hi--;
    return [lo, hi];
  };
  const [x0, x1] = span(col, W, H), [y0, y1] = span(row, H, W);
  const cw = x1 - x0, ch = y1 - y0;
  if (cw < W * 0.4 || ch < H * 0.4) return { x: r.x, y: r.y, w: r.w, h: r.h, detected: false };
  return { x: r.x + (x0 / W) * r.w, y: r.y + (y0 / H) * r.h, w: (cw / W) * r.w, h: (ch / H) * r.h, detected: true };
}
// Rects absolus (px vidéo) des zones-numéro, relatifs au rectangle de carte.
function numberCropsForCard(cb) {
  const fr = SCAN_NUM_REGIONS[currentRegion] || SCAN_NUM_REGIONS.international;
  return fr.map(f => ({ x: cb.x + f.x * cb.w, y: cb.y + f.y * cb.h, w: f.w * cb.w, h: f.h * cb.h }));
}
// Crop d'un rect absolu (px vidéo), fortement agrandi puis prétraité.
function cropAbs(v, rect, upscale = 6) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w * upscale));
  c.height = Math.max(1, Math.round(rect.h * upscale));
  c.getContext('2d').drawImage(v, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  return preprocessForOcr(c);
}

// Image complète de la zone-carte avec une grille de repères en % — me permet de
// lire la position réelle du numéro et de caler les coordonnées de crop.
function fullCardDebugCanvas(v, cb, numRects) {
  const r = cardRectInVideo(v);
  const W = 300, H = Math.max(1, Math.round(W * r.h / r.w));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,200,255,0.5)'; ctx.lineWidth = 1;
  for (let p = 10; p < 100; p += 10) {
    const x = W * p / 100, y = H * p / 100;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,220,255,0.95)'; ctx.font = 'bold 10px monospace';
  for (let p = 0; p <= 100; p += 20) { ctx.fillText(String(p), W * p / 100 + 1, 9); ctx.fillText(String(p), 1, H * p / 100 + 9); }
  const toCv = rc => ({ x: (rc.x - r.x) / r.w * W, y: (rc.y - r.y) / r.h * H, w: rc.w / r.w * W, h: rc.h / r.h * H });
  if (cb) { const b = toCv(cb); ctx.strokeStyle = cb.detected ? 'lime' : 'orange'; ctx.lineWidth = 2; ctx.strokeRect(b.x, b.y, b.w, b.h); } // carte détectée (verte) / repli (orange)
  if (numRects) { ctx.strokeStyle = 'rgba(255,110,0,0.95)'; ctx.lineWidth = 1.5; numRects.forEach(rc => { const b = toCv(rc); ctx.strokeRect(b.x, b.y, b.w, b.h); }); } // zones-numéro essayées
  return c;
}

function renderScanDebug(attempts, best, full) {
  const dbg = document.getElementById('scan-debug');
  if (!dbg) return;
  dbg.hidden = false;
  const fullHtml = full
    ? `<div class="scan-dbg-full"><img src="${full.toDataURL('image/png')}" alt="carte captée"><div class="scan-dbg-cap">Carte captée — repères en % (x en haut, y à gauche)</div></div>`
    : '';
  dbg.innerHTML = fullHtml + attempts.map((a, i) => {
    const read = a.parsed ? (a.parsed.total ? `${a.parsed.number}/${a.parsed.total}` : a.parsed.number) : '—';
    return `<div class="scan-dbg-item${(best && a.parsed === best) ? ' chosen' : ''}">
      <img src="${a.crop.toDataURL('image/png')}" alt="zone ${i + 1}">
      <div class="scan-debug-text"><b>${read}</b> <span class="scan-dbg-raw">« ${escapeHtml((a.raw || '').replace(/\n/g, ' ') || '(rien)')} »</span></div>
    </div>`;
  }).join('');
}

// On lit UNIQUEMENT le numéro (le plus fiable). On essaie plusieurs zones et on
// retient celle qui donne un X/Y ; le debug montre chaque tentative pour régler.
async function captureAndOcr() {
  const v = document.getElementById('scan-video');
  if (!v || !v.videoWidth) return;
  const lang = currentRegion === 'asian' ? 'jpn' : 'eng';
  setScanStatus(window.Tesseract ? 'Lecture…' : 'Chargement de l\'OCR (1ère fois)…');
  try {
    const worker = await getOcrWorker(lang);
    await worker.setParameters({ tessedit_char_whitelist: '0123456789/', tessedit_pageseg_mode: '7' });
    const cb = detectCardRect(v);                 // bords de la carte (pas le cadre)
    const regions = numberCropsForCard(cb);       // zones-numéro relatives à la carte
    const attempts = [];
    let best = null;
    for (const reg of regions) {
      const crop = cropAbs(v, reg, 6);
      otsuThreshold(crop);
      const raw = ((await worker.recognize(crop)).data.text || '').trim();
      const parsed = parseNumFromText(raw);
      attempts.push({ crop, raw, parsed });
      if (parsed && parsed.xy) { best = parsed; break; } // X/Y trouvé → on s'arrête
    }
    if (!best) { const a = attempts.find(x => x.parsed); if (a) best = a.parsed; }
    renderScanDebug(attempts, best, fullCardDebugCanvas(v, cb, regions));
    if (best) {
      document.getElementById('scan-num').value = best.total ? `${best.number}/${best.total}` : best.number;
      renderScanCandidates();
      setScanStatus(`N° ${best.total ? best.number + '/' + best.total : best.number} — tape la bonne carte ↓`);
    } else {
      setScanStatus('Numéro non lu — vois les zones lues ci-dessous.');
    }
  } catch (e) {
    setScanStatus('Lecture impossible — saisis le N° ci-dessous.');
  }
}

// Construit et copie une liste lisible des cartes à vendre (nom, set, n°, prix).
function shareSellList() {
  const cards = sortByConfig(getCollectionPool().filter(c => tradeSet.has(c.id)), 'set');
  if (!cards.length) { showToast('Aucune carte à vendre', 'info'); return; }
  let total = 0;
  const lines = cards.map(c => {
    const lang = tradeLangOf(c.id);
    const d = getPriceData(c.id, 'trade', lang);
    const v = d.val ? parseFloat(d.val) : (d.min ? parseFloat(d.min) : (c.apiPrice != null ? c.apiPrice : null));
    if (v != null && !isNaN(v)) total += v;
    const priceTxt = getPriceLabel(c.id, 'trade', lang) || (c.apiPrice != null ? `~${fmtEur(c.apiPrice)}` : 'à définir');
    return `• ${c.name || '—'} ${LANG_FLAGS[lang] || ''} — ${c.set?.name || ''}${c.localId ? ' #' + c.localId : ''} — ${priceTxt}`;
  });
  const text = `Cartes à vendre (${cards.length}) — total ~${fmtEur(total)}\n\n${lines.join('\n')}`;
  copyText(text, '📋 Liste de vente copiée');
}

function applyImportedConfig(text, opts = {}) {
  const silent = !!opts.silent;
  let data;
  try { data = JSON.parse(text); }
  catch (e) { if (!silent) showToast('⚠ JSON invalide', 'info'); return; }
  if (!data || typeof data !== 'object') { if (!silent) showToast('⚠ Format non reconnu', 'info'); return; }

  const prevLang = currentLang;
  if (data.collection && typeof data.collection === 'object') {
    collection = data.collection;
    rebuildProjections(); saveCollection();
  } else if (Array.isArray(data.owned) || Array.isArray(data.wanted) || Array.isArray(data.trade) || data.prices) {
    // Ancien format → migrer en langue 'fr'.
    collection = legacyToCollection(data.owned, data.wanted, data.trade, data.prices);
    rebuildProjections(); saveCollection();
  }
  if (Array.isArray(data.masters)) { startedMasters = data.masters.map(m => (m && m.lang) ? m : { ...m, lang: 'fr' }); saveMasters(); }
  if (Array.isArray(data.presets)) { filterPresets = data.presets; savePresetsLS(); populatePresetSelect('explore'); populatePresetSelect('collection'); }
  if (data.tags && typeof data.tags === 'object' && !Array.isArray(data.tags)) { tagsMap = data.tags; saveTags(); refreshTagFilters(); }
  if (data.prefs && typeof data.prefs === 'object') {
    const keepKey = prefs.syncKey, keepTs = prefs.syncAppliedTs; // la sync est propre à l'appareil
    prefs = { ...defaultPrefs, ...data.prefs, syncKey: keepKey, syncAppliedTs: keepTs };
    // Compat exclusions par master set
    if (!prefs.masterExcludes || typeof prefs.masterExcludes !== 'object' || Array.isArray(prefs.masterExcludes)) {
      prefs.masterExcludes = {};
    }
    savePrefs();
    currentLang   = prefs.lang || 'fr';
    currentRegion = prefs.region || regionOfLang(currentLang);
    if (!REGIONS[currentRegion] || !REGIONS[currentRegion].langs.includes(currentLang)) {
      currentRegion = 'international'; currentLang = REGIONS.international.langs[0];
    }
    pricesVisible = prefs.pricesVisible !== false;
    S.explore.sort    = prefs.sort || 'pokedex';
    S.collection.sort = prefs.collSort || 'pokedex';
  }

  if (!silent) { closeConfig(); showToast('✓ Configuration importée'); }

  applyPricesVisible();
  document.getElementById('btn-hide-prices').classList.toggle('active', pricesVisible);

  syncCatalogSelects();
  if (currentLang !== prevLang) {
    API = API_BASE + '/' + currentLang;
    RARITY_LABELS = RARITY_LABELS_BY_LANG[currentLang] || RARITY_LABELS_BY_LANG.en;
    allCards = [];
    fetchCards().then(() => {
      if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); updateTotalsBar(); }
    });
  } else {
    populateFilters('explore');
    applyFilters();
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    updateCollStat();
    updateTotalsBar();
  }
}

/* ════════════════════════════════════════════════════════════════════════
   LIEN PROFOND (#card-<id>)
   ════════════════════════════════════════════════════════════════════════ */
function handleDeepLink() {
  const hash = window.location.hash;
  if (!hash.startsWith('#card-')) return;
  const cardId = decodeURIComponent(hash.slice(6));
  if (!cardId) return;
  const card = allCards.find(c => c.id === cardId);
  if (card) {
    const inFiltered = filtered.find(c => c.id === cardId);
    openModal(inFiltered || card, inFiltered ? filtered : [card], inFiltered ? filtered.indexOf(inFiltered) : 0);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   INITIALISATION
   ════════════════════════════════════════════════════════════════════════ */
// 1) Rendre les contrôles des deux vues, puis capturer les références DOM.
renderFilterControls('explore');
renderFilterControls('collection');

grid          = document.getElementById('grid');
countEl       = document.getElementById('count');
loadMoreBtn   = document.getElementById('load-more');
errorMsg      = document.getElementById('error-msg');
sourceLabel   = document.getElementById('source-label');
modalOverlay  = document.getElementById('modal-overlay');
scrollLoader  = document.getElementById('scroll-loader');
scrollSentinel= document.getElementById('scroll-sentinel');

// 2) Câbler les filtres (moteur partagé).
wireFilters('explore');
wireFilters('collection');

// Boutons d'ordre des listes (partagés Explorer/Collection via délégation).
document.addEventListener('click', e => {
  const btn = e.target.closest('.order-btn');
  if (btn) cycleListOrder(btn.dataset.order);
});
updateOrderButtons();
populatePresetSelect('explore');
populatePresetSelect('collection');

// 3) Pagination Explorer.
loadMoreBtn.addEventListener('click', () => {
  const slice = filtered.slice(displayed, displayed + PAGE_SIZE);
  const start = displayed;
  displayed += slice.length;
  paintGrid(grid, slice, 'explore', { append: true, startIndex: start, fullList: filtered });
  loadMoreBtn.style.display = displayed < filtered.length ? 'block' : 'none';
});

const infiniteObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting) loadNextPage();
}, { rootMargin: '200px' });
infiniteObserver.observe(scrollSentinel);

// 4) Modale (fermeture, navigation, clavier).
modalOverlay.addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-prev').addEventListener('click', e => { e.stopPropagation(); showAdjacentCard(-1); });
document.getElementById('modal-next').addEventListener('click', e => { e.stopPropagation(); showAdjacentCard(1); });
document.addEventListener('keydown', e => {
  if (!modalOverlay.classList.contains('open')) return;
  if (e.key === 'Escape')     closeModal();
  if (e.key === 'ArrowLeft')  showAdjacentCard(-1);
  if (e.key === 'ArrowRight') showAdjacentCard(1);
});

// 5) Visionneuse 3D (fermeture).
document.getElementById('card-viewer-overlay').addEventListener('click', function (e) {
  if (e.target === this || e.target.id === 'card-viewer-img') this.classList.remove('open');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('card-viewer-overlay').classList.remove('open');
});

// 6) Export image.
document.getElementById('btn-export').addEventListener('click', generateExport);

// 6b) Actualiser les cartes.
document.getElementById('btn-refresh').addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh');
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  showToast('↻ Actualisation des cartes…', 'info');
  await fetchCards({ force: true });
  if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
  if (currentTab === 'master') renderMaster();
  btn.classList.remove('spinning');
  showToast('✓ Cartes à jour', 'ok');
});

// 6c) Thème clair / sombre.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const icon = document.querySelector('#btn-theme .theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  const label = document.getElementById('theme-label');
  if (label) label.textContent = theme === 'dark' ? 'Sombre' : 'Clair';
}
applyTheme(prefs.theme === 'dark' ? 'dark' : 'light');
document.getElementById('btn-theme').addEventListener('click', () => {
  const next = (prefs.theme === 'dark') ? 'light' : 'dark';
  prefs.theme = next;
  savePrefs();
  applyTheme(next);
  showToast(next === 'dark' ? '🌙 Thème sombre' : '☀️ Thème clair', 'info');
});

// 7) Affichage / masquage des prix.
const hidePricesBtn = document.getElementById('btn-hide-prices');
hidePricesBtn.classList.toggle('active', pricesVisible);
applyPricesVisible();
hidePricesBtn.addEventListener('click', () => {
  pricesVisible = !pricesVisible;
  prefs.pricesVisible = pricesVisible;
  savePrefs();
  applyPricesVisible();
  hidePricesBtn.classList.toggle('active', pricesVisible);
  showToast(pricesVisible ? '€ Prix affichés' : '€ Prix cachés', 'info');
  if (currentTab === 'collection') { renderCollection(); updateTotalsBar(); }
  else updateExplorePriceTotal();
});

// 8) Type de série (catalogue) + langue de la carte.
function buildRegionOptions() {
  const sel = document.getElementById('region-select');
  if (!sel) return;
  sel.innerHTML = Object.entries(REGIONS).map(([key, r]) =>
    `<option value="${key}"${r.soon ? ' disabled' : ''}>${r.flag} ${r.label}${r.soon ? ' — bientôt' : ''}</option>`
  ).join('');
  sel.value = currentRegion;
}
function buildLangOptions() {
  const sel = document.getElementById('lang-select');
  if (!sel) return;
  sel.innerHTML = REGIONS[currentRegion].langs.map(l =>
    `<option value="${l}">${LANG_FLAGS[l]} ${LANG_LABELS[l]}</option>`
  ).join('');
  sel.value = currentLang;
}
function syncCatalogSelects() { buildRegionOptions(); buildLangOptions(); }

function applyCatalogChange() {
  API = API_BASE + '/' + currentLang;
  RARITY_LABELS = RARITY_LABELS_BY_LANG[currentLang] || RARITY_LABELS_BY_LANG.en;
  if (currentRegion === 'asian') {
    coerceAsianSort();       // JP : pas de Pokédex → tri par extension
  } else {                   // retour international : on restaure le tri préféré
    S.explore.sort    = prefs.sort || 'pokedex';
    S.collection.sort = prefs.collSort || 'pokedex';
  }
  const se = document.getElementById('sort'); if (se) se.value = S.explore.sort;
  const cse = document.getElementById('coll-sort'); if (cse) cse.value = S.collection.sort;
  allCards = [];
  fetchCards().then(() => {
    // Master & Collection dépendent du catalogue courant → rafraîchir si actifs.
    if (currentTab === 'master') { masterSelected = null; renderMaster(); }
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); updateTotalsBar(); }
  });
}

document.getElementById('region-select').addEventListener('change', e => {
  const region = e.target.value;
  if (region === currentRegion) return;
  if (REGIONS[region].soon) {            // sécurité (l'option est déjà disabled)
    e.target.value = currentRegion;
    showToast('Catalogue asiatique — bientôt disponible', 'info');
    return;
  }
  currentRegion = region;
  currentLang = REGIONS[region].langs[0];
  prefs.region = currentRegion; prefs.lang = currentLang; savePrefs();
  buildLangOptions();
  applyCatalogChange();
});
document.getElementById('lang-select').addEventListener('change', e => {
  const lang = e.target.value;
  if (lang === currentLang) return;
  currentLang = lang;
  prefs.lang = currentLang; savePrefs();
  applyCatalogChange();
});
syncCatalogSelects();

// 9) Onglets principaux.
// « Ma Collection » est une section qui regroupe plusieurs sous-vues.
const COLL_SECTION   = ['collection', 'master', 'binder', 'tierlist', 'echange'];
const CATALOG_BAR_TABS = ['explore', 'collection', 'master'];

function setActiveTab(tab) {
  currentTab = tab;
  prefs.tab = currentTab;
  if (COLL_SECTION.includes(tab)) prefs.collSub = tab; // mémorise la dernière sous-vue
  savePrefs();

  const inColl = COLL_SECTION.includes(currentTab);
  // Nav principale : Explorer vs section Ma Collection
  document.querySelectorAll('.nav-tab').forEach(t => {
    const on = t.dataset.section ? (t.dataset.section === 'collection' && inColl) : (t.dataset.view === currentTab);
    t.classList.toggle('active', on);
  });
  // Sous-nav : visible seulement dans la section, onglet courant actif
  const subnav = document.getElementById('coll-subnav');
  if (subnav) subnav.hidden = !inColl;
  document.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t.dataset.view === currentTab));
  // Barre catalogue : visible sur Explorer / Cartes / Master uniquement
  const cbar = document.getElementById('catalog-bar');
  if (cbar) cbar.hidden = !CATALOG_BAR_TABS.includes(currentTab);

  document.getElementById('explore-view').classList.toggle('hidden', currentTab !== 'explore');
  document.getElementById('collection-view').classList.toggle('active', currentTab === 'collection');
  document.getElementById('master-view').classList.toggle('active', currentTab === 'master');
  document.getElementById('binder-view').classList.toggle('active', currentTab === 'binder');
  document.getElementById('tierlist-view').classList.toggle('active', currentTab === 'tierlist');
  document.getElementById('echange-view').classList.toggle('active', currentTab === 'echange');
  document.getElementById('explore-controls').style.display = currentTab === 'explore' ? '' : 'none';
  if (currentTab !== 'collection' && selectionMode) setSelectionMode(false);
  if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
  if (currentTab === 'master') { masterSelected = null; renderMaster(); }
  if (currentTab === 'binder') renderBinder();
  if (currentTab === 'tierlist') renderTierlist();
  if (currentTab === 'echange') renderEchange();
}
// Nav principale : Explorer (data-view) ou bascule vers la section Collection (data-section).
document.querySelectorAll('.app-nav .nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.section === 'collection') {
      const sub = COLL_SECTION.includes(prefs.collSub) ? prefs.collSub : 'collection';
      setActiveTab(sub);
    } else {
      setActiveTab(tab.dataset.view);
    }
  });
});
// Sous-onglets de la section Collection.
document.querySelectorAll('.sub-nav .sub-tab').forEach(tab => {
  tab.addEventListener('click', () => setActiveTab(tab.dataset.view));
});

// Classeur : navigation entre pages + ajout de page + sélecteur de carte.
document.getElementById('binder-prev').addEventListener('click', () => { if (binderPage > 0) { binderPage--; renderBinder(); } });
document.getElementById('binder-next').addEventListener('click', () => { if (binderPage < binder.pages - 1) { binderPage++; renderBinder(); } });
document.getElementById('binder-addpage').addEventListener('click', () => {
  binder.pages++; binder.slots.push(...new Array(9).fill(null)); binder.pageBgs.push(null);
  saveBinder(); binderPage = binder.pages - 1; renderBinder();
});
document.getElementById('binder-picker-close').addEventListener('click', closeBinderPicker);
document.getElementById('binder-picker').addEventListener('click', e => { if (e.target === e.currentTarget) closeBinderPicker(); });
document.getElementById('binder-picker-search').addEventListener('input', e => renderBinderPicker(e.target.value));

// Tier list : ajout de rangée, export, et sélecteur (collection / à obtenir).
document.getElementById('tier-add').addEventListener('click', () => {
  tierlist.tiers.push({ label: TIER_LABELS[tierlist.tiers.length] || '?', color: '#607d8b', cards: [] });
  renderTierlist();
});
document.getElementById('tier-export').addEventListener('click', exportTierImage);
document.getElementById('tier-picker-close').addEventListener('click', closeTierPicker);
document.getElementById('tier-picker').addEventListener('click', e => { if (e.target === e.currentTarget) closeTierPicker(); });
document.getElementById('tier-picker-search').addEventListener('input', e => renderTierPicker(e.target.value));
document.querySelectorAll('.tier-src-tab').forEach(tab => tab.addEventListener('click', () => {
  tierPickerSrc = tab.dataset.src;
  document.querySelectorAll('.tier-src-tab').forEach(t => t.classList.toggle('active', t === tab));
  renderTierPicker(document.getElementById('tier-picker-search').value);
}));

// 10) Sous-onglets Collection.
document.querySelectorAll('.coll-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const st = S.collection;
    st.collTab  = btn.dataset.coll;
    st.rarities = new Set(rarityKinds());
    st.type     = 'all';
    st.artist   = 'all';
    st.set      = 'all';
    st.series   = 'all';
    st.tag      = 'all';
    st.query    = '';
    const si = document.getElementById('coll-search'); if (si) si.value = '';
    selectedIds.clear();
    lastClickedId = null;
    updateRarityButtons('collection');
    updateCollStat();
    populateFilters('collection');
    renderCollection();
  });
});

// 11) Barre d'outils de sélection (collection).
function setSelectionMode(on) {
  selectionMode = on;
  selectedIds.clear();
  lastClickedId = null;
  const btn = document.getElementById('btn-select-mode');
  btn.classList.toggle('active', on);
  btn.textContent = on ? '☑ Sélection active' : '☐ Sélection';
  document.getElementById('btn-select-all').style.display   = on ? '' : 'none';
  document.getElementById('btn-deselect-all').style.display = on ? '' : 'none';
  document.querySelectorAll('#coll-grid .card').forEach(el => {
    el.classList.toggle('selectable', on);
    el.classList.remove('selected');
  });
  updateTotalsBar();
}
document.getElementById('btn-select-mode').addEventListener('click', () => setSelectionMode(!selectionMode));
document.getElementById('btn-share-sell').addEventListener('click', shareSellList);
document.getElementById('btn-dup-only').addEventListener('click', () => {
  S.collection.dupOnly = !S.collection.dupOnly;
  updateCollStat(); renderCollection(); updateTotalsBar();
});
document.getElementById('btn-select-all').addEventListener('click', () => {
  getCards('collection').forEach(c => {
    selectedIds.add(c.id);
    const el = document.querySelector(`#coll-grid .card[data-id="${c.id}"]`);
    if (el) el.classList.add('selected');
  });
  updateTotalsBar();
});
document.getElementById('btn-deselect-all').addEventListener('click', () => {
  selectedIds.forEach(id => {
    const el = document.querySelector(`#coll-grid .card[data-id="${id}"]`);
    if (el) el.classList.remove('selected');
  });
  selectedIds.clear();
  lastClickedId = null;
  updateTotalsBar();
});

// Navigation tactile (swipe) dans la modale.
(() => {
  const wrap = document.querySelector('.modal-image-wrap');
  if (!wrap) return;
  let sx = 0, sy = 0, tracking = false;
  wrap.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = true; }, { passive: true });
  wrap.addEventListener('touchend', e => {
    if (!tracking) return; tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) showAdjacentCard(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// 11b) Master Set (mode extension/artiste, recherche, retour).
document.querySelectorAll('.master-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    masterMode = btn.dataset.mode;
    masterSelected = null;
    document.querySelectorAll('.master-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === masterMode));
    renderMaster();
  });
});
document.getElementById('master-search').addEventListener('input', e => { masterQuery = e.target.value; renderMaster(); });
document.getElementById('master-back').addEventListener('click', () => { masterSelected = null; renderMaster(); });

// 11b) Ajout / scan de cartes.
document.getElementById('btn-scan').addEventListener('click', openScanPanel);
document.getElementById('scan-close').addEventListener('click', closeScanPanel);
document.getElementById('scan-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeScanPanel(); });
document.getElementById('scan-num').addEventListener('input', renderScanCandidates);
// Capture : bouton (principal) + tap sur la vidéo. L'auto-capture reste un bonus.
async function manualCapture() {
  if (scanBusy) { setScanStatus('Lecture en cours…'); return; }
  scanBusy = true;
  stableCount = 0;
  try {
    setScanStatus('Mise au point…');
    await refocusOnce();      // fait le point avant de capturer (anti-flou)
    await captureAndOcr();
  } finally { scanBusy = false; }
}
document.getElementById('scan-capture').addEventListener('click', manualCapture);
document.getElementById('scan-cam-view').addEventListener('click', manualCapture);

// 11d) Réglages (thème, actualisation, import/export config).
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeSettings(); });

// 12) Import / export de la collection (JSON).
document.getElementById('btn-config').addEventListener('click', () => {
  closeSettings();
  document.getElementById('config-text').value = buildConfigPayload();
  openConfig();
});
document.getElementById('config-close').addEventListener('click', closeConfig);
document.getElementById('config-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeConfig(); });
document.getElementById('config-generate').addEventListener('click', () => {
  document.getElementById('config-text').value = buildConfigPayload();
  showToast('Texte généré', 'info');
});
document.getElementById('config-copy').addEventListener('click', () => {
  const ta = document.getElementById('config-text');
  const v = ta.value || buildConfigPayload();
  ta.value = v;
  navigator.clipboard.writeText(v).then(() => showToast('🔗 Copié !', 'info')).catch(() => {
    ta.select(); document.execCommand('copy'); showToast('🔗 Copié !', 'info');
  });
});
document.getElementById('config-download').addEventListener('click', () => {
  const blob = new Blob([buildConfigPayload()], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'pikidex-collection.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Fichier téléchargé', 'info');
});
document.getElementById('config-pick-file').addEventListener('click', () => document.getElementById('config-file').click());
document.getElementById('config-file').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { document.getElementById('config-text').value = r.result; showToast('Fichier chargé — clique sur Importer', 'info'); };
  r.readAsText(f);
});
document.getElementById('config-import').addEventListener('click', () => applyImportedConfig(document.getElementById('config-text').value));
document.getElementById('config-share-code').addEventListener('click', () => copyText(buildShareCode(), '🔗 Code d\'échange copié !'));

// 12c) Synchronisation entre appareils (Worker Cloudflare intégré).
//  - Clé perso (auto) : PUT /<clé> à chaque changement (débounce) + GET au démarrage.
//  - Partage ponctuel : POST / → code aléatoire, lu par GET /<code>.
const SYNC_URL = 'https://pikidex-sync.maximew2000.workers.dev';
function syncBase() { return SYNC_URL; }
// (syncBusy / syncPushTimer / syncReady déclarés en haut, avant les saveX.)

function genSyncKey() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I/O/0/1/L
  const buf = new Uint8Array(8); crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 8; i++) { if (i === 4) s += '-'; s += chars[buf[i] % chars.length]; }
  return s; // ex. K7P2-9MXT
}
function normSyncKey(k) { return (k || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, ''); }
function setSyncStatus(msg) { const el = document.getElementById('sync-status'); if (el) el.textContent = msg || ''; }

async function syncPushKey() {
  if (!prefs.syncKey || syncBusy) return;
  syncBusy = true;
  try {
    const ts = Date.now();
    const body = JSON.stringify({ _ts: ts, data: buildConfigPayload() });
    const res = await fetch(`${syncBase()}/${encodeURIComponent(prefs.syncKey)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(res.status);
    prefs.syncAppliedTs = ts; savePrefs();
    setSyncStatus('Synchronisé ✓');
  } catch (e) { setSyncStatus('Envoi en échec — réessai au prochain changement'); }
  finally { syncBusy = false; }
}
function scheduleSyncPush() {
  if (!prefs.syncKey || !syncReady) return; // pas avant le pull initial
  setSyncStatus('Modifs en attente…');
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(syncPushKey, 2500);
}
async function syncPullKey({ force = false } = {}) {
  if (!prefs.syncKey) return false;
  try {
    const res = await fetch(`${syncBase()}/${encodeURIComponent(prefs.syncKey)}`);
    if (res.status === 404) { setSyncStatus('Aucune donnée pour cette clé'); return false; }
    if (!res.ok) throw new Error(res.status);
    const wrap = JSON.parse(await res.text());
    if (!wrap || !wrap.data) return false;
    if (!force && !((wrap._ts || 0) > (prefs.syncAppliedTs || 0))) { setSyncStatus('Déjà à jour ✓'); return false; }
    applyImportedConfig(wrap.data, { silent: true }); // applyImportedConfig préserve syncKey
    prefs.syncAppliedTs = wrap._ts || Date.now(); savePrefs();
    setSyncStatus('Récupéré ✓');
    return true;
  } catch (e) { setSyncStatus('Récupération en échec'); return false; }
}
function refreshSyncUI() {
  const has = !!prefs.syncKey;
  const box = document.getElementById('sync-key-box'), setup = document.getElementById('sync-setup-box');
  if (box) box.hidden = !has;
  if (setup) setup.hidden = has;
  const v = document.getElementById('sync-key-val'); if (v) v.textContent = prefs.syncKey || '';
}

// Clé perso : créer / utiliser une clé / sync manuelle / oublier
document.getElementById('sync-create').addEventListener('click', async () => {
  prefs.syncKey = genSyncKey(); prefs.syncAppliedTs = 0; savePrefs();
  refreshSyncUI();
  await syncPushKey();
  copyText(prefs.syncKey, `🔑 Clé ${prefs.syncKey} copiée — colle-la sur tes autres appareils`);
});
document.getElementById('sync-use').addEventListener('click', async () => {
  const k = normSyncKey(document.getElementById('sync-key-input').value);
  if (k.length < 4) { showToast('Clé invalide', 'info'); return; }
  prefs.syncKey = k; prefs.syncAppliedTs = 0; savePrefs();
  refreshSyncUI();
  const ok = await syncPullKey({ force: true }); // adopte les données de la clé
  showToast(ok ? '✓ Synchronisé sur cette clé' : 'Clé enregistrée — aucune donnée encore', 'info');
});
document.getElementById('sync-now').addEventListener('click', async () => {
  const btn = document.getElementById('sync-now'); btn.disabled = true;
  await syncPullKey();   // récupère si plus récent
  await syncPushKey();   // puis pousse l'état local
  btn.disabled = false;
});
document.getElementById('sync-key-copy').addEventListener('click', () => copyText(prefs.syncKey, '🔑 Clé copiée'));
document.getElementById('sync-forget').addEventListener('click', () => {
  prefs.syncKey = ''; prefs.syncAppliedTs = 0; savePrefs(); refreshSyncUI();
  showToast('Clé oubliée sur cet appareil', 'info');
});

// Partage ponctuel par code (ami) : POST → code, GET /<code> → import.
document.getElementById('sync-send').addEventListener('click', async () => {
  const btn = document.getElementById('sync-send'), codeEl = document.getElementById('sync-code');
  btn.disabled = true; btn.textContent = '⬆ Envoi…';
  try {
    const res = await fetch(syncBase(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: buildConfigPayload() });
    if (!res.ok) throw new Error(res.status);
    const { code } = await res.json();
    codeEl.hidden = false; codeEl.textContent = code;
    copyText(code, `🔗 Code ${code} copié — entre-le sur l'autre appareil`);
  } catch (e) {
    showToast('Envoi impossible — réessaie', 'info');
  } finally { btn.disabled = false; btn.textContent = '⬆ Envoyer une copie'; }
});
document.getElementById('sync-get').addEventListener('click', async () => {
  const code = (document.getElementById('sync-code-input').value || '').trim().toUpperCase();
  if (!code) { showToast('Entre un code', 'info'); return; }
  const btn = document.getElementById('sync-get');
  btn.disabled = true; btn.textContent = '⬇ …';
  try {
    const res = await fetch(`${syncBase()}/${encodeURIComponent(code)}`);
    if (res.status === 404) { showToast('Code introuvable ou expiré', 'info'); return; }
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    document.getElementById('config-text').value = text;
    applyImportedConfig(text);
  } catch (e) {
    showToast('Récupération impossible — vérifie le code', 'info');
  } finally { btn.disabled = false; btn.textContent = '⬇ Récupérer'; }
});
refreshSyncUI();

// 12b) Échange : code de partage + comparateur.
document.getElementById('echange-copy-code').addEventListener('click', () => {
  const v = buildShareCode();
  document.getElementById('echange-code').value = v;
  copyText(v, '🔗 Code copié !');
});
document.getElementById('echange-copy-link').addEventListener('click', () => copyText(buildShareLink(), '🔗 Lien copié !'));
document.getElementById('echange-compare').addEventListener('click', () => compareWith(document.getElementById('echange-input').value));
document.getElementById('echange-clear').addEventListener('click', () => {
  document.getElementById('echange-input').value = '';
  document.getElementById('echange-results').style.display = 'none';
  lastFriendData = null;
});

// 13) Navigation par hash.
window.addEventListener('hashchange', () => {
  const hash = window.location.hash;
  if (hash.startsWith('#share=')) { handleShareLink(); return; }
  if (!hash.startsWith('#card-')) { closeModal(); return; }
  handleDeepLink();
});

// 14) Démarrage.
fetchCards().then(async () => {
  if (location.hash.startsWith('#share=')) { handleShareLink(); }
  else { handleDeepLink(); setActiveTab(prefs.tab || 'explore'); }
  // Synchro auto : récupère la dernière version de la clé perso, puis active le push auto.
  if (prefs.syncKey) { try { await syncPullKey(); } catch (e) {} }
  syncReady = true;
});

updateCollStat();