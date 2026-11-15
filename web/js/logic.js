// Logika domenowa: terminy, płatności cykliczne, harmonogram, kalendarz .ics
import { store } from './store.js';
import { CYKLE, addMonths, today, daysUntil, round2, fmtMonth, uid } from './util.js';

export const months = (p) => CYKLE[p.cykl]?.m || 0;

/** Kolejny termin po zapłacie; '' gdy jednorazowa. */
export function nextTermin(p) {
  const m = months(p);
  return m ? addMonths(p.termin, m) : '';
}

/** Oznacza pozycję jako zapłaconą: wpis do historii + przesunięcie terminu. Zwraca funkcję cofającą. */
export function markPaid(p, { data = today(), kwota = p.kwota, uwagi = '', auto = 0 } = {}) {
  const before = { ...p };
  const histId = `${p.id}-${p.termin || data}`;
  store.upsert('historia', {
    id: histId, platnoscId: p.id, nazwa: p.nazwa, grupa: p.grupa, termin: p.termin,
    dataZaplaty: data, kwota, auto, uwagi,
  }, { silent: true });
  const nt = nextTermin(p);
  const patch = { ...p };
  if (!nt) patch.aktywna = 0;
  else {
    patch.termin = nt;
    if (p.koniec && nt > p.koniec) patch.aktywna = 0;
  }
  store.upsert('platnosci', patch);
  return () => {
    store.remove('historia', histId);
    store.upsert('platnosci', before);
  };
}

/** Płatności automatyczne (polecenie zapłaty, subskrypcje) – przesuń termin po jego upływie. */
export function rollAutomatic() {
  if (!store.settings.autoPrzesuwaj) return 0;
  const t = today();
  let n = 0;
  for (const p0 of store.all('platnosci')) {
    let p = { ...p0 };
    if (p.sposob !== 'auto' || !p.aktywna || !p.termin || !months(p)) continue;
    let guard = 0;
    while (p.aktywna && p.termin < t && guard++ < 60) {
      store.upsert('historia', {
        id: `${p.id}-${p.termin}`, platnoscId: p.id, nazwa: p.nazwa, grupa: p.grupa, termin: p.termin,
        dataZaplaty: p.termin, kwota: p.kwota, auto: 1, uwagi: 'płatność automatyczna',
      }, { silent: true });
      const nt = nextTermin(p);
      p = { ...p, termin: nt, aktywna: p.koniec && nt > p.koniec ? 0 : 1 };
      n++;
    }
    if (p.termin !== p0.termin) store.upsert('platnosci', p, { silent: true });
  }
  if (n) store.changed();
  return n;
}

/** Miesięczny koszt stały (średnio) – suma kwota/cykl dla aktywnych opłat cyklicznych. */
export function monthlyCost(grupa) {
  let s = 0;
  for (const p of store.all('platnosci')) {
    if (!p.aktywna || p.typ === 'zadanie' || !p.kwota || !months(p)) continue;
    if (grupa && p.grupa !== grupa) continue;
    s += p.kwota / months(p);
  }
  return round2(s);
}

export const groups = () => [...new Set(store.all('platnosci').map((p) => p.grupa).filter(Boolean))];

/**
 * Wszystkie zbliżające się/zaległe zobowiązania z różnych modułów – do pulpitu i przypomnień.
 * Zwraca [{key, kind, title, sub, date, amount, days, ref}]
 */
export function agenda(horizonDays = 45) {
  const t = today();
  const items = [];
  for (const p of store.all('platnosci')) {
    if (!p.aktywna || !p.termin) continue;
    const d = daysUntil(p.termin, t);
    if (d > horizonDays) continue;
    items.push({ key: 'p:' + p.id, kind: p.typ === 'zadanie' ? 'zadanie' : 'platnosc', title: p.nazwa, sub: p.grupa,
      date: p.termin, amount: p.kwota, days: d, auto: p.sposob === 'auto', ref: p });
  }
  for (const n of store.all('najem')) {
    if (n.terminUS && !n.zaplaconoUS && n.podatek) {
      const d = daysUntil(n.terminUS, t);
      if (d <= horizonDays) items.push({ key: 'us:' + n.id, kind: 'podatek', title: `Podatek od najmu (ryczałt) – ${fmtMonth(n.okres)}`,
        sub: n.lokal, date: n.terminUS, amount: n.podatek, days: d, ref: n });
    }
    if (n.terminPlatnosci && !n.zaplacono) {
      const d = daysUntil(n.terminPlatnosci, t);
      if (d <= horizonDays) items.push({ key: 'nj:' + n.id, kind: 'wplyw', title: `Czynsz od najemcy – ${fmtMonth(n.okres)}`,
        sub: n.lokal, date: n.terminPlatnosci, amount: round2((n.czynsz || 0) + (n.garaz || 0)), days: d, ref: n });
    }
  }
  for (const w of store.all('wspoldzielone')) {
    if (w.status === 'do_zaplaty' && w.od) {
      const d = daysUntil(w.od, t);
      items.push({ key: 'w:' + w.id, kind: 'wplyw', title: `${w.usluga} – składka: ${w.osoba}`, sub: 'Współdzielone',
        date: w.od, amount: w.kwota, days: d, ref: w });
    } else if (w.do && w.status !== 'wlasciciel') {
      const d = daysUntil(w.do, t);
      if (d <= 30) items.push({ key: 'wk:' + w.id, kind: 'info', title: `${w.usluga} – koniec okresu: ${w.osoba}`, sub: 'Współdzielone',
        date: w.do, amount: w.kwota, days: d, ref: w });
    }
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Harmonogram: projekcja wystąpień płatności cyklicznych na N miesięcy do przodu. */
export function schedule(monthsAhead = 12) {
  const t = today();
  const end = addMonths(t.slice(0, 7) + '-01', monthsAhead);
  const out = [];
  for (const p of store.all('platnosci')) {
    if (!p.aktywna || !p.termin) continue;
    let d = p.termin;
    let guard = 0;
    while (d && d < end && guard++ < 400) {
      if (p.koniec && d > p.koniec) break;
      out.push({ p, date: d });
      const m = months(p);
      if (!m) break;
      d = addMonths(d, m);
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  const byMonth = new Map();
  for (const o of out) {
    const k = o.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(o);
  }
  return byMonth;
}

/** Plik iCalendar z przypomnieniami (wydarzenia cykliczne). */
export function buildIcs(daysBefore = 3) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Oplaty i terminy//PL', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:Opłaty i terminy'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const ymd = (iso) => iso.replace(/-/g, '');
  const escTxt = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  for (const p of store.all('platnosci')) {
    if (!p.aktywna || !p.termin) continue;
    const kw = p.kwota ? ` – ${p.kwota.toFixed(2).replace('.', ',')} zł` : '';
    const desc = [p.grupa, p.sposob === 'auto' ? `płatność automatyczna (${p.konto})` : p.konto, p.odbiorca, p.rachunek && `rachunek: ${p.rachunek}`, p.uwagi]
      .filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${p.id}@oplaty-app`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(p.termin)}`, `DTEND;VALUE=DATE:${ymd(nextDay(p.termin))}`,
      `SUMMARY:${escTxt((p.typ === 'zadanie' ? '📋 ' : '💳 ') + p.nazwa + kw)}`, `DESCRIPTION:${escTxt(desc)}`);
    const m = months(p);
    if (m) lines.push(`RRULE:FREQ=MONTHLY;INTERVAL=${m}${p.koniec ? `;UNTIL=${ymd(p.koniec)}` : ''}`);
    if (daysBefore >= 0 && p.sposob !== 'auto') {
      // przypomnienie ok. 9:00, N dni przed terminem (wydarzenie całodniowe zaczyna się o 0:00)
      const trig = daysBefore === 0 ? 'PT9H' : `-P${daysBefore - 1}DT15H`;
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escTxt(p.nazwa)}`, `TRIGGER:${trig}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function nextDay(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

/** Najem: kolejny miesiąc na podstawie ostatniego. */
export function nextRentRow(lokal) {
  const rows = store.all('najem').filter((r) => r.lokal === lokal).sort((a, b) => (a.okres < b.okres ? -1 : 1));
  const last = rows[rows.length - 1];
  const okres = last ? addMonths(last.okres + '-01', 1).slice(0, 7) : today().slice(0, 7);
  const stawka = (store.settings.stawkaNajem || 8.5) / 100;
  const czynsz = last?.czynsz ?? null;
  return {
    id: uid(), lokal, okres, czynsz, garaz: last?.garaz ?? null, wspolnota: last?.wspolnota ?? null,
    prad: last?.prad ?? null, internet: last?.internet ?? null, terminPlatnosci: `${okres}-10`, zaplacono: '',
    podatek: czynsz ? round2(czynsz * stawka) : null, terminUS: `${addMonths(okres + '-01', 1).slice(0, 7)}-20`, zaplaconoUS: '', uwagi: '',
  };
}
