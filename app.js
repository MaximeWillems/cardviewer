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
const CACHE_VERSION = 3;
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
const LS_OWNED  = 'illusdex_owned';
const LS_WANTED = 'illusdex_wanted';
const LS_TRADE  = 'illusdex_trade';
const LS_PRICES = 'illusdex_prices';
const LS_PREFS  = 'illusdex_prefs';

const LS_MASTERS = 'illusdex_masters';
let ownedSet  = new Set(JSON.parse(localStorage.getItem(LS_OWNED)  || '[]'));
let wantedSet = new Set(JSON.parse(localStorage.getItem(LS_WANTED) || '[]'));
let tradeSet  = new Set(JSON.parse(localStorage.getItem(LS_TRADE)  || '[]'));
let pricesMap = JSON.parse(localStorage.getItem(LS_PRICES) || '{}');
let startedMasters = JSON.parse(localStorage.getItem(LS_MASTERS) || '[]'); // [{mode,key,label}]
const LS_PRESETS = 'illusdex_presets';
let filterPresets = JSON.parse(localStorage.getItem(LS_PRESETS) || '[]'); // [{id,ctx,name,...filtres}]
const LS_TAGS = 'illusdex_tags';
let tagsMap = JSON.parse(localStorage.getItem(LS_TAGS) || '{}'); // { cardId: [tags] }

const defaultPrefs = {
  pricesVisible: true, sort: 'pokedex', collSort: 'pokedex', lang: 'fr', tab: 'explore',
  theme: 'light',
  listOrder: { type: 'alpha', artist: 'alpha', set: 'release', series: 'release' },
  // masterRarityExcludes : kinds exclus du comptage Master Set, par mode
  // Stocké comme { set: [...kinds], artist: [...kinds] }
  masterRarityExcludes: { set: [], artist: [] },
};
let prefs = { ...defaultPrefs, ...JSON.parse(localStorage.getItem(LS_PREFS) || '{}') };
prefs.listOrder = { ...defaultPrefs.listOrder, ...(prefs.listOrder || {}) };
// Assurer la présence de masterRarityExcludes (compat versions antérieures)
if (!prefs.masterRarityExcludes || typeof prefs.masterRarityExcludes !== 'object') {
  prefs.masterRarityExcludes = { set: [], artist: [] };
} else {
  prefs.masterRarityExcludes = {
    set:    Array.isArray(prefs.masterRarityExcludes.set)    ? prefs.masterRarityExcludes.set    : [],
    artist: Array.isArray(prefs.masterRarityExcludes.artist) ? prefs.masterRarityExcludes.artist : [],
  };
}

function savePrefs()  { localStorage.setItem(LS_PREFS,  JSON.stringify(prefs)); }
function saveOwned()  { localStorage.setItem(LS_OWNED,  JSON.stringify([...ownedSet])); }
function saveWanted() { localStorage.setItem(LS_WANTED, JSON.stringify([...wantedSet])); }
function saveTrade()  { localStorage.setItem(LS_TRADE,  JSON.stringify([...tradeSet])); }
function savePrices() { localStorage.setItem(LS_PRICES, JSON.stringify(pricesMap)); }
function saveTags()   { localStorage.setItem(LS_TAGS,   JSON.stringify(tagsMap)); }

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
function saveMasters() { localStorage.setItem(LS_MASTERS, JSON.stringify(startedMasters)); }
function savePresetsLS() { localStorage.setItem(LS_PRESETS, JSON.stringify(filterPresets)); }

/* ── État global ──────────────────────────────────────────────────────── */
let currentLang = prefs.lang || 'fr';
let API         = API_BASE + '/' + currentLang;
let RARITY_LABELS = RARITY_LABELS_BY_LANG[currentLang];
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
let masterCards = [];       // cartes affichées dans le détail (pour la modale)

function rarityKinds() { return RARITY_KINDS; }

// État de filtre unifié : un objet par contexte. La source des cartes est la
// seule chose qui diffère entre 'explore' et 'collection' (voir getCards).
function makeFilterState(sort) {
  return {
    query: '', rarities: new Set(rarityKinds()), type: 'all', artist: 'all',
    set: 'all', series: 'all', tag: 'all',
    sort: sort || 'pokedex', priceMin: '', priceMax: '', artistCounts: new Map(),
  };
}
const S = {
  explore:    makeFilterState(prefs.sort),
  collection: makeFilterState(prefs.collSort),
};
S.collection.collTab = 'owned'; // 'owned' | 'wanted' | 'trade'

/* ── Références DOM (assignées dans init) ─────────────────────────────── */
let grid, countEl, loadMoreBtn, errorMsg, sourceLabel, modalOverlay,
    scrollLoader, scrollSentinel;

/* ════════════════════════════════════════════════════════════════════════
   COLLECTION : appartenance + prix
   ════════════════════════════════════════════════════════════════════════ */
function toggleOwned(id) {
  if (ownedSet.has(id)) ownedSet.delete(id); else ownedSet.add(id);
  saveOwned(); updateCollStat();
}
function toggleWanted(id) {
  if (wantedSet.has(id)) wantedSet.delete(id); else wantedSet.add(id);
  saveWanted(); updateCollStat();
}
function toggleTrade(id) {
  if (!ownedSet.has(id)) return; // une carte ne peut être à vendre que si possédée
  if (tradeSet.has(id)) tradeSet.delete(id); else tradeSet.add(id);
  saveTrade(); updateCollStat();
}

function setPriceData(cardId, type, data) {
  if (!pricesMap[cardId]) pricesMap[cardId] = {};
  pricesMap[cardId][type] = data;
  savePrices();
  const gridCard = document.querySelector(`.card[data-id="${cardId}"]`);
  if (gridCard) updateCardPricePill(gridCard, cardId);
  refreshAfterPriceChange();
}
function getPriceData(cardId, type) {
  return pricesMap[cardId]?.[type] || { val: '', min: '', max: '' };
}
function getPriceLabel(cardId, type) {
  const d = getPriceData(cardId, type);
  if (d.val) return fmtEur(parseFloat(d.val));
  if (d.min && d.max) return `${fmtEur(parseFloat(d.min))}–${fmtEur(parseFloat(d.max))}`;
  if (d.min) return `≥${fmtEur(parseFloat(d.min))}`;
  if (d.max) return `≤${fmtEur(parseFloat(d.max))}`;
  return '';
}
function updateCardPricePill(el, cardId) {
  const ownedPill  = el.querySelector('.owned-price');
  const wantedPill = el.querySelector('.wanted-price');
  if (ownedPill)  ownedPill.textContent  = getPriceLabel(cardId, 'owned');
  if (wantedPill) wantedPill.textContent = getPriceLabel(cardId, 'wanted');
}

function getBestPrice(cardId) {
  for (const type of ['owned', 'wanted']) {
    const d = getPriceData(cardId, type);
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
    const d = getPriceData(card.id, type);
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
  let cards = allCards;
  const ms = membershipSet(ctx);
  if (ms) cards = cards.filter(c => ms.has(c.id));
  return sortByConfig(filterCards(cards, st), st.sort, st.artistCounts);
}

/* ════════════════════════════════════════════════════════════════════════
   TRI + SECTIONS (partagés)
   ════════════════════════════════════════════════════════════════════════ */
function getDexNumber(card) {
  return Array.isArray(card.dexId) && card.dexId.length ? Math.min(...card.dexId) : Number.MAX_SAFE_INTEGER;
}
function getSetName(card) { return card.set?.name || ''; }

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

function imagePlaceholder(name, isModal = false) {
  return `
    <div class="image-placeholder ${isModal ? 'modal-placeholder' : ''}">
      <div class="placeholder-mark">?</div>
      <div class="placeholder-title">${escapeHtml(name || 'Carte')}</div>
      <div class="placeholder-text">Image indisponible</div>
    </div>`;
}

function handleImageError(img) {
  const name = img.alt || 'Carte';
  const isModal = img.classList.contains('modal-img');
  const wrapper = document.createElement('div');
  wrapper.innerHTML = imagePlaceholder(name, isModal).trim();
  img.replaceWith(wrapper.firstElementChild);
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
  const img = c.image ? c.image + '/low.webp' : '';
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
  const ownedLabel  = getPriceLabel(c.id, 'owned');
  const wantedLabel = getPriceLabel(c.id, 'wanted');

  const div = document.createElement('div');
  div.className = 'card'
    + (isOwned ? ' owned' : '') + (isWanted ? ' wanted' : '') + (isTrade ? ' trade' : '')
    + (ctx === 'collection' && selectionMode ? ' selectable' : '')
    + (isSelected ? ' selected' : '');
  div.dataset.id = c.id;
  if (ctx === 'collection') div.dataset.idx = idx;

  div.innerHTML = `
    ${img
      ? `<img class="card-img" src="${img}" alt="${escapeHtml(name)}" loading="lazy" onerror="handleImageError(this)">`
      : imagePlaceholder(name)}
    <div class="card-body">
      ${getBadge(c.rarity, c.rarityKind)}
      <div class="card-price-tag">
        <span class="card-price-pill owned-price">${ownedLabel}</span>
        <span class="card-price-pill wanted-price">${wantedLabel}</span>
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

/* ── Filtre de rareté Master Set ──────────────────────────────────────────
   Les kinds exclus sont stockés dans prefs.masterRarityExcludes[mode].
   'trainer' est un pseudo-kind : cartes sans dexId (dresseurs, énergies…).
   ──────────────────────────────────────────────────────────────────────── */
function getMasterExcludes(mode) {
  return new Set(prefs.masterRarityExcludes[mode] || []);
}

function isTrainerCard(card) {
  return !(Array.isArray(card.dexId) && card.dexId.length > 0);
}

function masterCardMatchesFilter(card, excludes) {
  if (excludes.has('trainer') && isTrainerCard(card)) return false;
  if (card.rarityKind && excludes.has(card.rarityKind)) return false;
  return true;
}

// Retourne les cartes d'un groupe après application du filtre de rareté actif.
function masterFilteredCards(cards, mode) {
  const excludes = getMasterExcludes(mode);
  if (excludes.size === 0) return cards;
  return cards.filter(c => masterCardMatchesFilter(c, excludes));
}

function masterGroups(mode) {
  const groups = new Map();
  allCards.forEach(c => {
    const key   = mode === 'set' ? (c.set?.id || '__?') : (c.illustrator || '__?');
    const label = mode === 'set' ? (c.set?.name || 'Extension inconnue') : (c.illustrator || 'Artiste inconnu');
    if (!groups.has(key)) groups.set(key, { key, label, total: 0, owned: 0, cards: [] });
    const g = groups.get(key);
    g.cards.push(c);
  });
  // Recalcule total/owned en tenant compte du filtre actif
  groups.forEach(g => {
    const filtered = masterFilteredCards(g.cards, mode);
    g.total = filtered.length;
    g.owned = filtered.filter(c => ownedSet.has(c.id)).length;
  });
  return [...groups.values()];
}

// ── Suivi des master sets démarrés ────────────────────────────────────
function isMasterStarted(mode, key) { return startedMasters.some(m => m.mode === mode && m.key === key); }

// Démarre un master set : marque toutes ses cartes filtrées « à obtenir »
// (sauf celles déjà possédées) et l'ajoute au suivi.
function startMaster(mode, key, label) {
  const group = masterGroups(mode).find(g => g.key === key);
  if (!group) return;
  const cards = masterFilteredCards(group.cards, mode);
  let added = 0;
  cards.forEach(c => {
    if (!ownedSet.has(c.id) && !wantedSet.has(c.id)) { wantedSet.add(c.id); added++; }
  });
  saveWanted();
  if (!isMasterStarted(mode, key)) { startedMasters.push({ mode, key, label }); saveMasters(); }
  updateCollStat();
  showToast(`✓ Master set démarré — ${added} carte${added > 1 ? 's' : ''} à obtenir`);
}

function stopMaster(mode, key) {
  startedMasters = startedMasters.filter(m => !(m.mode === mode && m.key === key));
  saveMasters();
}

function masterRowHtml(g, extraClass = '', removable = false) {
  const pct = g.total ? Math.round(g.owned / g.total * 100) : 0;
  const done = g.total > 0 && g.owned === g.total;
  const icon = removable ? (g.mode === 'set' ? '📦 ' : '🎨 ') : '';
  const remove = removable ? `<button class="master-remove" data-mode="${escapeHtml(g.mode)}" data-key="${escapeHtml(g.key)}" title="Retirer du suivi">×</button>` : '';
  return `<div class="master-row${done ? ' done' : ''}${extraClass}" data-mode="${escapeHtml(g.mode || masterMode)}" data-key="${escapeHtml(g.key)}">
    <div class="master-row-top">
      <span class="master-row-label">${icon}${escapeHtml(g.label)}</span>
      <span class="master-row-count">${g.owned} / ${g.total}${done ? ' ✓' : ''}</span>
    </div>
    <div class="master-bar-track"><div class="master-bar-fill" style="width:${pct}%"></div></div>
    ${remove}
  </div>`;
}

function openMasterGroup(mode, key) {
  masterMode = mode;
  masterSelected = key;
  document.querySelectorAll('.master-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === masterMode));
  renderMaster();
}

function renderStartedMasters(el) {
  if (!startedMasters.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const rows = startedMasters.map(m => {
    const group = masterGroups(m.mode).find(g => g.key === m.key) || { key: m.key, label: m.label, owned: 0, total: 0 };
    return masterRowHtml({ ...group, mode: m.mode, label: m.label }, ' started', true);
  }).join('');
  el.innerHTML = `<div class="master-section-title">★ Mes master sets en cours</div><div class="master-started-grid">${rows}</div>`;

  el.querySelectorAll('.master-row.started').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.master-remove')) return;
      openMasterGroup(row.dataset.mode, row.dataset.key);
    });
  });
  el.querySelectorAll('.master-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      stopMaster(btn.dataset.mode, btn.dataset.key);
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

  let groups = masterGroups(masterMode);
  const q = masterQuery.toLowerCase().trim();
  if (q) groups = groups.filter(g => g.label.toLowerCase().includes(q));
  groups.sort((a, b) => (b.owned / b.total) - (a.owned / a.total) || a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));

  if (groups.length === 0) { listEl.innerHTML = '<div class="master-empty">Aucun résultat</div>'; return; }

  // ── Chips de filtres de rareté Master Set (liste) ──────────────────────
  const excludes = getMasterExcludes(masterMode);
  const chipsHtml = MASTER_RARITY_FILTERS.map(({ kind, label }) => {
    const excluded = excludes.has(kind);
    return `<button class="pill master-rarity-pill${excluded ? ' master-pill-excluded' : ''}" data-master-rarity="${escapeHtml(kind)}" title="${excluded ? 'Exclure' : 'Inclus'}">${label}</button>`;
  }).join('');

  listEl.innerHTML = `
    <div class="master-filter-row">
      <span class="master-filter-label">Exclure du comptage :</span>
      <div class="master-rarity-pills">${chipsHtml}</div>
    </div>
    <div class="master-rows-container"></div>`;

  // Wire pills
  listEl.querySelectorAll('[data-master-rarity]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.masterRarity;
      const ex = new Set(prefs.masterRarityExcludes[masterMode] || []);
      if (ex.has(kind)) ex.delete(kind); else ex.add(kind);
      prefs.masterRarityExcludes[masterMode] = [...ex];
      savePrefs();
      renderMaster(); // re-render avec nouveaux filtres
    });
  });

  const rowsContainer = listEl.querySelector('.master-rows-container');
  // Recalcule groups avec les nouveaux excludes
  let freshGroups = masterGroups(masterMode);
  if (q) freshGroups = freshGroups.filter(g => g.label.toLowerCase().includes(q));
  
  // Masquer les groupes sans cartes après application des filtres de rareté
  freshGroups = freshGroups.filter(g => g.total > 0);
  freshGroups.sort((a, b) => (b.owned / b.total) - (a.owned / a.total) || a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));

  rowsContainer.innerHTML = freshGroups.map(g => masterRowHtml(g)).join('');
  rowsContainer.querySelectorAll('.master-row').forEach(row => {
    row.addEventListener('click', () => openMasterGroup(masterMode, row.dataset.key));
  });
}

function renderMasterDetail() {
  const listEl = document.getElementById('master-list');
  const detail = document.getElementById('master-detail');
  const gridEl = document.getElementById('master-grid');

  const allGroup = masterGroups(masterMode).find(g => g.key === masterSelected);
  if (!allGroup) { masterSelected = null; renderMaster(); return; }

  // Cartes filtrées selon les excludes actifs
  const filteredGroupCards = masterFilteredCards(allGroup.cards, masterMode);
  const ownedCount = filteredGroupCards.filter(c => ownedSet.has(c.id)).length;
  const totalCount = filteredGroupCards.length;
  const pct = totalCount ? Math.round(ownedCount / totalCount * 100) : 0;

  listEl.style.display = 'none';
  detail.style.display = '';

  document.getElementById('master-detail-title').textContent = allGroup.label;

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

  // ── Chips de filtres dans le détail ──────────────────────────────────
  const excludes = getMasterExcludes(masterMode);
  const chipsHtml = MASTER_RARITY_FILTERS.map(({ kind, label }) => {
    const excluded = excludes.has(kind);
    return `<button class="pill master-rarity-pill${excluded ? ' master-pill-excluded' : ''}" data-master-rarity="${escapeHtml(kind)}" title="${excluded ? 'Exclure' : 'Inclus'}">${label}</button>`;
  }).join('');

  // Compte les cartes affectées par chaque filtre (sur ce groupe)
  const countsByKind = {};
  MASTER_RARITY_FILTERS.forEach(({ kind }) => {
    countsByKind[kind] = allGroup.cards.filter(c =>
      kind === 'trainer' ? isTrainerCard(c) : c.rarityKind === kind
    ).length;
  });
  const excludedTotal = allGroup.cards.length - filteredGroupCards.length;

  document.getElementById('master-detail-progress').innerHTML = `
    <div class="master-detail-filter-row">
      <span class="master-filter-label">Exclure du comptage :</span>
      <div class="master-rarity-pills">${chipsHtml}</div>
      ${excludedTotal > 0 ? `<span class="master-excluded-note">${excludedTotal} carte${excludedTotal > 1 ? 's' : ''} exclue${excludedTotal > 1 ? 's' : ''}</span>` : ''}
    </div>
    <span class="master-progress-num">${ownedCount} / ${totalCount}</span> <span class="master-progress-pct">${pct}%</span>
    <div class="master-bar-track" style="margin-top:6px"><div class="master-bar-fill" style="width:${pct}%"></div></div>`;

  // Wire pills du détail
  detail.querySelectorAll('[data-master-rarity]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.masterRarity;
      const ex = new Set(prefs.masterRarityExcludes[masterMode] || []);
      if (ex.has(kind)) ex.delete(kind); else ex.add(kind);
      prefs.masterRarityExcludes[masterMode] = [...ex];
      savePrefs();
      renderMasterDetail(); // re-render le détail
    });
  });

  // Action : démarrer / retirer du suivi
  const started = isMasterStarted(masterMode, masterSelected);
  const actions = document.getElementById('master-detail-actions');
  actions.innerHTML = started
    ? `<button class="master-start-btn started" id="master-start">✓ En cours — Retirer</button>`
    : `<button class="master-start-btn" id="master-start">+ Démarrer ce master set</button>`;
  document.getElementById('master-start').onclick = () => {
    if (isMasterStarted(masterMode, masterSelected)) {
      stopMaster(masterMode, masterSelected);
      showToast('Master set retiré du suivi', 'info');
    } else {
      startMaster(masterMode, masterSelected, allGroup.label);
    }
    renderMasterDetail();
  };

  masterCards = sortByConfig(filteredGroupCards, 'pokedex');
  paintGrid(gridEl, masterCards, 'master', { sections: false });
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

function buildShareCode() { return encodeShare({ v: 1, w: [...wantedSet], t: [...tradeSet] }); }
function buildShareLink() { return location.origin + location.pathname + '#share=' + buildShareCode(); }

// Tolérant : code base64, lien #share=…, ou JSON d'export complet → { wanted, trade }
function parseFriendData(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  try {
    const d = JSON.parse(raw); // JSON direct (export complet ou {w,t})
    if (Array.isArray(d.wanted) || Array.isArray(d.trade) || Array.isArray(d.w) || Array.isArray(d.t)) {
      return { wanted: new Set(d.wanted || d.w || []), trade: new Set(d.trade || d.t || []) };
    }
  } catch (e) {}
  try {
    const d = decodeShare(raw); // code / lien base64
    return { wanted: new Set(d.w || d.wanted || []), trade: new Set(d.t || d.trade || []) };
  } catch (e) {}
  return null;
}

function computeMatches(theirWanted, theirTrade) {
  return {
    give:    allCards.filter(c => tradeSet.has(c.id) && theirWanted.has(c.id)),
    receive: allCards.filter(c => wantedSet.has(c.id) && theirTrade.has(c.id)),
    have:    allCards.filter(c => ownedSet.has(c.id) && !tradeSet.has(c.id) && theirWanted.has(c.id)),
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
    paintGrid(grid, sortByConfig(cards, 'pokedex'), 'echange', { sections: false });
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
    populateSelectsForCtx('collection', allCards.filter(c => ms.has(c.id)));
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
    if (pricesVisible && cards.length > 0) {
      const { sum } = computeTotal(new Set(cards.map(c => c.id)));
      const cls = S.collection.collTab === 'owned' ? 'green' : S.collection.collTab === 'wanted' ? 'blue' : 'orange';
      sum > 0 ? showPrice(sum, cls) : hidePrice();
    } else hidePrice();
  }
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
    const serie = {}, order = {};
    let idx = 0;
    details.forEach(d => (d.sets || []).forEach(set => {
      serie[set.id] = { id: d.id, name: d.name };
      order[set.id] = idx++;
    }));
    return { serie, order };
  } catch (e) { return null; }
}

function enrichSeries(cards, data) {
  if (!data) return;
  const { serie, order } = data;
  cards.forEach(c => {
    if (!c.set?.id) return;
    const next = { ...c.set };
    if (serie[c.set.id]) next.serie = serie[c.set.id];
    if (order[c.set.id] != null) next.order = order[c.set.id];
    c.set = next;
  });
}

async function fetchPromoCards() {
  const allPromos = [];
  await Promise.all(PROMO_SET_IDS.map(async (setId) => {
    try {
      const res = await fetch(`${API}/sets/${setId}`);
      if (!res.ok) return;
      const setData = await res.json();
      const cardRefs = setData.cards || [];
      const setMeta = { id: setData.id, name: setData.name, serie: setData.serie || null };
      const BATCH = 10;
      for (let i = 0; i < cardRefs.length; i += BATCH) {
        const batch = cardRefs.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (ref) => {
          if (ref.image) return { ...ref, set: setMeta, rarity: 'Promo', rarityKind: 'promo' };
          try {
            const cr = await fetch(`${API}/cards/${encodeURIComponent(ref.id)}`);
            if (cr.ok) {
              const cd = await cr.json();
              return { ...cd, set: setMeta, rarity: 'Promo', rarityKind: 'promo' };
            }
          } catch (e) {}
          return { ...ref, set: setMeta, rarity: 'Promo', rarityKind: 'promo' };
        }));
        results.forEach(c => { if (c) allPromos.push(c); });
      }
    } catch (e) {}
  }));
  return allPromos;
}

async function fetchCards({ force = false } = {}) {
  showSkeletons();
  sourceLabel = document.getElementById('source-label');

  // 1) Cache local d'abord (affichage quasi instantané aux visites suivantes)
  if (!force) {
    const cached = await idbGet(cacheKey());
    if (cached && Array.isArray(cached.cards) && cached.cards.length &&
        (Date.now() - cached.savedAt) < CACHE_TTL) {
      allCards = cached.cards;
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
    const [rarityResults, promoCards, seriesMap] = await Promise.all([
      Promise.all(RARITY_LABELS.map(r => fetchCardsByRarity(r).catch(() => []))),
      fetchPromoCards().catch(() => []),
      fetchSeriesMap(),
    ]);

    allCards = [...rarityResults.flat(), ...promoCards];
    if (allCards.length === 0) throw new Error('empty');

    countEl.textContent = allCards.length;
    if (sourceLabel) sourceLabel.textContent = 'tri Pokédex en préparation…';
    allCards = await hydrateCards(allCards);
    enrichSeries(allCards, seriesMap);

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

  if (!card.nameEn) {
    try {
      const res = await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(card.id)}`);
      if (res.ok) { const data = await res.json(); card.nameEn = data.name || card.name; if (!pricing) pricing = data.pricing; }
    } catch (e) {}
  } else if (!pricing) {
    try {
      const res = await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(card.id)}`);
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
    for (const type of ['owned', 'wanted']) {
      if ((type === 'owned' && ownedSet.has(card.id)) || (type === 'wanted' && wantedSet.has(card.id))) {
        const existing = getPriceData(card.id, type);
        if (!existing.val && !existing.min && !existing.max) {
          setPriceData(card.id, type, { val: trend.toFixed(2), min: '', max: '' });
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
function closeModal() {
  modalOverlay.classList.remove('open');
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
  if (list) modalList = list;
  if (!modalList || !modalList.length) modalList = filtered;
  currentModalIndex = (index != null) ? index : modalList.findIndex(c => c.id === card.id);

  try {
    if (!card.detailsLoaded) {
      const res = await fetch(`${API}/cards/${encodeURIComponent(card.id)}`);
      if (res.ok) { const details = await res.json(); card = { ...card, ...details, rarity: card.rarity || details.rarity }; }
    }
  } catch (e) {}

  const img    = card.image ? card.image + '/high.webp' : '';
  const rarity = card.rarity || '—';
  const set    = card.set?.name || '—';
  const series = card.set?.serie?.name || '—';
  const illus  = card.illustrator || '—';
  const num    = card.localId || card.id || '—';
  const types  = Array.isArray(card.types) ? card.types.join(', ') : (card.types || '—');
  const hp     = card.hp || '—';
  const position = currentModalIndex >= 0 ? `${currentModalIndex + 1} / ${modalList.length}` : '';

  document.getElementById('modal-media').innerHTML = img
    ? `<img class="modal-img" id="modal-img" src="${img}" alt="${escapeHtml(card.name || '')}" onerror="handleImageError(this)" style="cursor:zoom-in;transition:opacity 0.18s" title="Cliquer pour voir en 3D">`
    : imagePlaceholder(card.name || 'Carte', true);
  if (img) {
    setTimeout(() => {
      const mi = document.getElementById('modal-img');
      if (mi) mi.onclick = () => openCardViewer(img, card.name);
    }, 0);
  }

  const oPrices = getPriceData(card.id, 'owned');
  const wPrices = getPriceData(card.id, 'wanted');
  document.getElementById('modal-info').innerHTML = `
    <div class="modal-position">${position}</div>
    <div class="modal-name">${escapeHtml(card.name || '—')}</div>
    <div style="margin:0.5rem 0 0.75rem;">
      <span style="font-size:13px;color:var(--muted)">${escapeHtml(rarity)}</span>
    </div>
    <div class="modal-collection-btns">
      <button class="modal-coll-btn ${ownedSet.has(card.id) ? 'active-owned' : ''}" id="modal-btn-owned">✦ En collection</button>
      <button class="modal-coll-btn ${wantedSet.has(card.id) ? 'active-wanted' : ''}" id="modal-btn-wanted">⊕ À obtenir</button>
      <button class="modal-coll-btn ${tradeSet.has(card.id) ? 'active-trade' : ''}" id="modal-btn-trade" style="${ownedSet.has(card.id) ? '' : 'opacity:.35;pointer-events:none'}">⇄ Vendre</button>
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
    <div class="price-input-section ${ownedSet.has(card.id) ? 'visible' : ''}" id="price-section-owned">
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
    <div class="price-input-section ${wantedSet.has(card.id) ? 'visible' : ''}" id="price-section-wanted">
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
    bo.className = 'modal-coll-btn' + (ownedSet.has(id)  ? ' active-owned'  : '');
    bw.className = 'modal-coll-btn' + (wantedSet.has(id) ? ' active-wanted' : '');
    if (bt) {
      bt.className = 'modal-coll-btn' + (tradeSet.has(id) ? ' active-trade' : '');
      bt.style.opacity = ownedSet.has(id) ? '1' : '0.35';
      bt.style.pointerEvents = ownedSet.has(id) ? '' : 'none';
    }
    const so = document.getElementById('price-section-owned');
    const sw = document.getElementById('price-section-wanted');
    if (so) so.classList.toggle('visible', ownedSet.has(id));
    if (sw) sw.classList.toggle('visible', wantedSet.has(id));
    const gridCard = document.querySelector(`.card[data-id="${id}"]`);
    if (gridCard) {
      gridCard.classList.toggle('owned',  ownedSet.has(id));
      gridCard.classList.toggle('wanted', wantedSet.has(id));
      gridCard.classList.toggle('trade',  tradeSet.has(id));
    }
  };

  document.getElementById('modal-btn-owned').addEventListener('click', () => {
    toggleOwned(card.id); syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'master') renderMaster();
    if (currentTab === 'echange' && lastFriendData) renderEchangeResults(lastFriendData);
  });
  document.getElementById('modal-btn-wanted').addEventListener('click', () => {
    toggleWanted(card.id); syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'echange' && lastFriendData) renderEchangeResults(lastFriendData);
  });
  document.getElementById('modal-btn-trade')?.addEventListener('click', () => {
    toggleTrade(card.id); syncModalBtns(card.id);
    if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
    if (currentTab === 'echange' && lastFriendData) renderEchangeResults(lastFriendData);
  });

  document.getElementById('pi-owned-save')?.addEventListener('click', () => {
    setPriceData(card.id, 'owned', {
      val: document.getElementById('pi-owned-val').value,
      min: document.getElementById('pi-owned-min').value,
      max: document.getElementById('pi-owned-max').value,
    });
    showToast('✦ Prix collection sauvegardé');
  });
  document.getElementById('pi-wanted-save')?.addEventListener('click', () => {
    setPriceData(card.id, 'wanted', {
      val: document.getElementById('pi-wanted-val').value,
      min: document.getElementById('pi-wanted-min').value,
      max: document.getElementById('pi-wanted-max').value,
    });
    showToast('⊕ Budget cible sauvegardé');
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
  img.src = imgUrl.replace('/low.webp', '/high.webp');
  img.alt = altText || '';
  inner.style.transform = 'rotateY(0deg) rotateX(0deg)';
  overlay.classList.add('open');

  let isDragging = false;
  let startX = 0, startY = 0, rotX = 0, rotY = 0;
  const scene = document.getElementById('card-viewer-scene');

  function applyRotation(dx, dy) {
    rotY = Math.max(-35, Math.min(35, rotY + dx * 0.4));
    rotX = Math.max(-25, Math.min(25, rotX - dy * 0.4));
    inner.style.transform = `rotateY(${rotY}deg) rotateX(${rotX}deg)`;
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
    const img    = c.image ? c.image + '/high.webp' : '';
    const name   = (currentLang === 'en' && c.nameEn) ? c.nameEn : (c.name || '—');
    const set    = c.set?.name || '';
    const rarity = c.rarity || '';
    const num    = c.localId || '';
    const illus  = c.illustrator || '';
    const ownedLabel  = ownedSet.has(c.id)  ? getPriceLabel(c.id, 'owned')  : '';
    const wantedLabel = wantedSet.has(c.id) ? getPriceLabel(c.id, 'wanted') : '';
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
        <div class="name">${name}</div>
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
  return JSON.stringify({
    app: 'pikidex', version: 1, exportedAt: new Date().toISOString(),
    owned: [...ownedSet], wanted: [...wantedSet], trade: [...tradeSet],
    prices: pricesMap, prefs, masters: startedMasters, presets: filterPresets, tags: tagsMap,
  }, null, 2);
}

function openConfig()  { document.getElementById('config-overlay').classList.add('open'); }
function closeConfig() { document.getElementById('config-overlay').classList.remove('open'); }

function applyImportedConfig(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { showToast('⚠ JSON invalide', 'info'); return; }
  if (!data || typeof data !== 'object') { showToast('⚠ Format non reconnu', 'info'); return; }

  const prevLang = currentLang;
  if (Array.isArray(data.owned))  { ownedSet  = new Set(data.owned);  saveOwned(); }
  if (Array.isArray(data.wanted)) { wantedSet = new Set(data.wanted); saveWanted(); }
  if (Array.isArray(data.trade))  { tradeSet  = new Set(data.trade);  saveTrade(); }
  if (data.prices && typeof data.prices === 'object') { pricesMap = data.prices; savePrices(); }
  if (Array.isArray(data.masters)) { startedMasters = data.masters; saveMasters(); }
  if (Array.isArray(data.presets)) { filterPresets = data.presets; savePresetsLS(); populatePresetSelect('explore'); populatePresetSelect('collection'); }
  if (data.tags && typeof data.tags === 'object' && !Array.isArray(data.tags)) { tagsMap = data.tags; saveTags(); refreshTagFilters(); }
  if (data.prefs && typeof data.prefs === 'object') {
    prefs = { ...defaultPrefs, ...data.prefs };
    // Compat masterRarityExcludes
    if (!prefs.masterRarityExcludes || typeof prefs.masterRarityExcludes !== 'object') {
      prefs.masterRarityExcludes = { set: [], artist: [] };
    }
    savePrefs();
    currentLang   = prefs.lang || 'fr';
    pricesVisible = prefs.pricesVisible !== false;
    S.explore.sort    = prefs.sort || 'pokedex';
    S.collection.sort = prefs.collSort || 'pokedex';
  }

  closeConfig();
  showToast('✓ Configuration importée');

  applyPricesVisible();
  document.getElementById('btn-hide-prices').classList.toggle('active', pricesVisible);

  if (currentLang !== prevLang) {
    API = API_BASE + '/' + currentLang;
    RARITY_LABELS = RARITY_LABELS_BY_LANG[currentLang];
    document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === currentLang));
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

// 8) Langue.
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.lang === currentLang);
  btn.addEventListener('click', () => {
    if (btn.dataset.lang === currentLang) return;
    currentLang = btn.dataset.lang;
    API = API_BASE + '/' + currentLang;
    RARITY_LABELS = RARITY_LABELS_BY_LANG[currentLang];
    prefs.lang = currentLang;
    savePrefs();
    document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === currentLang));
    allCards = [];
    fetchCards();
  });
});

// 9) Onglets principaux.
function setActiveTab(tab) {
  currentTab = tab;
  prefs.tab = currentTab;
  savePrefs();
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === currentTab));
  document.getElementById('explore-view').classList.toggle('hidden', currentTab !== 'explore');
  document.getElementById('collection-view').classList.toggle('active', currentTab === 'collection');
  document.getElementById('master-view').classList.toggle('active', currentTab === 'master');
  document.getElementById('echange-view').classList.toggle('active', currentTab === 'echange');
  document.getElementById('explore-controls').style.display = currentTab === 'explore' ? '' : 'none';
  if (currentTab !== 'collection' && selectionMode) setSelectionMode(false);
  if (currentTab === 'collection') { populateFilters('collection'); renderCollection(); }
  if (currentTab === 'master') { masterSelected = null; renderMaster(); }
  if (currentTab === 'echange') renderEchange();
}
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => setActiveTab(tab.dataset.view));
});

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

// 12) Import / export de la collection (JSON).
document.getElementById('btn-config').addEventListener('click', () => {
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
fetchCards().then(() => {
  if (location.hash.startsWith('#share=')) { handleShareLink(); return; }
  handleDeepLink();
  if (prefs.tab && prefs.tab !== 'explore') setActiveTab(prefs.tab);
});

updateCollStat();