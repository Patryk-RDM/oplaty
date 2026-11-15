// Narzędzia: daty, kwoty, escapowanie, identyfikatory
export const CYKLE = {
  M1: { label: 'co miesiąc', m: 1 },
  M2: { label: 'co 2 miesiące', m: 2 },
  M3: { label: 'co kwartał', m: 3 },
  M6: { label: 'co pół roku', m: 6 },
  M12: { label: 'co rok', m: 12 },
  M24: { label: 'co 2 lata', m: 24 },
  JEDN: { label: 'jednorazowo', m: 0 },
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16);

export const nowIso = () => new Date().toISOString();

const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoOf(new Date());

/** Akceptuje: 2026-12-01, 01.12.2026, 1.12.2026, liczbę seryjną Arkuszy/Excela, Date. Zwraca 'YYYY-MM-DD' lub ''. */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return isoOf(v);
  if (typeof v === 'number' && isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400000); // epoka 1899-12-30
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  if (/^\d+(\.\d+)?$/.test(s)) return parseDate(Number(s));
  return '';
}

/** Okres miesięczny 'YYYY-MM' z różnych postaci. */
export function parseMonth(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(+m[2])}`;
  m = s.match(/^(\d{1,2})[./](\d{4})$/);
  if (m) return `${m[2]}-${pad(+m[1])}`;
  const d = parseDate(v);
  return d ? d.slice(0, 7) : '';
}

export function parseNum(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/\s|zł/g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) && s !== '' ? n : null;
}

export function addMonths(iso, n) {
  if (!iso) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(y, m - 1 + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d, last));
  return isoOf(t);
}

export function daysUntil(iso, from = today()) {
  if (!iso) return null;
  const a = new Date(from + 'T00:00:00');
  const b = new Date(iso + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

export const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '—');

const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
export const fmtMonth = (ym) => (ym ? `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}` : '—');

const money = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', minimumFractionDigits: 2 });
export const fmtMoney = (n) => (n === null || n === undefined || n === '' ? '—' : money.format(n));

export function relDays(n) {
  if (n === null) return '';
  if (n === 0) return 'dziś';
  if (n === 1) return 'jutro';
  if (n === -1) return 'wczoraj';
  if (n < 0) return `${-n} dni po terminie`;
  return `za ${n} dni`;
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
