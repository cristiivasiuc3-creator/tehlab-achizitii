# -*- coding: utf-8 -*-
"""
Colector de achiziții — Tehlab Service
Reutilizează logica din agent_achizitii.py: căutare pe achizitii.md după
cuvinte-cheie, extragere structurată, filtrare după domeniu, deduplicare.
Scrie rezultatele în SQLite și ține istoricul rulărilor și modificărilor.
"""

import os
import re
import time
import sqlite3
import logging
from datetime import datetime, timedelta

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE = "https://achizitii.md"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/124.0 Safari/537.36"}

KEYWORDS = [
    "metrolog", "cântar", "cantar", "cîntar",
    "balan", "etalon", "calibr",
    "verificare metrologic", "aparat de măsurare", "aparate de măsurare",
    "instrumente de măsurare", "instrument de măsurare",
    "mijloace de măsurare", "mijloc de măsurare",
    "greutăți de calibrare", "greutate etalon",
    "taxometru", "manometru", "termometru",
    "anemometru", "voltmetru", "ampermetru", "multimetru",
    "ceasornic", "aparat de taxat",
    # lărgite
    "contor", "contoare", "apometr", "debitmetr",
    "cântărire", "dozar", "dozator",
    "laborator", "tehnică de măsurare", "mijloace de măsurat",
    "поверен", "измерительн", "весы", "эталон", "калибровк",
    "счётчик", "счетчик", "расходомер", "прибор",
]

CPV_PREFIXES = (
    "383", "384", "385",
    "380",
    "429232", "42958",
    "504",
    "512",
)

MAX_PAGES_PER_KEYWORD = int(os.environ.get("MAX_PAGES_PER_KEYWORD", "8"))
MAX_TENDER_AGE_DAYS = int(os.environ.get("MAX_TENDER_AGE_DAYS", "60"))
DELAY_SECONDS = float(os.environ.get("DELAY_SECONDS", "0.8"))

DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tehlab.db"))

log = logging.getLogger("collector")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

session = requests.Session()
session.headers.update(HEADERS)
session.mount("https://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1)))


# ---------------- DB ----------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS tenders (
    id TEXT PRIMARY KEY,
    title TEXT, buyer TEXT, buyer_idno TEXT, buyer_phone TEXT, buyer_email TEXT,
    published TEXT, published_dt TEXT,
    offers_start TEXT, deadline TEXT, deadline_dt TEXT,
    budget TEXT, currency TEXT DEFAULT 'MDL',
    cpv TEXT, procedure TEXT, lots TEXT,
    url TEXT, mtender_id TEXT,
    category TEXT DEFAULT 'check',           -- active | upcoming | check | expired
    relevance_reason TEXT,
    first_seen TEXT, last_checked TEXT,
    archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER, tender_id TEXT, field TEXT, old_value TEXT, new_value TEXT,
    at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started TEXT, finished TEXT,
    scanned INTEGER DEFAULT 0, new_count INTEGER DEFAULT 0,
    updated INTEGER DEFAULT 0, expired INTEGER DEFAULT 0,
    error TEXT
);
CREATE TABLE IF NOT EXISTS saved (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tender_id TEXT, note TEXT DEFAULT '', done INTEGER DEFAULT 0,
    created_at TEXT,
    UNIQUE(tender_id)
);
"""


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


# ---------------- scraping ----------------

def fetch(url, **kw):
    r = session.get(url, timeout=40, **kw)
    r.raise_for_status()
    r.encoding = "utf-8"
    return r.text


import html as _html

def clean(s):
    return _html.unescape(re.sub(r"\s+", " ", s or "").strip())


MONTHS_RO = {"ian": 1, "feb": 2, "mar": 3, "apr": 4, "mai": 5, "iun": 6,
             "iul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "noi": 11, "dec": 12}


def parse_date_ro(s):
    if not s:
        return None
    s = s.strip()
    m = re.match(r"(\d{1,2})\s+([a-zăîâșț]+)\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?", s, re.I)
    if m:
        mon = MONTHS_RO.get(m.group(2)[:3].lower())
        if mon:
            return datetime(int(m.group(3)), mon, int(m.group(1)),
                            int(m.group(4) or 0), int(m.group(5) or 0))
    # format scurt: 26.06.19 12:00 sau 26.06.2019, 12:00
    m = re.match(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2}))?", s)
    if m:
        y = int(m.group(3))
        y = y + 2000 if y < 100 else y
        return datetime(y, int(m.group(2)), int(m.group(1)),
                        int(m.group(4) or 0), int(m.group(5) or 0))
    return None


def search_tender_ids(keyword):
    """Căutare după cuvânt-cheie (folosită ca sursă suplimentară)."""
    found = {}
    for page in range(1, MAX_PAGES_PER_KEYWORD + 1):
        h = fetch(f"{BASE}/ro/public/tender/list",
                  params={"q": keyword, "page": page})
        ids = list(dict.fromkeys(re.findall(r'href="/ro/public/tender/(\d+)/"', h)))
        if not ids:
            break
        for mid in ids:
            found.setdefault(mid, True)
        time.sleep(DELAY_SECONDS)
    return found


ITEM_DATE_RE = re.compile(
    r'<div class="tender__list__item"[^>]*>.*?'
    r'href="/ro/public/tender/(\d+)/".*?'
    r'tender__list__item__info__date[^>]*>\s*(?:<!--.*?-->\s*)?<span>([^<]+)</span>',
    re.S)


def collect_recent_ids(progress=None):
    """Parcurge lista principală (cea mai nouă prima) până depășim
    MAX_TENDER_AGE_DAYS. Returnează {id: published_dt}."""
    found = {}
    cutoff = datetime.now() - timedelta(days=MAX_TENDER_AGE_DAYS)
    for page in range(1, 500):
        h = fetch(f"{BASE}/ro/public/tender/list", params={"page": page})
        pairs = ITEM_DATE_RE.findall(h)
        if not pairs:
            ids = list(dict.fromkeys(re.findall(r'href="/ro/public/tender/(\d+)/"', h)))
            if not ids:
                break
            pairs = [(i, None) for i in ids]
        oldest = None
        for tid, dstr in pairs:
            dt = parse_date_ro(dstr) if dstr else None
            if tid not in found:
                found[tid] = dt
            if dt and (oldest is None or dt < oldest):
                oldest = dt
        if progress:
            progress(f"Lista principală, pagina {page}: {len(found)} anunțuri, "
                     f"cel mai vechi de pe pagină: {oldest:%d.%m.%Y}" if oldest
                     else f"Lista principală, pagina {page}: {len(found)} anunțuri")
        if oldest and oldest < cutoff:
            # păstrăm doar cele din fereastra de timp
            found = {k: v for k, v in found.items() if v is None or v >= cutoff}
            break
        time.sleep(DELAY_SECONDS)
    return {k: v for k, v in found.items() if v is None or v >= cutoff}


ROW_RE = re.compile(
    r'<span class="tender__item__row__title">(.*?)</span>\s*'
    r'<div class="tender__item__row__body">(.*?)</div>', re.S)


def fetch_tender(tid):
    h = fetch(f"{BASE}/ro/public/tender/{tid}/")
    t = {"id": tid, "url": f"{BASE}/ro/public/tender/{tid}/"}

    m = re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S)
    t["title"] = clean(re.sub(r"<[^>]+>", " ", m.group(1))) if m else ""

    for k, v in ROW_RE.findall(h):
        k = clean(re.sub(r"<[^>]+>", " ", k))
        v = clean(re.sub(r"<[^>]+>", " ", v))
        if k == "Denumirea":
            t["buyer"] = v
        elif k == "Codul fiscal/IDNO":
            t["buyer_idno"] = v
        elif k == "E-mail":
            t["buyer_email"] = v
        elif k == "Telefonul de contact":
            t["buyer_phone"] = v
        elif k == "Data publicării":
            t["published"] = v
        elif k == "MTender ID":
            t["mtender_id"] = v
        elif k == "CPV":
            t["cpv"] = v
        elif k == "Tipul procedurii":
            t["procedure"] = v

    i = h.find("Valoarea estimată fără TVA")
    seg = re.sub(r"<[^>]+>", " ", h[i:i + 400]) if i >= 0 else ""
    m = re.search(r"([\d][\d\s]*(?:[.,]\d+)?)\s*MDL", seg)
    t["budget"] = clean(m.group(1)) if m else ""

    m = re.search(r"Perioada (?:de depunere a ofertelor|depunerii ofertelor):?\s*"
                  r"(?:</[^>]+>\s*<[^>]+>\s*)?([^<]{5,40}?)\s*-\s*([^<]{5,40})", h)
    if m:
        t["offers_start"] = clean(m.group(1))
        t["deadline"] = clean(m.group(2))
    else:
        t["offers_start"] = ""
        t["deadline"] = ""

    lots = re.findall(r"Lotul nr\.\s*\d+\s*-\s*([^<]{3,150})", h)
    t["lots"] = [clean(x) for x in lots]
    return t


def relevance_reason(t):
    cpv = t.get("cpv", "")
    if any(cpv.startswith(p) for p in CPV_PREFIXES):
        return f"Cod CPV relevant ({cpv.split(' - ')[0] if cpv else ''})"
    hay = (t.get("title", "") + " " + " ".join(t.get("lots", []))).lower()
    for k in KEYWORDS:
        if k.lower() in hay:
            return f"Cuvânt-cheie: «{k}»"
    return None


# ---------------- clasificare ----------------

def classify(t, now):
    """active | upcoming | check | expired"""
    dl = parse_date_ro(t.get("deadline", ""))
    st = parse_date_ro(t.get("offers_start", ""))
    pub = parse_date_ro(t.get("published", ""))
    if pub and pub < now - timedelta(days=MAX_TENDER_AGE_DAYS):
        return "archived"
    if not dl:
        return "check"          # nu putem confirma termenul-limită
    if dl < now:
        return "expired"
    if st and st > now:
        return "upcoming"       # anunțat oficial, depunerea încă n-a început
    return "active"


# ---------------- rularea principală ----------------

def collect(conn=None, progress=None):
    """Rulează colectarea. Returnează dict cu statistici."""
    own = conn is None
    conn = conn or db()
    init_db()
    now = datetime.now()
    cur = conn.execute(
        "INSERT INTO runs(started, error) VALUES(?, NULL)", (now.isoformat(),))
    run_id = cur.lastrowid
    conn.commit()

    stats = {"scanned": 0, "new_count": 0, "updated": 0, "expired": 0}
    error = None

    try:
        if progress:
            progress("Colectez lista de anunțuri recente de pe achizitii.md…")
        candidates = collect_recent_ids(progress=progress)

        stats["scanned"] = len(candidates)
        known = {r["id"] for r in conn.execute("SELECT id FROM tenders")}
        new_ids = [tid for tid in candidates if tid not in known]
        refresh_ids = [tid for tid in candidates if tid in known
                       and (conn.execute("SELECT category FROM tenders WHERE id=?",
                                         (tid,)).fetchone()["category"] in ("active", "upcoming", "check"))]
        to_fetch = new_ids + refresh_ids

        if progress:
            progress(f"Verific {len(to_fetch)} anunțuri "
                     f"({len(new_ids)} noi, {len(refresh_ids)} de reconfirmat)…")

        for i, tid in enumerate(to_fetch, 1):
            try:
                t = fetch_tender(tid)
                reason = relevance_reason(t)
                cat = classify(t, now)
                if reason and cat != "archived":
                    _upsert(conn, t, reason, cat, run_id, now, stats)
                if progress and i % 20 == 0:
                    progress(f"Verificat {i}/{len(to_fetch)}…")
            except Exception as e:
                log.warning("anunț %s: %s", tid, e)
            time.sleep(DELAY_SECONDS)

        # marchează expiratele care nu mai apar în sursă
        for row in conn.execute(
                "SELECT id, deadline_dt FROM tenders WHERE category IN ('active','upcoming','check')"):
            if row["id"] not in candidates and row["deadline_dt"]:
                dl = datetime.fromisoformat(row["deadline_dt"])
                if dl < now:
                    conn.execute("UPDATE tenders SET category='expired', last_checked=? WHERE id=?",
                                 (now.isoformat(), row["id"]))
                    stats["expired"] += 1

    except Exception as e:
        error = str(e)
        log.exception("colectare eșuată")

    conn.execute(
        "UPDATE runs SET finished=?, scanned=?, new_count=?, updated=?, expired=?, error=? WHERE id=?",
        (datetime.now().isoformat(), stats["scanned"], stats["new_count"],
         stats["updated"], stats["expired"], error, run_id))
    conn.commit()
    if own:
        conn.close()
    stats["error"] = error
    return stats


def _upsert(conn, t, reason, cat, run_id, now, stats):
    dl = parse_date_ro(t.get("deadline", ""))
    pub = parse_date_ro(t.get("published", ""))
    row = conn.execute("SELECT * FROM tenders WHERE id=?", (t["id"],)).fetchone()
    if row is None:
        conn.execute("""
            INSERT INTO tenders(id,title,buyer,buyer_idno,buyer_phone,buyer_email,
                published,published_dt,offers_start,deadline,deadline_dt,budget,
                cpv,procedure,lots,url,mtender_id,category,relevance_reason,
                first_seen,last_checked)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (t["id"], t.get("title",""), t.get("buyer",""), t.get("buyer_idno",""),
             t.get("buyer_phone",""), t.get("buyer_email",""), t.get("published",""),
             pub.isoformat() if pub else None, t.get("offers_start",""),
             t.get("deadline",""), dl.isoformat() if dl else None,
             t.get("budget",""), t.get("cpv",""), t.get("procedure",""),
             " | ".join(t.get("lots", [])), t["url"], t.get("mtender_id",""),
             cat, reason, now.isoformat(), now.isoformat()))
        stats["new_count"] += 1
    else:
        for field, new_val in (("deadline", t.get("deadline","")),
                               ("title", t.get("title","")),
                               ("budget", t.get("budget",""))):
            if (row[field] or "") != new_val:
                conn.execute(
                    "INSERT INTO changes(run_id,tender_id,field,old_value,new_value,at) VALUES(?,?,?,?,?,?)",
                    (run_id, t["id"], field, row[field] or "", new_val, now.isoformat()))
                stats["updated"] += 1
        conn.execute("""
            UPDATE tenders SET title=?, buyer=?, buyer_idno=?, buyer_phone=?, buyer_email=?,
                published=?, published_dt=?, offers_start=?, deadline=?, deadline_dt=?,
                budget=?, cpv=?, procedure=?, lots=?, category=?, relevance_reason=?,
                last_checked=? WHERE id=?""",
            (t.get("title",""), t.get("buyer",""), t.get("buyer_idno",""),
             t.get("buyer_phone",""), t.get("buyer_email",""), t.get("published",""),
             pub.isoformat() if pub else None, t.get("offers_start",""),
             t.get("deadline",""), dl.isoformat() if dl else None,
             t.get("budget",""), t.get("cpv",""), t.get("procedure",""),
             " | ".join(t.get("lots", [])), cat, reason,
             now.isoformat(), t["id"]))


if __name__ == "__main__":
    print(collect(progress=print))
