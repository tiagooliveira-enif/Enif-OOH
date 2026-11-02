"""Ignorar avisos da playlist: o aviso «passa 0,86 vezes por minuto» pode ser ignorado, fica ignorado depois de recarregar, e «Voltar a mostrar» traz-o de volta.
Corre: python3 test/e2e/ignorar.py"""
import subprocess, os, json, time, urllib.request, tempfile, threading, http.server, datetime
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8767; cport = 8768
def fmt(h): return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=h)).strftime('%Y%m%dT%H%M%SZ')
def ev(uid, t, h): return 'BEGIN:VEVENT\r\nUID:%s\r\nSUMMARY:%s\r\nDESCRIPTION:Detalhe %s\r\nDTSTART:%s\r\nEND:VEVENT\r\n' % (uid, t, uid, fmt(h))
ics = 'BEGIN:VCALENDAR\r\n' + ev('a', 'SPOTS DIGITAIS - Entrega', 30) + ev('b', 'SPOTS DIGITAIS - Reuniao', 44) + ev('c', 'SPOTS DIGITAIS - Instalacao', 110) + ev('d', 'Almoco', 20) + 'END:VCALENDAR\r\n'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.send_header('Content-Type', 'text/calendar'); self.end_headers(); self.wfile.write(ics.encode())
    def log_message(self, *a): pass
cs = http.server.ThreadingHTTPServer(('127.0.0.1', cport), H); threading.Thread(target=cs.serve_forever, daemon=True).start()
class OV(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'elements': [{'tags': {'shop': 'x'}}, {'tags': {'shop': 'y'}}, {'tags': {'amenity': 'cafe'}}, {'tags': {'highway': 'bus_stop'}}]}).encode())
    def log_message(self, *a): pass
ovs = http.server.ThreadingHTTPServer(('127.0.0.1', 8769), OV); threading.Thread(target=ovs.serve_forever, daemon=True).start()
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='Tiago', ADMIN_EMAIL='t@enif.pt', ADMIN_PASS='palavra-passe-longa', PORT=str(port), CAL_ICS_URL='http://127.0.0.1:%d/segredo.ics' % cport, CAL_ALLOW_HTTP='1', POI_URL='http://127.0.0.1:8769/api/interpreter', POI_ALLOW_HTTP='1')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.5); B = 'http://127.0.0.1:%d' % port
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
def call(m, p, body=None, tok=None):
    h = {'Content-Type': 'application/json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, headers=h, method=m)).read() or b'null')
try:
    tok = call('POST', '/api/login', {'email': 't@enif.pt', 'pass': 'palavra-passe-longa'})['token']
    today = datetime.date.today()
    scr = {'id': 'ECR-001', 'venue': 'Praça Teste', 'city': 'Braga', 'spot': 'Centro', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 14, 'order': [], 'draft': None, 'on': 0, 'off': 24, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}}
    def camp(i, n):
        return {'id': i, 'name': n, 'client': 'c', 'venues': ['Praça Teste'], 'start': (today - datetime.timedelta(days=1)).isoformat(), 'end': (today + datetime.timedelta(days=5)).isoformat(), 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 10, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [], 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}] + [{'op': 'put', 'coll': 'campaigns', 'id': 'C%d' % i, 'doc': camp('C%d' % i, 'Camp %d' % i)} for i in range(1, 8)]}, tok)
    key = call('GET', '/api/state', tok=tok)['screens'][0]['playerKey']
    call('POST', '/api/player/heartbeat', {'code': 'ECR-001', 'key': key, 'ver': '4', 'w': 1920, 'h': 1080})
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        ctx = br.new_context(viewport={'width': 1300, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        def entrar():
            pg.goto(B + '/app/'); time.sleep(1.5)
            if pg.locator('#lg-email').count():
                pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa'); pg.click('form[data-form=login] button[type=submit]')
            pg.wait_for_selector('[data-a=nav][data-v=ecras]')
            pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); pg.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        entrar()
        ok('há um conflito de passagens por minuto com botão Ignorar', pg.locator('.pl-warn:has-text("por minuto") [data-a=ign-issue]').count() >= 1)
        pg.locator('[data-a=ign-issue]').first.click(); time.sleep(.6)
        ok('depois de ignorar o aviso desaparece e fica a nota «ignorado»', pg.locator('.pl-warn:has-text("por minuto")').count() == 0 and 'ignorado' in pg.inner_text('body'))
        time.sleep(1.5); entrar()
        ok('continua ignorado depois de recarregar', pg.locator('.pl-warn:has-text("por minuto")').count() == 0 and 'ignorado' in pg.inner_text('body'))
        pg.locator('[data-a=ign-reset]').first.click(); time.sleep(.6)
        ok('«Voltar a mostrar» traz o aviso de volta', pg.locator('.pl-warn:has-text("por minuto")').count() >= 1)
        ok('zero erros na consola', not errs)
        br.close()
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-300:]); cs.shutdown(); ovs.shutdown()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
