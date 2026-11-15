# Opłaty i terminy

Prywatna ewidencja opłat, terminów, rozliczeń subskrypcji i najmu:

- **Portal www:** https://oplaty.projekty-drogowe.pl (komputer, dowolna przeglądarka)
- **Aplikacja na Androida:** plik APK do pobrania z portalu (Ustawienia → *Pobierz aplikację*)
- **Dane:** wyłącznie w arkuszu „Opłaty i terminy – baza aplikacji” na prywatnym Dysku Google.
  W repozytorium nie ma żadnych danych. Aplikacja ma dostęp tylko do tego jednego pliku (uprawnienie `drive.file`).

Aplikacja na Androida pokazuje ten sam portal na pełnym ekranie (Trusted Web Activity). Zmiany w portalu pojawiają się więc
w telefonie od razu, bez instalowania nowej wersji. Nowy APK potrzebny jest tylko przy zmianie ikony lub nazwy.

## Struktura

| Folder | Co zawiera |
|---|---|
| `web/` | portal (czysty HTML/JS, bez serwera): `js/app.js` ekrany, `js/store.js` dane lokalne, `js/gsync.js` synchronizacja z Arkuszem Google, `js/logic.js` terminy i cykle, `config.js` identyfikator klienta Google |
| `web/.well-known/assetlinks.json` | powiązanie domeny z aplikacją Android (odcisk klucza podpisu) – dzięki temu aplikacja nie ma paska adresu |
| `android/` | aplikacja Android (pakiet `pl.projektydrogowe.oplaty`) – nie zmieniać nazwy pakietu ani klucza |
| `.github/workflows/wdrozenie.yml` | każde wysłanie zmian: budowa APK + publikacja portalu z plikiem `oplaty.apk` |

---

## Konfiguracja – jednorazowo

### 1. Sekrety klucza podpisu (GitHub)
Settings → Secrets and variables → Actions → **New repository secret** – cztery sekrety z pliku `KLUCZ-ANDROID-przechowaj.txt`:
`OPLATY_KEYSTORE_BASE64`, `OPLATY_KEYSTORE_PASSWORD`, `OPLATY_KEY_ALIAS`, `OPLATY_KEY_PASSWORD`.
Klucz musi być zawsze ten sam, inaczej telefon nie przyjmie aktualizacji, a aplikacja pokaże pasek adresu.

### 2. GitHub Pages
Settings → Pages → *Build and deployment* → Source: **GitHub Actions**.
Custom domain: `oplaty.projekty-drogowe.pl` → Save. Po wydaniu certyfikatu zaznacz **Enforce HTTPS**.

### 3. DNS w OVH
Panel OVH → Domeny → `projekty-drogowe.pl` → Strefa DNS → **Dodaj wpis** → `CNAME`:
- subdomena: `oplaty`
- cel: `patryk-rdm.github.io.` (z kropką na końcu)

Działa po kilkunastu minutach, czasem do kilku godzin.

### 4. Google Cloud (logowanie do Dysku)
1. https://console.cloud.google.com/ → prywatnym kontem Google → nowy projekt `Oplaty`.
2. APIs & Services → Library → włącz **Google Drive API** i **Google Sheets API**.
3. Google Auth Platform → Get started: nazwa `Opłaty i terminy`, Audience **External**, w *Test users* dodaj swój Gmail.
4. Clients → Create client → **Web application** → *Authorized JavaScript origins*: `https://oplaty.projekty-drogowe.pl` → Create.
5. Skopiuj Client ID do `web/config.js` (pole `googleClientId`) i zapisz zmianę (commit).

### 5. Pierwsze uruchomienie
Komputer: otwórz portal → **Importuj plik JSON** (`dane-startowe.json`) → **Zaloguj (Google)** → dane trafią na Dysk.
Telefon: otwórz portal w Chrome → **Pobierz** → zainstaluj (Android zapyta o zgodę na instalację z Chrome) → zaloguj się.

---

## Codzienna praca

- **✓** przy pozycji = zapłacone: wpis do historii i przesunięcie terminu o cykl (z „Cofnij”).
- Płatności automatyczne (polecenia zapłaty, subskrypcje) przesuwają się same po terminie.
- Synchronizacja z Dyskiem po każdej zmianie. Sesja Google trwa około godziny, potem wystarczy dotknąć przycisku w prawym górnym rogu.
- Arkusz na Dysku można poprawiać ręcznie. Nie zmieniaj nagłówków (wiersz 1) ani kolumny `id`.
- Przypomnienia w telefonie: Ustawienia → *Pobierz przypomnienia do kalendarza (.ics)* → import do Kalendarza Google.
- Kopia: Ustawienia → *Eksportuj kopię (JSON)*.
