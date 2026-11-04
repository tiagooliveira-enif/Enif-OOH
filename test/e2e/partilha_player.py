"""Posição partilhada no player: duas campanhas partilham uma posição e têm de passar à vez, volta a volta.
Corre: python3 test/e2e/partilha_player.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
data = tempfile.mkdtemp(); port = 8771
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
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
    def upload(name, secs):
        req = urllib.request.Request(B + '/api/upload?name=%s&mime=image/png&screens=ECR-001&secs=%d' % (name, secs), data=open(SP + '/i1.png', 'rb').read(), headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/octet-stream'}, method='PUT')
        try: return json.loads(urllib.request.urlopen(req).read())
        except urllib.error.HTTPError as e: print(e.read()); raise
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 14, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'centro-comercial', 'pop': None}, 'on': 0, 'off': 24}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    f = {n: upload(n + '.png', 5) for n in ('o1', 'o2', 'o3', 'a1', 'b1', 'b2')}
    sp = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/upload?name=sp.png&mime=image/png&screens=ECR-001&secs=5&house=1', data=open(SP + '/sp.png', 'rb').read(), headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/octet-stream'}, method='PUT')).read())
    def camp(i, items, share=None):
        return {'id': i, 'name': i, 'client': 'Cli', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 5, 'priority': 'Normal', 'manual': False, 'color': 1, 'share': share, 'items': [{'f': f[n]['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1} for n in items], 'pauses': []}
    ops = [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}] + [{'op': 'put', 'coll': 'campaigns', 'id': i, 'doc': camp(i, it, sh)} for i, it, sh in (('O1', ['o1'], None), ('O2', ['o2'], None), ('O3', ['o3'], None), ('A', ['a1'], 'g'), ('B', ['b1', 'b2'], 'g'))]
    call('POST', '/api/sync', {'ops': ops}, tok)
    key = call('GET', '/api/state', tok=tok)['screens'][0]['playerKey']
    pl = call('GET', '/api/player/playlist?code=ECR-001&key=' + key)
    import datetime
    h = str(datetime.datetime.now().hour); day = list(pl['days'].values())[0][h]
    print('seq do servidor:', [e['c'] for e in day['seq']])
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        pg = br.new_context(viewport={'width': 1280, 'height': 720}).new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('%s/player/?code=ECR-001&key=%s&hb=2&flush=2&refresh=5' % (B, key))
        time.sleep(75)
        plays = call('GET', '/api/plays?from=2020-01-01&to=2099-01-01', tok=tok)
        print(str(plays)[:600])
        pg.keyboard.press('d'); time.sleep(1); txt = pg.inner_text('#dbg'); print(txt)
        ok('o painel D mostra a volta com as duas campanhas partilhadas', 'volta:' in txt and ' A' in txt.replace('▶', ' ') and ' B' in txt.replace('▶', ' '))
        ok('as duas campanhas partilhadas passaram', {r['c'] for r in plays['rows']} >= {'A', 'B'})
        print([ (r['c'],r['n']) for r in plays['rows']])
        br.close()
finally:
    srv.terminate()
print('FALHAS', fails)
