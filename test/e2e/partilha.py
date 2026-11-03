"""Posição partilhada: escolher «Partilha com…» numa campanha tem de chegar ao servidor (as duas campanhas ficam no mesmo grupo) e sobreviver a recarregar.
Corre: python3 test/e2e/partilha.py"""
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
    c3 = camp('C3', 'Outra'); c3['ivs'] = [[8, 12], [14, 18]]; c3['h0'] = 8; c3['h1'] = 18
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}] + [{'op': 'put', 'coll': 'campaigns', 'id': i, 'doc': camp(i, n)} for i, n in (('C1', 'Leroy Merlin'), ('C2', 'Leroy Merlin 40'))] + [{'op': 'put', 'coll': 'campaigns', 'id': 'C3', 'doc': c3}]}, tok)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        ctx = br.new_context(viewport={'width': 1300, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=campanhas]')
        pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.6)
        pg.locator('[data-a=edit-camp][data-id=C1]').first.click(); time.sleep(.5)
        print('opções:', pg.eval_on_selector_all('#c-share option', 'o=>o.map(x=>x.value+"|"+x.textContent)'))
        pg.select_option('#c-share', 'C2'); time.sleep(.2)
        pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(1.5)
        print('toast/erro:', pg.inner_text('#modal-root')[:200] if pg.locator('#modal-root form').count() else 'modal fechou')
        st = call('GET', '/api/state', tok=tok); cs_ = {c['id']: c.get('share') for c in st['campaigns']}
        print('shares no servidor:', cs_)
        ok('as duas campanhas ficam com o mesmo grupo no servidor', cs_['C1'] and cs_['C1'] == cs_['C2'] and not cs_['C3'])
        pg.reload(); pg.wait_for_selector('[data-a=nav][data-v=campanhas]'); time.sleep(1)
        ok('os intervalos da campanha C3 continuam no servidor', [c for c in call('GET', '/api/state', tok=tok)['campaigns'] if c['id'] == 'C3'][0].get('ivs') == [[8, 12], [14, 18]])
        pg.locator('[data-a=edit-camp][data-id=C3]').first.click(); time.sleep(.5)
        pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(1.5)
        ok('guardar a C3 sem mexer mantém os dois intervalos', [c for c in call('GET', '/api/state', tok=tok)['campaigns'] if c['id'] == 'C3'][0].get('ivs') == [[8, 12], [14, 18]])
        pl = call('GET', '/api/state', tok=tok)
        pg.locator('[data-a=edit-camp][data-id=C2]').first.click(); time.sleep(.5)
        ok('depois de recarregar, a ficha mostra o grupo', 'Neste grupo' in pg.inner_text('#modal-root'))
        pg.locator('[data-a=edit-camp][data-id=C1]').first.click(); time.sleep(.5)
        pg.select_option('#c-share', ''); time.sleep(.2)
        pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(1.5)
        cs2 = {c['id']: c.get('share') for c in call('GET', '/api/state', tok=tok)['campaigns']}
        ok('«Não partilha» também fica guardado no servidor (o grupo desfaz-se)', not cs2['C1'] and not cs2['C2'])
        ok('zero erros na consola', not errs)
        br.close()
    pl = None
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-300:]); cs.shutdown(); ovs.shutdown()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
