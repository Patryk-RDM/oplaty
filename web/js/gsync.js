// Synchronizacja z Arkuszem Google przechowywanym na Twoim Dysku Google.
// Uprawnienie drive.file: aplikacja widzi WYŁĄCZNIE pliki, które sama utworzyła.
import { store, SCHEMA, TABLES, normalize, mergeData } from './store.js';
import { nowIso } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'oplaty.token.v1';
const FILE_NAME = 'Opłaty i terminy – baza aplikacji';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

class AuthError extends Error {}

class GSync extends EventTarget {
  constructor() {
    super();
    this.status = 'idle'; // idle | syncing | ok | error | auth
    this.message = '';
    this.token = null;
    this.tokenClient = null;
    this.running = null;
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (t && t.exp > Date.now() + 60000) this.token = t;
    } catch { /* brak */ }
  }

  get clientId() {
    return (store.settings.clientId || window.APP_CONFIG?.googleClientId || '').trim();
  }

  get configured() {
    return !!this.clientId;
  }

  get hasToken() {
    return !!(this.token && this.token.exp > Date.now() + 60000);
  }

  setStatus(status, message = '') {
    this.status = status;
    this.message = message;
    this.dispatchEvent(new Event('status'));
  }

  loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this._gis) return this._gis;
    this._gis = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => res();
      s.onerror = () => { this._gis = null; rej(new Error('Nie można wczytać logowania Google (brak internetu?)')); };
      document.head.appendChild(s);
    });
    return this._gis;
  }

  /** Logowanie interaktywne – wywoływać z kliknięcia użytkownika. */
  async login() {
    if (!this.configured) throw new Error('Brak identyfikatora klienta Google (Ustawienia).');
    await this.loadGis();
    return new Promise((resolve, reject) => {
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          this.token = { access: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
          localStorage.setItem(TOKEN_KEY, JSON.stringify(this.token));
          resolve();
        },
        error_callback: (err) => reject(new Error(err?.message || err?.type || 'Logowanie przerwane')),
      });
      this.tokenClient.requestAccessToken({ prompt: store.meta.loggedOnce ? '' : 'consent' });
    }).then(() => {
      store.saveMeta({ loggedOnce: true });
      this.setStatus('idle');
    });
  }

  logout() {
    if (this.token && window.google?.accounts?.oauth2) {
      try { google.accounts.oauth2.revoke(this.token.access, () => {}); } catch { /* ignoruj */ }
    }
    this.token = null;
    localStorage.removeItem(TOKEN_KEY);
    this.setStatus('auth', 'Wylogowano');
  }

  async api(method, url, body) {
    if (!this.hasToken) throw new AuthError('Sesja Google wygasła – zaloguj się ponownie.');
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token.access}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      this.token = null;
      localStorage.removeItem(TOKEN_KEY);
      throw new AuthError('Sesja Google wygasła – zaloguj się ponownie.');
    }
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg = (await r.json()).error?.message || msg; } catch { /* brak */ }
      const e = new Error(`Google API: ${msg}`);
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? null : r.json();
  }

  /** Znajduje arkusz aplikacji na Dysku albo tworzy nowy. */
  async ensureSpreadsheet() {
    let id = store.meta.spreadsheetId;
    if (id) {
      try {
        const f = await this.api('GET', `${DRIVE}/files/${id}?fields=id,trashed`);
        if (f.trashed) id = '';
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (e.status === 404) id = ''; else throw e;
      }
    }
    if (!id) {
      const q = encodeURIComponent("appProperties has { key='oplatyApp' and value='1' } and trashed=false");
      const res = await this.api('GET', `${DRIVE}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name)&spaces=drive`);
      id = res.files?.[0]?.id || '';
    }
    let fresh = false;
    if (!id) {
      const f = await this.api('POST', `${DRIVE}/files?fields=id`, {
        name: FILE_NAME,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        appProperties: { oplatyApp: '1' },
        description: 'Baza danych aplikacji „Opłaty i terminy”. Możesz ją przeglądać i poprawiać ręcznie – nie zmieniaj nagłówków (wiersz 1).',
      });
      id = f.id;
      fresh = true;
    }
    store.saveMeta({ spreadsheetId: id });
    await this.ensureSheets(id, fresh);
    return id;
  }

  async ensureSheets(id, fresh) {
    const ss = await this.api('GET', `${SHEETS}/${id}?fields=sheets.properties(sheetId,title)`);
    const existing = ss.sheets.map((s) => s.properties);
    const titles = new Set(existing.map((p) => p.title));
    const requests = [];
    for (const t of TABLES) {
      const title = SCHEMA[t].sheet;
      if (!titles.has(title)) {
        requests.push({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } });
      }
    }
    if (fresh) {
      const ours = new Set(TABLES.map((t) => SCHEMA[t].sheet));
      for (const p of existing) if (!ours.has(p.title)) requests.push({ deleteSheet: { sheetId: p.sheetId } });
    }
    if (requests.length) await this.api('POST', `${SHEETS}/${id}:batchUpdate`, { requests });
  }

  async readRemote(id) {
    const ranges = TABLES.map((t) => `ranges=${encodeURIComponent(SCHEMA[t].sheet)}`).join('&');
    const res = await this.api('GET',
      `${SHEETS}/${id}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
    const out = {};
    TABLES.forEach((t, i) => {
      const rows = res.valueRanges?.[i]?.values || [];
      const header = (rows[0] || []).map((h) => String(h).trim());
      out[t] = rows.slice(1)
        .filter((r) => r.some((c) => c !== '' && c !== null))
        .map((r) => normalize(t, Object.fromEntries(header.map((h, j) => [h, r[j] ?? '']))));
    });
    return out;
  }

  async writeRemote(id, data) {
    const ranges = TABLES.map((t) => SCHEMA[t].sheet);
    await this.api('POST', `${SHEETS}/${id}/values:batchClear`, { ranges });
    await this.api('POST', `${SHEETS}/${id}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: TABLES.map((t) => {
        const cols = SCHEMA[t].cols.map((c) => c[0]);
        const rows = data[t].map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c])));
        return { range: `${SCHEMA[t].sheet}!A1`, values: [cols, ...rows] };
      }),
    });
  }

  /** Pełna synchronizacja: pobierz → scal → zapisz w obu miejscach. */
  sync({ interactive = false } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      if (!this.configured) { this.setStatus('idle', 'Tryb lokalny'); return false; }
      try {
        if (!this.hasToken) {
          if (!interactive) { this.setStatus('auth', 'Zaloguj się, aby zsynchronizować'); return false; }
          await this.login();
        }
        this.setStatus('syncing', 'Synchronizuję…');
        const id = await this.ensureSpreadsheet();
        const startRev = store.rev;
        const remote = await this.readRemote(id);
        const merged = mergeData(store.data, remote);
        const sig = (d) => JSON.stringify(TABLES.map((t) => [...d[t]].sort((a, b) => (a.id < b.id ? -1 : 1))));
        if (sig(merged) !== sig(remote)) await this.writeRemote(id, merged);
        store.saveMeta({ lastSync: nowIso() });
        if (store.rev !== startRev) {
          // w trakcie synchronizacji wprowadzono zmiany – zachowaj je i zsynchronizuj ponownie
          store.replaceAll(mergeData(merged, store.data), { dirty: true });
          setTimeout(() => this.sync(), 1500);
        } else if (sig(merged) !== sig(store.data)) {
          store.replaceAll(merged, { dirty: false });
        } else {
          store.saveMeta({ dirty: false });
        }
        this.setStatus('ok', 'Zsynchronizowano');
        return true;
      } catch (e) {
        console.error(e);
        if (e instanceof AuthError) this.setStatus('auth', e.message);
        else this.setStatus('error', e.message || String(e));
        return false;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  get sheetUrl() {
    return store.meta.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${store.meta.spreadsheetId}/edit` : '';
  }
}

export const gsync = new GSync();
