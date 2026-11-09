"""Falhas de reprodução: botão escondido na ficha do ecrã; ao carregar mostra a lista com o motivo; «Esconder» volta a escondê-la.
Corre: python3 test/e2e/falhas.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8774
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.5); B = 'http://127.0.0.1:%d' % port
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
def call(m, p, body=None, tok=None):
    h = {'Content-Type': 'application/json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, headers=h, method=m)).read() or b'null')
    except urllib.error.HTTPError as e: print(e.read()); raise
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel quadrado', 'res': '385×385', 'limit': 14, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}, 'on': 0, 'off': 24}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    req = urllib.request.Request(B + '/api/upload?name=a.png&mime=image/png&screens=ECR-001&secs=5', data=open(SP + '/sq.png', 'rb').read(), headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/octet-stream'}, method='PUT')
    f = json.loads(urllib.request.urlopen(req).read())
    camp = {'id': 'C1', 'name': 'C1', 'client': 'c', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 5, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': f['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1}], 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    st = call('GET', '/api/state', tok=tok); key = st['screens'][0]['playerKey']
    call('POST', '/api/player/plays', {'code': 'ECR-001', 'key': key, 'plays': [{'pid': 'f1', 'c': 'C1', 'f': f['id'], 'ts': int(time.time() * 1000), 'dur': 0, 'ok': 0, 'why': 'não arrancou em 8 segundos'}]})
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 800}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]')
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); pg.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('as falhas começam escondidas', pg.locator('[data-a=fails]').count() == 1 and 'não arrancou' not in pg.inner_text('#modal-root'))
        pg.click('[data-a=fails]'); time.sleep(1)
        t = pg.inner_text('#modal-root')
        ok('ao carregar aparece a lista com campanha, vídeo e motivo', 'não arrancou em 8 segundos' in t and 'C1' in t)
        pg.click('[data-a=fails-hide]'); time.sleep(.5)
        ok('«Esconder» volta a esconder', pg.locator('[data-a=fails]').count() == 1 and 'não arrancou' not in pg.inner_text('#modal-root'))
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
