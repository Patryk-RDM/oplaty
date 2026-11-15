// Lokalny magazyn danych (localStorage) + scalanie rekordów
import { nowIso, parseDate, parseMonth, parseNum, uid } from './util.js';

// Typy kolumn: s – tekst, n – liczba, d – data, m – miesiąc (YYYY-MM), i – liczba całkowita/flaga
export const SCHEMA = {
  platnosci: {
    sheet: 'Platnosci',
    cols: [['id', 's'], ['grupa', 's'], ['nazwa', 's'], ['typ', 's'], ['kwota', 'n'], ['termin', 'd'], ['cykl', 's'],
      ['sposob', 's'], ['konto', 's'], ['odbiorca', 's'], ['rachunek', 's'], ['uwagi', 's'], ['koniec', 'd'],
      ['aktywna', 'i'], ['zm', 's'], ['usuniety', 'i']],
  },
  historia: {
    sheet: 'Historia',
    cols: [['id', 's'], ['platnoscId', 's'], ['nazwa', 's'], ['grupa', 's'], ['termin', 'd'], ['dataZaplaty', 'd'],
      ['kwota', 'n'], ['auto', 'i'], ['uwagi', 's'], ['zm', 's'], ['usuniety', 'i']],
  },
  wspoldzielone: {
    sheet: 'Wspoldzielone',
    cols: [['id', 's'], ['usluga', 's'], ['osoba', 's'], ['od', 'd'], ['do', 'd'], ['kwota', 'n'], ['status', 's'],
      ['uwagi', 's'], ['zm', 's'], ['usuniety', 'i']],
  },
  najem: {
    sheet: 'Najem',
    cols: [['id', 's'], ['lokal', 's'], ['okres', 'm'], ['czynsz', 'n'], ['garaz', 'n'], ['wspolnota', 'n'], ['prad', 'n'],
      ['internet', 'n'], ['terminPlatnosci', 'd'], ['zaplacono', 'd'], ['podatek', 'n'], ['terminUS', 'd'],
      ['zaplaconoUS', 'd'], ['uwagi', 's'], ['zm', 's'], ['usuniety', 'i']],
  },
  najemcy: {
    sheet: 'Najemcy',
    cols: [['id', 's'], ['lokal', 's'], ['nr', 'i'], ['osoby', 's'], ['umowaOd', 'd'], ['umowaDo', 'd'], ['kaucja', 'n'],
      ['uwagi', 's'], ['zm', 's'], ['usuniety', 'i']],
  },
};
export const TABLES = Object.keys(SCHEMA);

const KEY = 'oplaty.dane.v1';
const META_KEY = 'oplaty.meta.v1';
const SET_KEY = 'oplaty.ustawienia.v1';

const emptyData = () => Object.fromEntries(TABLES.map((t) => [t, []]));

/** Ujednolica rekord do schematu (typy kolumn). */
export function normalize(table, rec) {
  const out = {};
  for (const [k, t] of SCHEMA[table].cols) {
    let v = rec[k];
    if (t === 'n') v = parseNum(v);
    else if (t === 'd') v = parseDate(v);
    else if (t === 'm') v = parseMonth(v);
    else if (t === 'i') v = v === '' || v === null || v === undefined ? (k === 'aktywna' ? 1 : 0) : Number(v) || 0;
    else v = v === null || v === undefined ? '' : String(v);
    out[k] = v;
  }
  if (!out.id) out.id = uid();
  if (!out.zm) out.zm = '1970-01-01T00:00:00.000Z';
  return out;
}

class Store extends EventTarget {
  constructor() {
    super();
    this.data = emptyData();
    this.rev = 0;
    this.meta = { spreadsheetId: '', lastSync: '', dirty: false };
    this.settings = { autoPrzesuwaj: true, stawkaNajem: 8.5, dniPrzypomnienia: 3, powiadomienia: false, clientId: '' };
    this.load();
  }

  load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d) for (const t of TABLES) this.data[t] = (d[t] || []).map((r) => normalize(t, r));
      Object.assign(this.meta, JSON.parse(localStorage.getItem(META_KEY) || '{}'));
      Object.assign(this.settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}'));
    } catch (e) {
      console.error('Błąd odczytu danych lokalnych', e);
    }
  }

  persist() {
    localStorage.setItem(KEY, JSON.stringify(this.data));
    localStorage.setItem(META_KEY, JSON.stringify(this.meta));
  }

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    localStorage.setItem(SET_KEY, JSON.stringify(this.settings));
    this.dispatchEvent(new Event('settings'));
  }

  saveMeta(patch) {
    Object.assign(this.meta, patch);
    localStorage.setItem(META_KEY, JSON.stringify(this.meta));
  }

  /** Rekordy nieusunięte. */
  all(table) {
    return this.data[table].filter((r) => !r.usuniety);
  }

  get(table, id) {
    return this.data[table].find((r) => r.id === id && !r.usuniety);
  }

  isEmpty() {
    return TABLES.every((t) => this.all(t).length === 0);
  }

  /** Wstawia lub aktualizuje rekordy; ustawia znacznik zmiany. */
  upsert(table, recs, { silent = false } = {}) {
    const list = Array.isArray(recs) ? recs : [recs];
    const ts = nowIso();
    for (const r of list) {
      const n = normalize(table, { ...r, zm: ts });
      const i = this.data[table].findIndex((x) => x.id === n.id);
      if (i >= 0) this.data[table][i] = n;
      else this.data[table].push(n);
    }
    this.meta.dirty = true;
    this.rev = (this.rev || 0) + 1;
    this.persist();
    if (!silent) this.changed();
    return list.length === 1 ? this.data[table].find((x) => x.id === list[0].id) : null;
  }

  remove(table, id) {
    const r = this.data[table].find((x) => x.id === id);
    if (!r) return;
    this.upsert(table, { ...r, usuniety: 1 });
  }

  changed(source = 'local') {
    this.dispatchEvent(new CustomEvent('change', { detail: { source } }));
  }

  /** Zastępuje dane (np. po synchronizacji). */
  replaceAll(data, { dirty = false } = {}) {
    for (const t of TABLES) this.data[t] = (data[t] || []).map((r) => normalize(t, r));
    this.meta.dirty = dirty;
    this.persist();
    this.changed('sync');
  }

  /** Import z pliku JSON. mode: 'merge' (dodaj/aktualizuj) albo 'replace'. */
  importJson(obj, mode = 'merge') {
    if (!obj || typeof obj !== 'object') throw new Error('Nieprawidłowy plik');
    const ts = nowIso();
    const next = mode === 'replace'
      ? Object.fromEntries(TABLES.map((t) => [t, this.data[t].map((r) => ({ ...r, usuniety: 1, zm: ts }))]))
      : structuredClone(this.data);
    let count = 0;
    for (const t of TABLES) {
      for (const raw of obj[t] || []) {
        const n = normalize(t, { ...raw, zm: ts });
        const i = next[t].findIndex((x) => x.id === n.id);
        if (i >= 0) next[t][i] = n;
        else next[t].push(n);
        count++;
      }
    }
    this.rev = (this.rev || 0) + 1;
    this.replaceAll(next, { dirty: true });
    this.changed('local');
    return count;
  }

  exportJson() {
    const out = { format: 'oplaty-app', wersja: 1, eksport: nowIso() };
    for (const t of TABLES) out[t] = this.all(t);
    return out;
  }
}

/**
 * Scalanie rekord po rekordzie: wygrywa nowsza zmiana (pole `zm`).
 * Przy remisie wygrywa wersja zdalna (ręczne poprawki w Arkuszu Google).
 */
export function mergeData(local, remote) {
  const out = {};
  for (const t of TABLES) {
    const map = new Map();
    for (const r of local[t] || []) map.set(r.id, r);
    for (const r of remote[t] || []) {
      const l = map.get(r.id);
      if (!l || (r.zm || '') >= (l.zm || '')) map.set(r.id, r);
    }
    // usuń bardzo stare "nagrobki" (usunięte > 180 dni temu)
    const cutoff = new Date(Date.now() - 180 * 86400000).toISOString();
    out[t] = [...map.values()].filter((r) => !(r.usuniety && r.zm < cutoff));
  }
  return out;
}

export const store = new Store();
