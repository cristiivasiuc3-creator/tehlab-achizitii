# Dashboard monitorizare achiziții — Tehlab Service

Aplicație web care monitorizează automat achizițiile publice relevante pentru
Tehlab Service (metrologie, mijloace de măsurare, calibrări) de pe **achizitii.md**.

## Ce face

- **Colector automat** (la fiecare 2 zile, configurabil): citește anunțurile de pe
  achizitii.md, filtrează după cuvinte-cheie și coduri CPV, elimină duplicatele și
  reconfirmă statusul/termenul-limită din sursa oficială.
- **Prezentare generală** — achiziții active, viitoare, de verificat, termene în 7 zile.
- **Achiziții active** — listă cu căutare, filtre (CPV, instituție, valoare, termen),
  sortare după termen-limită, paginare, pagină detaliată per achiziție.
- **Urmează 2026–2027** — proceduri anunțate oficial, dar cu depunerea încă nedeschisă
  (diferențiate clar de cele active).
- **De verificat** — anunțuri pentru care termenul nu a putut fi confirmat.
- **Salvate** — salvezi oportunități, adaugi note interne, urmărești termenele.
- **Rapoarte și istoric** — istoricul rulărilor, modificări de termene, export CSV/PDF.
- **Notificări pe email** (opțional) la fiecare achiziție nouă.
- **Autentificare** cu parolă, dacă aplicația e accesibilă pe internet.

## Pornire locală

```bash
pip3 install -r requirements.txt
cp .env.example .env        # și editează valorile
python3 server.py           # → http://localhost:5000
```

Prima rulare a colectorului (butonul „Actualizează acum" din interfață sau
`python3 collector.py`) durează câteva minute, pentru că verifică fiecare anunț.
Rulările următoare sunt mult mai rapide — reia doar noutățile.

## Pornire cu Docker (server / producție)

```bash
docker build -t tehlab-achizitii .
docker run -d --name tehlab -p 5000:5000 \
  -e ADMIN_PASSWORD='parola-ta-aici' \
  -e SECRET_KEY='cheie-lunga-aleatoare' \
  -v tehlab_data:/app/data \
  tehlab-achizitii
```

Baza de date (`SQLite`) stă în volumul `tehlab_data` — datele supraviețuiesc repornirilor.

## Publicare pe un server (acces permanent)

1. Un VPS mic (1 GB RAM e de ajuns; ~5–10 €/lună la orice furnizor, ex. Hetzner, Hostico).
2. Instalezi Docker, copiezi folderul aplicației, rulezi comenzile de mai sus.
3. **Obligatoriu** setezi `ADMIN_PASSWORD` și `SECRET_KEY` în `.env`/variabile de mediu.
4. (Opțional) pui un reverse proxy (nginx / Caddy) cu HTTPS în față, pe domeniul vostru.

## Structura proiectului

| Fișier | Rol |
|---|---|
| `collector.py` | Colectorul — reutilizează logica agentului existent (căutare, extragere, filtrare, clasificare, istoric) |
| `server.py` | Backend Flask: API, autentificare, refresh, export, email, programator automat |
| `static/` | Interfața web (index.html, style.css, app.js) |
| `tehlab.db` | Baza de date SQLite (se creează singură) |
| `Dockerfile`, `.env.example` | Configurare și containerizare |

## Notă despre logo

Placeholder-ul din bara laterală este doar un marcaj vizual (litera „T" turcoaz),
nu logo-ul oficial al companiei. Când ne trimiți fișierul original al logo-ului
(ex. `logo.svg` sau `logo.png`), îl punem în `static/` și îl conectăm în interfață.
