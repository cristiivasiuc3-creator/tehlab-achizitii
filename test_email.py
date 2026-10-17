# -*- coding: utf-8 -*-
"""
Test de trimitere email — Tehlab Service
=========================================
Rulează MAI ÎNTÂI fără argumente (mod verificare, nu trimite nimic):

    python3 test_email.py

Verifică că: variabilele SMTP sunt setate, conexiunea la serverul SMTP
reușește și emailul se compune corect (îl afișează pe ecran).

Doar după confirmarea explicită, trimiterea reală se face cu:

    python3 test_email.py --send
"""

import os
import smtplib
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
EMAIL_TO = [e.strip() for e in os.environ.get(
    "EMAIL_TO", "cristi.ivasiuc3@gmail.com").split(",") if e.strip()]


def build_message():
    html = """
    <h3>Test — Panou monitorizare achiziții Tehlab Service</h3>
    <p>Acesta este un email de test. Dacă l-ai primit, notificările automate
    la achiziții noi funcționează corect.</p>
    <p style="color:#888;font-size:12px">Tehlab Service · sursa datelor: achizitii.md</p>"""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Test — Monitorizare achiziții Tehlab Service"
    msg["From"] = SMTP_USER
    msg["To"] = ", ".join(EMAIL_TO)
    msg.attach(MIMEText(html, "html", "utf-8"))
    return msg


def main():
    print("=== Configurare ===")
    print(f"SMTP_HOST : {SMTP_HOST or '(LIPSEȘTE)'}")
    print(f"SMTP_PORT : {SMTP_PORT}")
    print(f"SMTP_USER : {SMTP_USER or '(LIPSEȘTE)'}")
    print(f"SMTP_PASS : {'***setată***' if SMTP_PASS else '(LIPSEȘTE)'}")
    print(f"EMAIL_TO  : {', '.join(EMAIL_TO)}")

    if not all([SMTP_HOST, SMTP_USER, SMTP_PASS]):
        print("\nEROARE: completează SMTP_HOST, SMTP_USER și SMTP_PASS în .env "
              "și încarcă-le cu `export $(grep -v ^# .env | xargs)` sau setează-le ca variabile de mediu.")
        sys.exit(1)

    print("\n=== Test conexiune SMTP ===")
    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            s.login(SMTP_USER, SMTP_PASS)
        print("Autentificare SMTP reușită.")
    except Exception as e:
        print(f"EȘUAT: {e}")
        sys.exit(1)

    msg = build_message()
    if "--send" in sys.argv:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(SMTP_USER, EMAIL_TO, msg.as_string())
        print(f"\nTRIMIS către {', '.join(EMAIL_TO)}")
    else:
        print("\nMod verificare — emailul NU a fost trimis (rulează cu --send pentru trimitere reală).")


if __name__ == "__main__":
    main()
