// Interfejs aplikacji „Opłaty i terminy”
import { store } from './store.js';
import { gsync } from './gsync.js';
import { markPaid, rollAutomatic, monthlyCost, groups, agenda, schedule, buildIcs, nextRentRow, months } from './logic.js';
import {
  CYKLE, esc, uid, today, fmtDate, fmtMonth, fmtMoney, relDays, daysUntil, parseNum, round2, debounce, addMonths,
} from './util.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const dlg = $('#dlg');
const form = $('#dlgForm');
const fab = $('#fab');

const ui = { grupa: '', q: '', showOff: false, lokal: '', current: 'pulpit', apk: null };
const isAndroid = /Android/i.test(navigator.userAgent);
const isApp = document.referrer.startsWith('android-app://') || sessionStorage.getItem('oplaty.twa') === '1'
  || matchMedia('(display-mode: standalone)').matches;
if (document.referrer.startsWith('android-app://')) sessionStorage.setItem('oplaty.twa', '1');

const TITLES = {
  pulpit: 'Pulpit', platnosci: 'Płatności', harmonogram: 'Harmonogram', wspoldzielone: 'Współdzielone subskrypcje',
  najem: 'Najem', ustawienia: 'Ustawienia',
};
const MON = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const STATUS_W = { zaplacono: ['zapłacono', 'green'], do_zaplaty: ['do zapłaty', 'amber'], wlasciciel: ['właściciel konta', 'acc'] };

// ---------------------------------------------------------------- pomocnicze UI
function urgency(days) {
  if (days === null) return '';
  if (days < 0) return 'red';
  if (days <= 7) return 'amber';
  return '';
}

function dateBox(iso, days) {
  if (!iso) return '<div class="datebox"><b>—</b><small>&nbsp;</small></div>';
  const [, m, d] = iso.split('-');
  return `<div class="datebox ${urgency(days)}"><b>${+d}</b><small>${MON[+m - 1]}</small></div>`;
}

let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Cofnij</button>' : ''}`;
  if (undo) t.querySelector('button').onclick = () => { undo(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), undo ? 6000 : 3000);
}

/** Okno dialogowe z formularzem. handler(akcja, dane, form) – zwróć false, by nie zamykać. */
function dialog(title, body, buttons, handler) {
  form.innerHTML = `<div class="dh"><h3>${esc(title)}</h3><button type="button" class="x" data-close aria-label="Zamknij">×</button></div>
    <div class="db">${body}</div><div class="df">${buttons}</div>`;
  form.onsubmit = (e) => {
    e.preventDefault();
    const act = e.submitter?.value || 'ok';
    const fd = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      fd[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
    }
    if (handler(act, fd, form) !== false) dlg.close();
  };
  form.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => dlg.close()));
  if (!dlg.open) dlg.showModal();
  const first = form.querySelector('.db input:not([type=hidden]), .db select');
  if (first && matchMedia('(min-width: 900px)').matches) first.focus();
}

const field = (label, html, cls = '') => `<label class="f ${cls}"><span>${esc(label)}</span>${html}</label>`;
const inp = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
const sel = (name, value, opts) =>
  `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const confirmBox = (title, text, okLabel, fn) =>
  dialog(title, `<p>${text}</p>`, `<button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="ok">${esc(okLabel)}</button>`,
    () => fn());

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- widoki
function vPulpit() {
  if (store.isEmpty()) {
    return `<div class="card hello">
      <h2>Witaj 👋</h2>
      <p>Brak danych na tym urządzeniu. Jeśli używasz już aplikacji na innym urządzeniu – zaloguj się do Google, a dane pobiorą się z Twojego Dysku.
      Przy pierwszym uruchomieniu zaimportuj plik <b>dane-startowe.json</b>.</p>
      <div class="toolbar">
        ${gsync.configured ? '<button class="btn primary" data-act="sync">Zaloguj przez Google</button>' : '<a class="btn primary" href="#/ustawienia">Skonfiguruj Google</a>'}
        <button class="btn" data-act="import">Importuj plik JSON</button>
        <button class="btn" data-act="new-p">Dodaj płatność</button>
      </div></div>`;
  }
  const ag = agenda(45);
  const money = ag.filter((i) => i.kind === 'platnosc' || i.kind === 'podatek');
  const sum = (arr) => round2(arr.reduce((s, i) => s + (i.amount || 0), 0));
  const overdue = money.filter((i) => i.days < 0 && !i.auto);
  const in7 = money.filter((i) => i.days >= 0 && i.days <= 7);
  const in30 = money.filter((i) => i.days >= 0 && i.days <= 30);
  const byGroup = groups().map((g) => [g, monthlyCost(g)]).filter(([, v]) => v > 0);

  return `${apkBanner()}
  <div class="stats">
    <div class="card stat ${overdue.length ? 'red' : ''}"><div class="lbl">Zaległe</div><div class="val">${overdue.length}</div><div class="sub">${fmtMoney(sum(overdue))}</div></div>
    <div class="card stat ${in7.length ? 'amber' : ''}"><div class="lbl">Najbliższe 7 dni</div><div class="val">${fmtMoney(sum(in7))}</div><div class="sub">${in7.length} poz.</div></div>
    <div class="card stat"><div class="lbl">Najbliższe 30 dni</div><div class="val">${fmtMoney(sum(in30))}</div><div class="sub">${in30.length} poz.</div></div>
    <div class="card stat"><div class="lbl">Koszt stały / mies.</div><div class="val">${fmtMoney(monthlyCost())}</div><div class="sub">średnio, wszystkie grupy</div></div>
  </div>
  <div class="section"><h2>Zaległe i najbliższe 45 dni</h2><a class="small" href="#/harmonogram">harmonogram 12 mies. →</a></div>
  <div class="card">${ag.length ? `<ul class="list">${ag.map(agendaRow).join('')}</ul>` : '<div class="empty">Nic do zapłacenia w najbliższym czasie 🎉</div>'}</div>
  ${byGroup.length ? `<div class="section"><h2>Koszt stały wg grup (średnio / mies.)</h2></div>
  <div class="card"><ul class="list">${byGroup.map(([g, v]) => `<li class="row" data-act="filter-group" data-id="${esc(g)}"><div class="body"><div class="t">${esc(g)}</div></div><div class="r amt">${fmtMoney(v)}</div></li>`).join('')}</ul></div>` : ''}`;
}

function agendaRow(i) {
  const pills = [];
  if (i.auto) pills.push('<span class="pill blue">auto</span>');
  if (i.kind === 'zadanie') pills.push('<span class="pill">zadanie</span>');
  if (i.kind === 'podatek') pills.push('<span class="pill amber">US</span>');
  if (i.kind === 'wplyw') pills.push('<span class="pill green">wpływ</span>');
  const canCheck = i.kind !== 'info';
  return `<li class="row" data-act="open-agenda" data-id="${esc(i.key)}">
    ${dateBox(i.date, i.auto && i.days < 0 ? 0 : i.days)}
    <div class="body"><div class="t">${esc(i.title)}</div>
      <div class="s">${esc(i.sub)} · ${relDays(i.days)} ${pills.join(' ')}</div></div>
    <div class="r amt">${i.amount !== null && i.amount !== undefined ? fmtMoney(i.amount) : '—'}</div>
    ${canCheck ? `<button class="check" type="button" data-act="done-agenda" data-id="${esc(i.key)}" title="Oznacz jako zrobione">✓</button>` : ''}
  </li>`;
}

function vPlatnosci() {
  const gs = groups();
  return `
  <div class="toolbar">
    <div class="chips">
      <button class="chip ${ui.grupa ? '' : 'on'}" data-act="chip" data-id="">Wszystkie</button>
      ${gs.map((g) => `<button class="chip ${ui.grupa === g ? 'on' : ''}" data-act="chip" data-id="${esc(g)}">${esc(g)}</button>`).join('')}
    </div>
  </div>
  <div class="toolbar">
    <input type="search" class="search" id="q" placeholder="Szukaj…" value="${esc(ui.q)}">
    <label class="inline small"><input type="checkbox" id="showOff" ${ui.showOff ? 'checked' : ''}> zakończone</label>
    <a class="btn sm" href="#/harmonogram">Harmonogram</a>
  </div>
  <div id="plist">${pList()}</div>`;
}

function pList() {
  const q = ui.q.trim().toLowerCase();
  const items = store.all('platnosci')
    .filter((p) => (ui.showOff ? true : p.aktywna))
    .filter((p) => !ui.grupa || p.grupa === ui.grupa)
    .filter((p) => !q || [p.nazwa, p.grupa, p.konto, p.uwagi, p.odbiorca].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.aktywna - a.aktywna) || ((a.termin || '9') < (b.termin || '9') ? -1 : 1));
  if (!items.length) return '<div class="card empty">Brak pozycji.</div>';
  const mc = round2(items.filter((p) => p.aktywna).reduce((s, p) => s + (p.typ !== 'zadanie' && p.kwota && months(p) ? p.kwota / months(p) : 0), 0));
  return `<div class="card"><ul class="list">${items.map((p) => {
    const d = p.aktywna ? daysUntil(p.termin) : null;
    const meta = [ui.grupa ? '' : p.grupa, CYKLE[p.cykl]?.label, p.sposob === 'auto' ? `auto · ${p.konto}` : p.konto].filter(Boolean).join(' · ');
    return `<li class="row ${p.aktywna ? '' : 'off'}" data-act="edit-p" data-id="${p.id}">
      ${dateBox(p.termin, p.sposob === 'auto' && d < 0 ? 0 : d)}
      <div class="body"><div class="t">${esc(p.nazwa)}</div><div class="s">${esc(meta)}${p.typ === 'zadanie' ? ' <span class="pill">zadanie</span>' : ''}</div></div>
      <div class="r"><div class="amt">${fmtMoney(p.kwota)}</div><div class="s small muted">${p.aktywna ? relDays(d) : 'zakończona'}</div></div>
      ${p.aktywna ? `<button class="check" type="button" data-act="pay-p" data-id="${p.id}" title="Zapłacone">✓</button>` : ''}
    </li>`;
  }).join('')}</ul></div>
  <p class="small muted">${items.length} poz. · średni koszt stały: <b>${fmtMoney(mc)}</b> / mies.</p>`;
}

function vHarmonogram() {
  const sch = schedule(12);
  if (!sch.size) return '<div class="card empty">Brak zaplanowanych płatności.</div>';
  let total = 0;
  const html = [...sch.entries()].map(([ym, list]) => {
    const s = round2(list.reduce((a, o) => a + (o.p.typ === 'zadanie' ? 0 : o.p.kwota || 0), 0));
    total += s;
    return `<div class="card month"><h3><span>${fmtMonth(ym)}</span><span>${fmtMoney(s)}</span></h3><ul class="list">${list.map((o) => {
      const d = daysUntil(o.date);
      return `<li class="row" data-act="edit-p" data-id="${o.p.id}">${dateBox(o.date, d)}<div class="body"><div class="t">${esc(o.p.nazwa)}</div>
        <div class="s">${esc(o.p.grupa)}${o.p.sposob === 'auto' ? ' · <span class="pill blue">auto</span>' : ''}</div></div><div class="r amt">${fmtMoney(o.p.kwota)}</div></li>`;
    }).join('')}</ul></div>`;
  }).join('');
  return `<p class="muted small">Projekcja płatności cyklicznych na 12 miesięcy na podstawie bieżących kwot. Razem: <b>${fmtMoney(round2(total))}</b>.</p>
    <div class="cols two">${html}</div>`;
}

function vWspoldzielone() {
  const all = store.all('wspoldzielone');
  if (!all.length) return '<div class="card empty">Brak współdzielonych subskrypcji. Dodaj przyciskiem +.</div>';
  const by = new Map();
  for (const w of all) {
    if (!by.has(w.usluga)) by.set(w.usluga, []);
    by.get(w.usluga).push(w);
  }
  return `<p class="muted small">Rozliczenia za udostępniane konta rodzinne. Pozycje „do zapłaty” i kończące się okresy pojawiają się na pulpicie.</p>
  <div class="cols two">${[...by.entries()].map(([u, list]) => {
    const others = list.filter((w) => w.status !== 'wlasciciel');
    const got = round2(others.filter((w) => w.status === 'zaplacono').reduce((s, w) => s + (w.kwota || 0), 0));
    const due = round2(others.filter((w) => w.status === 'do_zaplaty').reduce((s, w) => s + (w.kwota || 0), 0));
    return `<div class="card month"><h3><span>${esc(u)}</span><span class="small muted">wpłacone ${fmtMoney(got)}${due ? ` · do zapłaty ${fmtMoney(due)}` : ''}</span></h3>
    <ul class="list">${list.sort((a, b) => a.osoba.localeCompare(b.osoba, 'pl')).map((w) => {
      const d = daysUntil(w.do);
      const [lbl, cls] = STATUS_W[w.status] || [w.status || '—', ''];
      return `<li class="row" data-act="edit-w" data-id="${w.id}"><div class="body"><div class="t">${esc(w.osoba)}</div>
        <div class="s">${fmtDate(w.od)} – ${fmtDate(w.do)}${w.status !== 'wlasciciel' && d !== null && d <= 30 ? ` · <span class="pill ${d < 0 ? 'red' : 'amber'}">${d < 0 ? 'okres minął' : 'kończy się ' + relDays(d)}</span>` : ''}</div></div>
        <div class="r"><div class="amt">${fmtMoney(w.kwota)}</div><span class="pill ${cls}">${esc(lbl)}</span></div></li>`;
    }).join('')}</ul></div>`;
  }).join('')}</div>`;
}

function vNajem() {
  const lokale = [...new Set([...store.all('najem'), ...store.all('najemcy')].map((r) => r.lokal).filter(Boolean))];
  if (!lokale.length) {
    return `<div class="card hello"><h2>Ewidencja najmu</h2><p>Brak danych. Dodaj pierwszy miesiąc najmu.</p>
      <button class="btn primary" data-act="add-rent" data-id="">+ Miesiąc najmu</button></div>`;
  }
  if (!lokale.includes(ui.lokal)) ui.lokal = lokale[0];
  const rows = store.all('najem').filter((r) => r.lokal === ui.lokal).sort((a, b) => (a.okres < b.okres ? 1 : -1));
  const tenants = store.all('najemcy').filter((r) => r.lokal === ui.lokal).sort((a, b) => (a.umowaOd < b.umowaOd ? 1 : -1));
  const S = (k, arr = rows) => round2(arr.reduce((s, r) => s + (r[k] || 0), 0));
  const przychod = round2(S('czynsz') + S('garaz'));
  const years = [...new Set(rows.map((r) => r.okres.slice(0, 4)))].sort().reverse();
  const unpaidUS = rows.filter((r) => r.podatek && !r.zaplaconoUS && r.terminUS);
  const unpaidRent = rows.filter((r) => !r.zaplacono && r.terminPlatnosci);

  return `
  ${lokale.length > 1 ? `<div class="toolbar"><div class="chips">${lokale.map((l) => `<button class="chip ${l === ui.lokal ? 'on' : ''}" data-act="lokal" data-id="${esc(l)}">${esc(l)}</button>`).join('')}</div></div>` : ''}
  <div class="stats">
    <div class="card stat"><div class="lbl">Przychód (czynsz + garaż)</div><div class="val">${fmtMoney(przychod)}</div><div class="sub">od początku · ${rows.length} mies.</div></div>
    <div class="card stat"><div class="lbl">Podatek (ryczałt)</div><div class="val">${fmtMoney(S('podatek'))}</div><div class="sub">${unpaidUS.length ? `${unpaidUS.length} nieopłacone` : 'wszystko opłacone'}</div></div>
    <div class="card stat"><div class="lbl">Przychód netto</div><div class="val">${fmtMoney(round2(przychod - S('podatek')))}</div><div class="sub">po podatku</div></div>
    <div class="card stat ${unpaidRent.length ? 'amber' : ''}"><div class="lbl">Nieopłacone czynsze</div><div class="val">${unpaidRent.length}</div><div class="sub">${fmtMoney(round2(S('czynsz', unpaidRent) + S('garaz', unpaidRent)))}</div></div>
  </div>
  <div class="section"><h2>Podsumowanie roczne</h2></div>
  <div class="card table-wrap"><table class="t"><thead><tr><th>Rok</th><th>Mies.</th><th>Czynsz</th><th>Garaż</th><th>Opłaty (wspólnota, prąd, internet)</th><th>Podatek</th><th>Netto</th></tr></thead>
  <tbody>${years.map((y) => {
    const ry = rows.filter((r) => r.okres.startsWith(y));
    const media = round2(S('wspolnota', ry) + S('prad', ry) + S('internet', ry));
    return `<tr><td>${y}</td><td>${ry.length}</td><td>${fmtMoney(S('czynsz', ry))}</td><td>${fmtMoney(S('garaz', ry))}</td><td>${fmtMoney(media)}</td><td>${fmtMoney(S('podatek', ry))}</td><td><b>${fmtMoney(round2(S('czynsz', ry) + S('garaz', ry) - S('podatek', ry)))}</b></td></tr>`;
  }).join('')}</tbody></table></div>

  <div class="section"><h2>Ewidencja miesięczna</h2><button class="btn sm" data-act="add-rent" data-id="${esc(ui.lokal)}">+ Kolejny miesiąc</button></div>
  <div class="card table-wrap"><table class="t"><thead><tr><th>Okres</th><th>Czynsz</th><th>Garaż</th><th>Wspólnota</th><th>Prąd</th><th>Internet</th><th>Wpłata najemcy</th><th>Podatek</th><th>Termin US</th><th>Zapłacono US</th></tr></thead>
  <tbody>${rows.map((r) => `<tr class="click" data-act="edit-n" data-id="${r.id}">
    <td>${fmtMonth(r.okres)}${r.uwagi ? ' <span class="pill" title="' + esc(r.uwagi) + '">i</span>' : ''}</td><td>${fmtMoney(r.czynsz)}</td><td>${fmtMoney(r.garaz)}</td><td>${fmtMoney(r.wspolnota)}</td>
    <td>${fmtMoney(r.prad)}</td><td>${fmtMoney(r.internet)}</td>
    <td>${r.zaplacono ? fmtDate(r.zaplacono) : r.terminPlatnosci ? `<span class="pill amber">do ${fmtDate(r.terminPlatnosci)}</span>` : '—'}</td>
    <td>${fmtMoney(r.podatek)}</td><td>${fmtDate(r.terminUS)}</td>
    <td>${r.zaplaconoUS ? fmtDate(r.zaplaconoUS) : r.podatek && r.terminUS ? '<span class="pill red">nie</span>' : '—'}</td></tr>`).join('')}</tbody></table></div>
  <p class="small muted">Podatek domyślnie liczony jako ${String(store.settings.stawkaNajem).replace('.', ',')}% czynszu (ryczałt), płatny do 20. dnia następnego miesiąca; zeznanie roczne PIT-28 do końca lutego.</p>

  <div class="section"><h2>Umowy najmu</h2><button class="btn sm" data-act="add-tenant">+ Umowa</button></div>
  <div class="card"><ul class="list">${tenants.map((t) => {
    const warn = t.umowaDo && t.umowaOd && t.umowaDo < t.umowaOd;
    return `<li class="row" data-act="edit-t" data-id="${t.id}"><div class="body"><div class="t">${t.nr ? `Najemca nr ${t.nr}: ` : ''}${esc(t.osoby)}</div>
    <div class="s">${fmtDate(t.umowaOd)} – ${fmtDate(t.umowaDo)}${warn ? ' <span class="pill red">sprawdź daty</span>' : ''}${t.uwagi ? ' · ' + esc(t.uwagi) : ''}</div></div>
    <div class="r"><div class="amt">${t.kaucja ? fmtMoney(t.kaucja) : ''}</div><div class="s small muted">${t.kaucja ? 'kaucja' : ''}</div></div></li>`;
  }).join('') || '<li class="empty">Brak umów</li>'}</ul></div>`;
}

function vUstawienia() {
  const s = store.settings;
  const st = gsync.status;
  const notifSupported = 'Notification' in window;
  return `<div class="stack">
  <div class="card pad stack">
    <h3 style="margin:0">Dysk Google</h3>
    <p class="small muted" style="margin:0">Dane są przechowywane w arkuszu „Opłaty i terminy – baza aplikacji” na Twoim Dysku Google.
      Aplikacja ma dostęp <b>wyłącznie do plików, które sama utworzyła</b> (uprawnienie <code>drive.file</code>) – nie widzi reszty Twojego Dysku.</p>
    ${field('Identyfikator klienta OAuth (Client ID)', inp('clientId', s.clientId || '', `id="clientId" type="text" placeholder="${esc(window.APP_CONFIG?.googleClientId || 'xxxx.apps.googleusercontent.com')}" autocomplete="off"`))}
    <p class="small muted" style="margin:0">Zostaw puste, jeśli wpisano go w pliku <code>config.js</code>${window.APP_CONFIG?.googleClientId ? ' (jest wpisany ✓)' : ''}.</p>
    <dl class="kv">
      <dt>Status</dt><dd>${esc(gsync.message || (gsync.configured ? (gsync.hasToken ? 'zalogowano' : 'niezalogowano') : 'nieskonfigurowano'))}</dd>
      <dt>Ostatnia synchronizacja</dt><dd>${store.meta.lastSync ? new Date(store.meta.lastSync).toLocaleString('pl-PL') : '—'}</dd>
      <dt>Arkusz</dt><dd>${gsync.sheetUrl ? `<a href="${gsync.sheetUrl}" target="_blank" rel="noopener">otwórz w Arkuszach Google ↗</a>` : '—'}</dd>
    </dl>
    <div class="toolbar" style="margin:0">
      <button class="btn primary" data-act="sync" ${gsync.configured || s.clientId ? '' : 'disabled'}>${gsync.hasToken ? 'Synchronizuj teraz' : 'Zaloguj i synchronizuj'}</button>
      ${gsync.hasToken ? '<button class="btn" data-act="logout">Wyloguj</button>' : ''}
      ${st === 'error' ? `<span class="pill red">${esc(gsync.message)}</span>` : ''}
    </div>
  </div>

  ${apkCard()}

  <div class="card pad stack">
    <h3 style="margin:0">Przypomnienia</h3>
    <label class="inline"><input type="checkbox" id="autoP" ${s.autoPrzesuwaj ? 'checked' : ''}>
      Płatności automatyczne (polecenia zapłaty, subskrypcje) – po terminie przesuwaj na kolejny okres i zapisuj w historii</label>
    ${field('Przypominaj z wyprzedzeniem (dni)', `<input type="number" id="dniP" min="0" max="30" value="${s.dniPrzypomnienia}">`)}
    ${notifSupported ? `<label class="inline"><input type="checkbox" id="notif" ${s.powiadomienia && Notification.permission === 'granted' ? 'checked' : ''}>
      Powiadomienie przy otwarciu aplikacji, gdy zbliża się termin</label>` : ''}
    <div>
      <button class="btn" data-act="export-ics">Pobierz przypomnienia do kalendarza (.ics)</button>
      <p class="small muted">Plik zawiera wszystkie aktywne płatności jako wydarzenia cykliczne z alarmem. Zaimportuj go do Kalendarza Google (na komputerze: Ustawienia → Importuj i eksportuj) – powiadomienia przyjdą na telefon. Po większych zmianach zaimportuj ponownie (wydarzenia się zaktualizują).</p>
    </div>
  </div>

  <div class="card pad stack">
    <h3 style="margin:0">Najem</h3>
    ${field('Stawka ryczałtu od najmu (%)', `<input type="number" id="stawka" step="0.5" min="0" max="30" value="${s.stawkaNajem}">`)}
  </div>

  <div class="card pad stack">
    <h3 style="margin:0">Dane</h3>
    <div class="toolbar" style="margin:0">
      <button class="btn" data-act="import">Importuj JSON</button>
      <button class="btn" data-act="export-json">Eksportuj kopię (JSON)</button>
      <button class="btn danger" data-act="clear">Wyczyść dane na tym urządzeniu</button>
    </div>
    <p class="small muted" style="margin:0">Na tym urządzeniu: ${store.all('platnosci').length} płatności, ${store.all('historia').length} wpisów historii,
      ${store.all('wspoldzielone').length} rozliczeń, ${store.all('najem').length} mies. najmu. Aplikacja działa także offline – zmiany wyśle przy następnej synchronizacji.</p>
  </div>
  <p class="small muted">Opłaty i terminy · wersja 1.0</p>
  </div>`;
}

function apkCard() {
  const a = ui.apk;
  if (isApp) return `<div class="card pad"><h3 style="margin:0 0 4px">Aplikacja na Androida</h3>
    <p class="small muted" style="margin:0">Korzystasz z aplikacji${a ? ` · portal w wersji ${esc(a.nazwa)}` : ''}. Zmiany w portalu pojawiają się w aplikacji automatycznie – nie trzeba jej instalować ponownie.</p></div>`;
  if (!a?.apk) return '';
  return `<div class="card pad stack"><h3 style="margin:0">Aplikacja na Androida</h3>
    <p class="small muted" style="margin:0">Otwórz tę stronę w Chrome na telefonie i pobierz plik. Przy instalacji Android zapyta o zgodę na instalowanie z Chrome – zezwól (jednorazowo).</p>
    <div><a class="btn primary" href="oplaty.apk" download>Pobierz aplikację (APK, wersja ${esc(a.nazwa)}, ${Math.round(a.rozmiar / 1024)} kB)</a></div></div>`;
}

function apkBanner() {
  if (isApp || !isAndroid || !ui.apk?.apk || localStorage.getItem('oplaty.bezBanera')) return '';
  return `<div class="card pad" style="margin-bottom:12px;display:flex;gap:12px;align-items:center">
    <div style="flex:1"><b>Aplikacja na Androida</b><div class="small muted">Zainstaluj „Opłaty” jak zwykłą aplikację.</div></div>
    <a class="btn primary sm" href="oplaty.apk" download>Pobierz</a><button class="x" data-act="hide-banner" aria-label="Ukryj">×</button></div>`;
}

const VIEWS = { pulpit: vPulpit, platnosci: vPlatnosci, harmonogram: vHarmonogram, wspoldzielone: vWspoldzielone, najem: vNajem, ustawienia: vUstawienia };

// ---------------------------------------------------------------- formularze
function editPayment(p) {
  const isNew = !p;
  p = p || { id: uid(), grupa: ui.grupa || groups()[0] || '', typ: 'oplata', cykl: 'M1', sposob: 'reczna', aktywna: 1, termin: today() };
  const hist = isNew ? [] : store.all('historia').filter((h) => h.platnoscId === p.id).sort((a, b) => (a.termin < b.termin ? 1 : -1));
  const body = `<div class="grid2">
    ${field('Nazwa', inp('nazwa', p.nazwa, 'type="text" required'), 'wide')}
    ${field('Grupa', inp('grupa', p.grupa, 'type="text" list="grupyList" required') + `<datalist id="grupyList">${groups().map((g) => `<option value="${esc(g)}">`).join('')}</datalist>`)}
    ${field('Rodzaj', sel('typ', p.typ, [['oplata', 'opłata'], ['zadanie', 'zadanie (bez kwoty)']]))}
    ${field('Kwota [zł]', inp('kwota', p.kwota ?? '', 'type="text" inputmode="decimal" placeholder="zmienna"'))}
    ${field('Najbliższy termin', inp('termin', p.termin, 'type="date"'))}
    ${field('Powtarzanie', sel('cykl', p.cykl, Object.entries(CYKLE).map(([k, v]) => [k, v.label])))}
    ${field('Powtarzaj do (opcjonalnie)', inp('koniec', p.koniec, 'type="date"'))}
    ${field('Sposób płatności', sel('sposob', p.sposob, [['reczna', 'ręczna'], ['auto', 'automatyczna']]))}
    ${field('Konto / metoda', inp('konto', p.konto, 'type="text" placeholder="np. Revolut, ING, BLIK"'))}
    ${field('Odbiorca', inp('odbiorca', p.odbiorca, 'type="text"'), 'wide')}
    ${field('Numer rachunku', inp('rachunek', p.rachunek, 'type="text" inputmode="numeric"'), 'wide')}
    ${field('Uwagi', `<textarea name="uwagi">${esc(p.uwagi)}</textarea>`, 'wide')}
    <label class="inline wide"><input type="checkbox" name="aktywna" ${p.aktywna ? 'checked' : ''}> aktywna</label>
  </div>
  ${hist.length ? `<div class="section"><h2>Historia (${hist.length})</h2></div><div class="table-wrap"><table class="t"><thead><tr><th>Termin</th><th>Zapłacono</th><th>Kwota</th><th></th></tr></thead>
    <tbody>${hist.map((h) => `<tr><td>${fmtDate(h.termin)}</td><td>${fmtDate(h.dataZaplaty)}${h.auto ? ' <span class="pill blue">auto</span>' : ''}</td><td>${fmtMoney(h.kwota)}</td>
    <td><button type="submit" class="btn sm" value="delhist:${h.id}" formnovalidate title="Usuń wpis">✕</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  const btns = `${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Usuń</button>'}<span class="spacer"></span>
    <button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="save">Zapisz</button>`;
  dialog(isNew ? 'Nowa płatność' : 'Edycja płatności', body, btns, (act, fd) => {
    if (act === 'delete') {
      confirmDelete('platnosci', p.id, p.nazwa);
      return false;
    }
    if (act.startsWith('delhist:')) {
      store.remove('historia', act.slice(8));
      editPayment(store.get('platnosci', p.id));
      return false;
    }
    store.upsert('platnosci', { ...p, ...fd, kwota: parseNum(fd.kwota), nazwa: fd.nazwa.trim(), grupa: fd.grupa.trim() });
    toast(isNew ? 'Dodano płatność' : 'Zapisano');
  });
}

function confirmDelete(table, id, name) {
  const before = store.get(table, id);
  dialog('Usunąć?', `<p>Czy na pewno usunąć „${esc(name)}”?</p>`,
    '<button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="ok">Usuń</button>', () => {
      store.remove(table, id);
      toast('Usunięto', () => store.upsert(table, { ...before, usuniety: 0 }));
    });
}

function payDialog(p) {
  const body = `<p class="muted" style="margin-top:0">${esc(p.nazwa)} · termin ${fmtDate(p.termin)}${months(p) ? ` → kolejny ${fmtDate(addMonths(p.termin, months(p)))}` : ''}</p>
    <div class="grid2">
      ${field('Data zapłaty', inp('data', today(), 'type="date" required'))}
      ${p.typ === 'zadanie' ? '' : field('Kwota [zł]', inp('kwota', p.kwota ?? '', 'type="text" inputmode="decimal"'))}
      ${field('Uwagi', inp('uwagi', '', 'type="text"'), 'wide')}
    </div>`;
  dialog(p.typ === 'zadanie' ? 'Oznacz jako zrobione' : 'Zapłacono', body,
    '<button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="ok">Zapisz</button>', (act, fd) => {
      const undo = markPaid(p, { data: fd.data, kwota: parseNum(fd.kwota), uwagi: fd.uwagi });
      toast(`${p.nazwa}: ${p.typ === 'zadanie' ? 'zrobione' : 'zapłacono'}`, undo);
    });
}

function quickPay(p) {
  const undo = markPaid(p);
  toast(`${p.nazwa}: ${p.typ === 'zadanie' ? 'zrobione' : 'zapłacono'} ${fmtDate(today())}`, undo);
}

function editShared(w) {
  const isNew = !w;
  w = w || { id: uid(), usluga: '', status: 'do_zaplaty', od: today(), do: addMonths(today(), 12) };
  const uslugi = [...new Set(store.all('wspoldzielone').map((x) => x.usluga))];
  const body = `<div class="grid2">
    ${field('Usługa', inp('usluga', w.usluga, 'type="text" list="uslList" required') + `<datalist id="uslList">${uslugi.map((u) => `<option value="${esc(u)}">`).join('')}</datalist>`)}
    ${field('Osoba', inp('osoba', w.osoba, 'type="text" required'))}
    ${field('Od', inp('od', w.od, 'type="date"'))}
    ${field('Do', inp('do', w.do, 'type="date"'))}
    ${field('Kwota za okres [zł]', inp('kwota', w.kwota ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Status', sel('status', w.status, Object.entries(STATUS_W).map(([k, v]) => [k, v[0]])))}
    ${field('Uwagi', inp('uwagi', w.uwagi, 'type="text"'), 'wide')}
  </div>`;
  const btns = `${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Usuń</button><button class="btn" value="extend" formnovalidate>Przedłuż o rok</button>'}
    <span class="spacer"></span><button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="save">Zapisz</button>`;
  dialog(isNew ? 'Nowe rozliczenie' : 'Rozliczenie subskrypcji', body, btns, (act, fd) => {
    if (act === 'delete') { confirmDelete('wspoldzielone', w.id, `${w.usluga} – ${w.osoba}`); return false; }
    if (act === 'extend') {
      const start = w.do || today();
      store.upsert('wspoldzielone', { ...w, od: start, do: addMonths(start, 12), status: w.status === 'wlasciciel' ? 'wlasciciel' : 'do_zaplaty', uwagi: '' });
      toast('Przedłużono o rok – oznaczono „do zapłaty”');
      return;
    }
    store.upsert('wspoldzielone', { ...w, ...fd, kwota: parseNum(fd.kwota) });
    toast('Zapisano');
  });
}

function editRent(r) {
  const isNew = !r.zm;
  const body = `<div class="grid2">
    ${field('Lokal', inp('lokal', r.lokal, 'type="text" required'))}
    ${field('Okres (miesiąc)', inp('okres', r.okres, 'type="month" required'))}
    ${field('Czynsz [zł]', inp('czynsz', r.czynsz ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Garaż [zł]', inp('garaz', r.garaz ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Czynsz do wspólnoty [zł]', inp('wspolnota', r.wspolnota ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Prąd [zł]', inp('prad', r.prad ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Internet [zł]', inp('internet', r.internet ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Termin płatności najemcy', inp('terminPlatnosci', r.terminPlatnosci, 'type="date"'))}
    ${field('Wpłata najemcy (data)', inp('zaplacono', r.zaplacono, 'type="date"'))}
    ${field('Podatek [zł]', inp('podatek', r.podatek ?? '', 'type="text" inputmode="decimal"') )}
    ${field('Termin wpłaty do US', inp('terminUS', r.terminUS, 'type="date"'))}
    ${field('Zapłacono do US (data)', inp('zaplaconoUS', r.zaplaconoUS, 'type="date"'))}
    ${field('Uwagi', `<textarea name="uwagi">${esc(r.uwagi)}</textarea>`, 'wide')}
  </div><p class="small muted">Puste pole podatku zostanie wyliczone jako ${String(store.settings.stawkaNajem).replace('.', ',')}% czynszu.</p>`;
  const btns = `${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Usuń</button>'}<span class="spacer"></span>
    <button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="save">Zapisz</button>`;
  dialog(isNew ? 'Nowy miesiąc najmu' : `Najem – ${fmtMonth(r.okres)}`, body, btns, (act, fd) => {
    if (act === 'delete') { confirmDelete('najem', r.id, `najem ${fmtMonth(r.okres)}`); return false; }
    const czynsz = parseNum(fd.czynsz);
    let podatek = parseNum(fd.podatek);
    if (podatek === null && czynsz) podatek = round2(czynsz * store.settings.stawkaNajem / 100);
    store.upsert('najem', { ...r, ...fd, czynsz, podatek, garaz: parseNum(fd.garaz), wspolnota: parseNum(fd.wspolnota),
      prad: parseNum(fd.prad), internet: parseNum(fd.internet) });
    ui.lokal = fd.lokal;
    toast('Zapisano');
  });
}

function editTenant(t) {
  const isNew = !t;
  t = t || { id: uid(), lokal: ui.lokal, umowaOd: today() };
  const body = `<div class="grid2">
    ${field('Lokal', inp('lokal', t.lokal, 'type="text" required'))}
    ${field('Nr najemcy', inp('nr', t.nr || '', 'type="number" min="0"'))}
    ${field('Najemcy (osoby)', inp('osoby', t.osoby, 'type="text" required'), 'wide')}
    ${field('Umowa od', inp('umowaOd', t.umowaOd, 'type="date"'))}
    ${field('Umowa do', inp('umowaDo', t.umowaDo, 'type="date"'))}
    ${field('Kaucja [zł]', inp('kaucja', t.kaucja ?? '', 'type="text" inputmode="decimal"'))}
    ${field('Uwagi', `<textarea name="uwagi">${esc(t.uwagi)}</textarea>`, 'wide')}
  </div>`;
  const btns = `${isNew ? '' : '<button class="btn danger" value="delete" formnovalidate>Usuń</button>'}<span class="spacer"></span>
    <button type="button" class="btn" data-close>Anuluj</button><button class="btn primary" value="save">Zapisz</button>`;
  dialog(isNew ? 'Nowa umowa najmu' : 'Umowa najmu', body, btns, (act, fd) => {
    if (act === 'delete') { confirmDelete('najemcy', t.id, t.osoby); return false; }
    store.upsert('najemcy', { ...t, ...fd, kaucja: parseNum(fd.kaucja) });
    toast('Zapisano');
  });
}

function agendaItem(key) {
  return agenda(3650).find((i) => i.key === key);
}

function doneAgenda(key) {
  const i = agendaItem(key);
  if (!i) return;
  if (i.kind === 'platnosc' || i.kind === 'zadanie') return quickPay(i.ref);
  const r = i.ref;
  if (key.startsWith('us:')) {
    store.upsert('najem', { ...r, zaplaconoUS: today() });
    toast('Podatek oznaczony jako zapłacony', () => store.upsert('najem', r));
  } else if (key.startsWith('nj:')) {
    store.upsert('najem', { ...r, zaplacono: today() });
    toast('Wpłata najemcy zaksięgowana', () => store.upsert('najem', r));
  } else if (key.startsWith('w:')) {
    store.upsert('wspoldzielone', { ...r, status: 'zaplacono', uwagi: r.uwagi || `zapłacono ${fmtDate(today())}` });
    toast('Składka oznaczona jako zapłacona', () => store.upsert('wspoldzielone', r));
  }
}

function openAgenda(key) {
  const i = agendaItem(key);
  if (!i) return;
  if (key.startsWith('p:')) editPayment(i.ref);
  else if (key.startsWith('us:') || key.startsWith('nj:')) editRent(i.ref);
  else editShared(i.ref);
}

function importDialog() {
  const fi = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  fi.onchange = async () => {
    const f = fi.files[0];
    if (!f) return;
    let obj;
    try {
      obj = JSON.parse(await f.text());
    } catch {
      return toast('To nie jest poprawny plik JSON');
    }
    const n = ['platnosci', 'wspoldzielone', 'najem', 'najemcy', 'historia'].reduce((s, t) => s + (obj[t]?.length || 0), 0);
    if (!n) return toast('Plik nie zawiera danych aplikacji');
    if (store.isEmpty()) {
      store.importJson(obj, 'merge');
      rollAutomatic();
      return toast(`Zaimportowano ${n} rekordów`);
    }
    dialog('Import danych', `<p>Plik zawiera ${n} rekordów. Jak je zaimportować?</p>
      <p class="small muted">„Scal” dodaje nowe i aktualizuje istniejące pozycje (o tych samych identyfikatorach). „Zastąp” usuwa obecne dane i wstawia dane z pliku.</p>`,
    '<button type="button" class="btn" data-close>Anuluj</button><button class="btn" value="replace">Zastąp wszystko</button><button class="btn primary" value="merge">Scal</button>',
    (act) => {
      store.importJson(obj, act);
      rollAutomatic();
      toast(`Zaimportowano ${n} rekordów`);
    });
  };
  fi.click();
}

// ---------------------------------------------------------------- render i zdarzenia
function render() {
  const v = ui.current;
  $('#title').textContent = TITLES[v];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v || (v === 'harmonogram' && a.dataset.view === 'platnosci' && innerWidth < 900)));
  fab.hidden = !['pulpit', 'platnosci', 'wspoldzielone', 'najem', 'harmonogram'].includes(v) || (v === 'pulpit' && store.isEmpty());
  const y = scrollY;
  view.innerHTML = VIEWS[v]();
  scrollTo(0, y);
  updateBadge();
}

function route() {
  const v = location.hash.replace(/^#\/?/, '') || 'pulpit';
  const next = VIEWS[v] ? v : 'pulpit';
  if (next !== ui.current) scrollTo(0, 0);
  ui.current = next;
  render();
}

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  if (el.classList.contains('check')) e.stopPropagation();
  switch (act) {
    case 'edit-p': return editPayment(store.get('platnosci', id));
    case 'pay-p': { const p = store.get('platnosci', id); return e.shiftKey || e.altKey ? payDialog(p) : quickPay(p); }
    case 'new-p': return editPayment();
    case 'chip': ui.grupa = id; return render();
    case 'filter-group': ui.grupa = id; location.hash = '#/platnosci'; return;
    case 'open-agenda': return openAgenda(id);
    case 'done-agenda': return doneAgenda(id);
    case 'edit-w': return editShared(store.get('wspoldzielone', id));
    case 'edit-n': return editRent(store.get('najem', id));
    case 'edit-t': return editTenant(store.get('najemcy', id));
    case 'add-rent': return editRent(nextRentRow(id || ui.lokal || 'Mieszkanie'));
    case 'add-tenant': return editTenant();
    case 'lokal': ui.lokal = id; return render();
    case 'hide-banner': localStorage.setItem('oplaty.bezBanera', '1'); return render();
    case 'sync': return doSync(true);
    case 'logout': gsync.logout(); return render();
    case 'import': return importDialog();
    case 'export-json':
      return download(`oplaty-kopia-${today()}.json`, JSON.stringify(store.exportJson(), null, 1), 'application/json');
    case 'export-ics':
      return download('oplaty-przypomnienia.ics', buildIcs(store.settings.dniPrzypomnienia), 'text/calendar');
    case 'clear':
      return confirmBox('Wyczyścić dane lokalne?', 'Dane zostaną usunięte z tego urządzenia. Kopia na Dysku Google (jeśli była synchronizacja) pozostanie i zostanie pobrana ponownie po zalogowaniu.', 'Wyczyść', () => {
        Object.keys(localStorage).filter((k) => k.startsWith('oplaty.dane') || k.startsWith('oplaty.meta')).forEach((k) => localStorage.removeItem(k));
        location.reload();
      });
    default:
  }
});

view.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    ui.q = e.target.value;
    $('#plist').innerHTML = pList();
  }
});

view.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'showOff') { ui.showOff = t.checked; $('#plist').innerHTML = pList(); }
  if (t.id === 'clientId') { store.saveSettings({ clientId: t.value.trim() }); render(); }
  if (t.id === 'autoP') { store.saveSettings({ autoPrzesuwaj: t.checked }); if (t.checked && rollAutomatic()) toast('Przesunięto terminy płatności automatycznych'); }
  if (t.id === 'dniP') store.saveSettings({ dniPrzypomnienia: Math.max(0, Number(t.value) || 0) });
  if (t.id === 'stawka') store.saveSettings({ stawkaNajem: Number(String(t.value).replace(',', '.')) || 8.5 });
  if (t.id === 'notif') {
    if (t.checked) {
      const perm = await Notification.requestPermission();
      store.saveSettings({ powiadomienia: perm === 'granted' });
      if (perm !== 'granted') { t.checked = false; toast('Brak zgody na powiadomienia w przeglądarce'); } else notifyDue(true);
    } else store.saveSettings({ powiadomienia: false });
  }
});

fab.addEventListener('click', () => {
  if (ui.current === 'wspoldzielone') return editShared();
  if (ui.current === 'najem') return editRent(nextRentRow(ui.lokal || 'Mieszkanie'));
  return editPayment();
});

// ---------------------------------------------------------------- synchronizacja
const syncBtn = $('#syncBtn');
function paintSync() {
  syncBtn.className = `sync ${gsync.status}`;
  let txt = gsync.message;
  if (!gsync.configured) txt = 'Tryb lokalny';
  else if (gsync.status === 'ok' && store.meta.lastSync) txt = `Zsynchronizowano ${new Date(store.meta.lastSync).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`;
  else if (!txt) txt = gsync.hasToken ? 'Dysk Google' : 'Zaloguj (Google)';
  if (store.meta.dirty && gsync.configured && gsync.status !== 'syncing') txt += ' • niezapisane zmiany';
  $('#syncTxt').textContent = txt;
}

async function doSync(interactive = false) {
  if (!gsync.configured) { location.hash = '#/ustawienia'; return toast('Najpierw wpisz identyfikator klienta Google'); }
  const ok = await gsync.sync({ interactive });
  if (ok && interactive) toast('Zsynchronizowano z Dyskiem Google');
  if (!ok && interactive && gsync.status === 'error') toast(gsync.message);
  if (ok) rollAutomatic();
}

syncBtn.addEventListener('click', () => doSync(true));
gsync.addEventListener('status', () => { paintSync(); if (ui.current === 'ustawienia') render(); });

const autoSync = debounce(() => { if (gsync.hasToken) gsync.sync(); }, 2500);
store.addEventListener('change', (e) => {
  if (!dlg.open || e.detail.source === 'local') render();
  paintSync();
  if (e.detail.source === 'local') autoSync();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  rollAutomatic();
  const age = Date.now() - new Date(store.meta.lastSync || 0).getTime();
  if (gsync.hasToken && age > 60000) gsync.sync();
  render();
});

// ---------------------------------------------------------------- powiadomienia i odznaka
function dueSoon() {
  const n = store.settings.dniPrzypomnienia;
  return agenda(n).filter((i) => i.kind !== 'info' && !i.auto && i.days <= n);
}

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const c = dueSoon().length;
  (c ? navigator.setAppBadge(c) : navigator.clearAppBadge()).catch(() => {});
}

async function notifyDue(force = false) {
  if (!store.settings.powiadomienia || !('Notification' in window) || Notification.permission !== 'granted') return;
  const key = 'oplaty.powiadomiono';
  if (!force && localStorage.getItem(key) === today()) return;
  const due = dueSoon();
  if (!due.length) return;
  localStorage.setItem(key, today());
  const body = due.slice(0, 6).map((i) => `${fmtDate(i.date)} · ${i.title}${i.amount ? ' – ' + fmtMoney(i.amount) : ''}`).join('\n');
  const title = `${due.length} ${due.length === 1 ? 'termin' : 'terminy/-ów'} do pilnowania`;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, tag: 'oplaty', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
    else new Notification(title, { body });
  } catch { /* ignoruj */ }
}

// ---------------------------------------------------------------- start
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}
window.addEventListener('hashchange', route);
const rolled = rollAutomatic();
route();
paintSync();
if (rolled) toast(`Przesunięto ${rolled} ${rolled === 1 ? 'termin płatności automatycznej' : 'terminów płatności automatycznych'}`);
if (gsync.hasToken) gsync.sync();
else if (gsync.configured) gsync.setStatus('auth', 'Zaloguj (Google)');
notifyDue();
fetch('wersja.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((a) => {
  ui.apk = a;
  if (a && ['ustawienia', 'pulpit'].includes(ui.current) && !dlg.open) render();
}).catch(() => {});

// dostęp do debugowania z konsoli
window.__oplaty = { store, gsync };
