# -*- coding: utf-8 -*-
"""
Server Flask — Dashboard achiziții Tehlab Service
================================================
Pornire locală:   python3 server.py   →  http://localhost:5000
Variabile de mediu: vezi .env.example
"""

import csv
import io
import json
import os
import smtplib
import threading
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from functools import wraps

from flask import (Flask, g, jsonify, redirect, request, send_file,
                   send_from_directory, session)

import collector

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")          # gol = fără login (mod local)
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-change-me")
REFRESH_INTERVAL_HOURS = float(os.environ.get("REFRESH_INTERVAL_HOURS", "48"))

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
EMAIL_TO = [e.strip() for e in os.environ.get(
    "EMAIL_TO", "cristi.ivasiuc3@gmail.com").split(",") if e.strip()]

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.secret_key = SECRET_KEY

collector.init_db()

refresh_state = {"running": False, "message": "", "last_result": None}


# ---------------- helpers ----------------

def db():
    if "db" not in g:
        g.db = collector.db()
    return g.db


@app.teardown_appcontext
def close_db(_=None):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def row_to_dict(r):
    d = dict(r)
    for f in ("deadline_dt", "published_dt"):
        d[f] = d.get(f)
    return d


def auth_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if ADMIN_PASSWORD and not session.get("auth"):
            return jsonify({"error": "neautorizat"}), 401
        return f(*a, **kw)
    return wrapper


def query_tenders(args):
    where, params = ["archived=0"], []
    cat = args.get("category")
    if cat:
        cats = [c for c in cat.split(",") if c]
        where.append("category IN (%s)" % ",".join("?" * len(cats)))
        params += cats
    q = args.get("q", "").strip()
    if q:
        where.append("(title LIKE ? OR buyer LIKE ? OR cpv LIKE ? OR id LIKE ?)")
        params += [f"%{q}%"] * 4
    cpv = args.get("cpv", "").strip()
    if cpv:
        where.append("cpv LIKE ?"); params.append(f"{cpv}%")
    buyer = args.get("buyer", "").strip()
    if buyer:
        where.append("buyer LIKE ?"); params.append(f"%{buyer}%")
    for key, col in (("date_from", "published_dt"), ("date_to", "published_dt"),
                     ("deadline_from", "deadline_dt"), ("deadline_to", "deadline_dt")):
        v = args.get(key, "").strip()
        if v:
            op = ">=" if key.endswith("from") else "<="
            where.append(f"{col}{op}?"); params.append(v)
    try:
        bmin = args.get("budget_min", "").replace(",", ".")
        if bmin:
            where.append("CAST(REPLACE(REPLACE(budget,' ',''),',','.') AS REAL)>=?")
            params.append(float(bmin))
        bmax = args.get("budget_max", "").replace(",", ".")
        if bmax:
            where.append("CAST(REPLACE(REPLACE(budget,' ',''),',','.') AS REAL)<=?")
            params.append(float(bmax))
    except ValueError:
        pass

    order = "deadline_dt IS NULL, deadline_dt ASC"
    if args.get("sort") == "deadline_desc":
        order = "deadline_dt DESC"
    elif args.get("sort") == "published_desc":
        order = "published_dt DESC"
    elif args.get("sort") == "budget_desc":
        order = "CAST(REPLACE(REPLACE(budget,' ',''),',','.') AS REAL) DESC"

    page = max(1, int(args.get("page", 1)))
    per = min(100, max(5, int(args.get("per_page", 12))))
    total = db().execute(f"SELECT COUNT(*) c FROM tenders WHERE {' AND '.join(where)}",
                         params).fetchone()["c"]
    rows = db().execute(
        f"SELECT * FROM tenders WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ? OFFSET ?",
        params + [per, (page - 1) * per]).fetchall()
    return [row_to_dict(r) for r in rows], total, page, per


# ---------------- auth ----------------

@app.post("/api/login")
def login():
    data = request.get_json(force=True)
    if ADMIN_PASSWORD and data.get("password") == ADMIN_PASSWORD:
        session["auth"] = True
        return jsonify({"ok": True})
    return jsonify({"ok": False}), 401


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/me")
def me():
    return jsonify({"auth_required": bool(ADMIN_PASSWORD),
                    "authenticated": bool(session.get("auth")) or not ADMIN_PASSWORD})


# ---------------- API ----------------

@app.get("/api/stats")
@auth_required
def stats():
    conn = db()
    def c(sql, *p):
        return conn.execute(sql, p).fetchone()["c"]
    now7 = datetime.now()
    from datetime import timedelta
    week = (now7 + timedelta(days=7)).isoformat()
    data = {
        "active": c("SELECT COUNT(*) c FROM tenders WHERE category='active' AND archived=0"),
        "upcoming": c("SELECT COUNT(*) c FROM tenders WHERE category='upcoming' AND archived=0"),
        "check": c("SELECT COUNT(*) c FROM tenders WHERE category='check' AND archived=0"),
        "expiring7": c("SELECT COUNT(*) c FROM tenders WHERE category IN ('active','upcoming') "
                       "AND deadline_dt IS NOT NULL AND deadline_dt<=? AND archived=0", week),
        "saved": c("SELECT COUNT(*) c FROM saved"),
        "total": c("SELECT COUNT(*) c FROM tenders WHERE archived=0"),
    }
    last = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    data["last_run"] = dict(last) if last else None
    data["refresh"] = dict(refresh_state)
    return jsonify(data)


@app.get("/api/tenders")
@auth_required
def tenders():
    items, total, page, per = query_tenders(request.args)
    saved_ids = {r["tender_id"] for r in db().execute("SELECT tender_id FROM saved")}
    for it in items:
        it["saved"] = it["id"] in saved_ids
    return jsonify({"items": items, "total": total, "page": page, "per_page": per})


@app.get("/api/tenders/<tid>")
@auth_required
def tender_detail(tid):
    r = db().execute("SELECT * FROM tenders WHERE id=?", (tid,)).fetchone()
    if not r:
        return jsonify({"error": "negăsit"}), 404
    d = row_to_dict(r)
    d["changes"] = [dict(c) for c in db().execute(
        "SELECT * FROM changes WHERE tender_id=? ORDER BY at DESC", (tid,))]
    sv = db().execute("SELECT * FROM saved WHERE tender_id=?", (tid,)).fetchone()
    d["saved"] = dict(sv) if sv else None
    return jsonify(d)


# ---- salvate ----

@app.post("/api/saved")
@auth_required
def save_item():
    data = request.get_json(force=True)
    tid = data.get("tender_id")
    if not tid:
        return jsonify({"error": "lipsă tender_id"}), 400
    db().execute(
        "INSERT OR IGNORE INTO saved(tender_id, note, created_at) VALUES(?,?,?)",
        (tid, data.get("note", ""), datetime.now().isoformat()))
    db().commit()
    return jsonify({"ok": True})


@app.delete("/api/saved/<tid>")
@auth_required
def unsave_item(tid):
    db().execute("DELETE FROM saved WHERE tender_id=?", (tid,))
    db().commit()
    return jsonify({"ok": True})


@app.patch("/api/saved/<tid>")
@auth_required
def update_saved(tid):
    data = request.get_json(force=True)
    db().execute("UPDATE saved SET note=?, done=? WHERE tender_id=?",
                 (data.get("note", ""), 1 if data.get("done") else 0, tid))
    db().commit()
    return jsonify({"ok": True})


# ---- rapoarte / istoric ----

@app.get("/api/runs")
@auth_required
def runs():
    rows = db().execute("SELECT * FROM runs ORDER BY id DESC LIMIT 30").fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/changes")
@auth_required
def changes():
    rows = db().execute(
        "SELECT ch.*, t.title FROM changes ch LEFT JOIN tenders t ON t.id=ch.tender_id "
        "ORDER BY ch.at DESC LIMIT 50").fetchall()
    return jsonify([dict(r) for r in rows])


# ---- export ----

EXPORT_COLS = ["id", "title", "buyer", "published", "deadline", "budget",
               "cpv", "procedure", "category", "url", "relevance_reason"]


@app.get("/api/export.csv")
@auth_required
def export_csv():
    items, _, _, _ = query_tenders(request.args)
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=EXPORT_COLS, extrasaction="ignore")
    w.writeheader()
    w.writerows(items)
    return send_file(io.BytesIO(out.getvalue().encode("utf-8-sig")),
                     mimetype="text/csv", as_attachment=True,
                     download_name=f"achizitii_tehlab_{datetime.now():%Y%m%d}.csv")


@app.get("/api/export.pdf")
@auth_required
def export_pdf():
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as pdfcanvas

    items, _, _, _ = query_tenders(request.args)
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=landscape(A4))
    W, H = landscape(A4)
    font = "Helvetica"

    def draw_row(c, y, cells, widths, bold=False):
        x = 12 * mm
        c.setFont(font, 8 if not bold else 8.5)
        for cell, w in zip(cells, widths):
            text = str(cell or "")[:int(w / 2.2)]
            c.drawString(x + 1 * mm, y, text)
            x += w
        return y - 5.5 * mm

    c.setFont(font, 14)
    c.drawString(12 * mm, H - 15 * mm, "Raport achiziții — Tehlab Service")
    c.setFont(font, 8)
    c.drawString(12 * mm, H - 20 * mm,
                 f"Generat la {datetime.now():%d.%m.%Y %H:%M} · {len(items)} înregistrări")
    y = H - 28 * mm
    widths = [14*mm, 75*mm, 55*mm, 22*mm, 24*mm, 20*mm, 30*mm]
    y = draw_row(c, y, ["ID", "Denumire", "Autoritate", "Publicat", "Termen",
                        "Valoare MDL", "CPV"], widths, bold=True)
    c.line(12 * mm, y + 3 * mm, W - 12 * mm, y + 3 * mm)
    for t in items:
        if y < 15 * mm:
            c.showPage()
            y = H - 15 * mm
        y = draw_row(c, y, [t["id"], t["title"], t["buyer"], t["published"],
                            t["deadline"], t["budget"], t["cpv"]], widths)
    c.save()
    buf.seek(0)
    return send_file(buf, mimetype="application/pdf", as_attachment=True,
                     download_name=f"achizitii_tehlab_{datetime.now():%Y%m%d}.pdf")


# ---- refresh ----

def _run_refresh():
    refresh_state.update(running=True, message="Pornesc colectarea…")
    try:
        result = collector.collect(progress=lambda m: refresh_state.update(message=m))
        refresh_state["last_result"] = result
        if result.get("new_count"):
            send_email_notification(result)
        refresh_state["message"] = "Colectare finalizată."
    except Exception as e:
        refresh_state["message"] = f"Eroare: {e}"
    finally:
        refresh_state["running"] = False


def send_email_notification(result):
    if not (SMTP_HOST and SMTP_USER and SMTP_PASS and EMAIL_TO):
        return
    rows = db().execute(
        "SELECT title, buyer, budget, deadline, url FROM tenders "
        "ORDER BY first_seen DESC LIMIT ?", (result.get("new_count", 10),)).fetchall()
    body = "".join(
        f"<li><a href='{r['url']}'>{r['title']}</a> — {r['buyer']} · "
        f"{r['budget'] or '—'} MDL · termen: {r['deadline'] or '—'}</li>"
        for r in rows)
    html = (f"<h3>Tehlab Service — {result['new_count']} achiziții noi</h3>"
            f"<ul>{body}</ul><p>Vezi detaliile în dashboard.</p>")
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Achiziții noi — {result['new_count']} anunțuri"
        msg["From"] = SMTP_USER
        msg["To"] = ", ".join(EMAIL_TO)
        msg.attach(MIMEText(html, "html", "utf-8"))
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as s:
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_USER, EMAIL_TO, msg.as_string())
    except Exception:
        app.logger.exception("notificare email eșuată")


@app.post("/api/refresh")
@auth_required
def refresh():
    if refresh_state["running"]:
        return jsonify({"ok": False, "message": "Actualizarea deja rulează"}), 409
    threading.Thread(target=_run_refresh, daemon=True).start()
    return jsonify({"ok": True})


@app.get("/api/refresh/status")
@auth_required
def refresh_status():
    return jsonify(refresh_state)


# ---- frontend ----

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


def _schedule():
    """Rulează colectarea automat la fiecare REFRESH_INTERVAL_HOURS ore."""
    import time
    while True:
        time.sleep(REFRESH_INTERVAL_HOURS * 3600)
        if not refresh_state["running"]:
            _run_refresh()


if os.environ.get("ENABLE_SCHEDULER", "1") == "1":
    threading.Thread(target=_schedule, daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
