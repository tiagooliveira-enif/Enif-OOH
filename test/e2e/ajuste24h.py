"""Os avisos «Ajuste automático» da playlist aparecem ao início e saem 24 h depois. Também se podem ocultar com um botão. Corre: python3 test/e2e/ajuste24h.py"""
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
    scr = {'id': 'ECR-001', 'venue': 'Praça Teste', 'city': 'Braga', 'spot': 'Centro', 'type': 'Painel quadrado', 'res': '385×385', 'limit': 14, 'order': [], 'draft': None, 'on': 0, 'off': 24, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    from PIL import Image
    import io
    buf = io.BytesIO(); Image.new('RGB', (384, 384), (200, 30, 30)).save(buf, 'PNG')
    req = urllib.request.Request(B + '/api/upload?name=a.png&mime=image/png&screens=ECR-001&secs=3', data=buf.getvalue(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')
    f = json.loads(urllib.request.urlopen(req).read())
    camp = {'id': 'C1', 'name': 'Camp Um', 'client': 'c', 'venues': ['Praça Teste'], 'start': (today - datetime.timedelta(days=1)).isoformat(), 'end': (today + datetime.timedelta(days=5)).isoformat(), 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 10, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': f['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1}], 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    key = call('GET', '/api/state', tok=tok)['screens'][0]['playerKey']
    call('POST', '/api/player/heartbeat', {'code': 'ECR-001', 'key': key, 'ver': '4', 'w': 385, 'h': 385})
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
        ok('o aviso «Ajuste automático» aparece', 'Ajuste automático' in pg.inner_text('body'))
        time.sleep(1.5)
        me = [u for u in call('GET', '/api/state', tok=tok)['users'] if u.get('admin')][0]
        fs = (me.get('ui') or {}).get('fitSeen') or {}
        ok('a hora do primeiro aviso fica guardada na conta', len(fs) == 1)
        entrar()
        ok('continua a aparecer nas primeiras 24 h', 'Ajuste automático' in pg.inner_text('body'))
        pg.click('[data-a=fit-hide]'); time.sleep(.6)
        ok('«Ocultar avisos de ajuste» esconde-os e deixa a nota «oculto»', 'Ajuste automático' not in pg.inner_text('body') and 'oculto' in pg.inner_text('body'))
        time.sleep(1.5); entrar()
        ok('continuam ocultos depois de recarregar', 'Ajuste automático' not in pg.inner_text('body') and 'oculto' in pg.inner_text('body'))
        pg.click('[data-a=fit-show]'); time.sleep(.6)
        ok('«Mostrar» traz-os de volta', 'Ajuste automático' in pg.inner_text('body'))
        time.sleep(1.5)
        me = [u for u in call('GET', '/api/state', tok=tok)['users'] if u.get('admin')][0]
        ui = dict(me.get('ui') or {}); ui['fitSeen'] = {k: int(time.time() * 1000) - 25 * 3600 * 1000 for k in fs}
        doc = dict(me); doc['ui'] = ui
        call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'users', 'id': me['id'], 'doc': doc, 'keys': ['ui']}]}, tok)
        entrar()
        ok('passadas 24 h o aviso sai', 'Ajuste automático' not in pg.inner_text('body'))
        ok('zero erros na consola', not errs)
        br.close()
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-300:]); cs.shutdown(); ovs.shutdown()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
