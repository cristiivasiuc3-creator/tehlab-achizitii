FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000
EXPOSE 5000

# DB_PATH poate fi suprascris la pornire (ex. volum montat la /app/data).
# Implicit folosim baza semnată din imagine, cu datele reale colectate.
ENV DB_PATH=/app/tehlab.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python3 -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/api/me' % os.environ.get('PORT','5000'), timeout=4)"

CMD ["python3", "server.py"]
