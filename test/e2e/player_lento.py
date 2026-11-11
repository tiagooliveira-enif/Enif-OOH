"""Ecrã novo com descarga lenta dos vídeos: o player dá sinal (fica fora de «Por emparelhar») sem esperar pela descarga.
Corre: python3 test/e2e/player_lento.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8781
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
    held = []
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 800, 'height': 600}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route('**/media/**', lambda r: held.append(r))          # a descarga dos vídeos fica presa (ligação lenta)
        pg.goto(B + '/player/?code=ECR-001&key=' + key)
        estado = 'novo'
        for i in range(25):
            time.sleep(1)
            estado = [s for s in call('GET', '/api/state', tok=tok)['screens'] if s['id'] == 'ECR-001'][0]['status']
            if estado != 'novo': break
        for i in range(10):
            if held: break
            time.sleep(.5)
        ok('com a descarga presa, o ecrã já deu sinal (estado ' + estado + ')', estado != 'novo')
        for r in held:
            try: r.continue_()
            except Exception: pass
        time.sleep(2)
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
