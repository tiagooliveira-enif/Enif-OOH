"""Área do PC: por defeito o player enche a janela; com «área» desenha só com o tamanho do ecrã, num canto ou ao centro.
Corre: python3 test/e2e/area.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8772
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
    ok('por defeito o ecrã fica em «inteiro»', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['area'] == 'inteiro')
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 720}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        box = lambda: pg.evaluate("(()=>{const r=document.querySelector('#stage').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})()")
        pg.goto('%s/player/?code=ECR-001&key=%s&hb=2&flush=2&refresh=2' % (B, key)); time.sleep(5)
        ok('«inteiro»: o palco enche a janela', box() == [0, 0, 1280, 720])
        for a, want in (('tl', [0, 0, 385, 385]), ('tr', [895, 0, 385, 385]), ('bl', [0, 335, 385, 385]), ('br', [895, 335, 385, 385]), ('c', [448, 168, 385, 385])):
            scr['area'] = a; call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok); time.sleep(5)
            ok('«%s»: palco %s' % (a, want), box() == want)
        scr['area'] = 'tl'; call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok); time.sleep(5)
        ok('o conteúdo passa dentro da área', pg.evaluate("document.querySelectorAll('#stage img').length")>=1 and pg.evaluate("(()=>{const r=document.querySelector('#stage img').getBoundingClientRect();return r.width<=386&&r.height<=386})()"))
        scr['area'] = 'inteiro'; call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok); time.sleep(5)
        ok('voltar a «inteiro» devolve a janela toda', box() == [0, 0, 1280, 720])
        ok('sem erros JS no player', not errs)
        # interface: o seletor existe na ficha e guarda no servidor
        ap = br.new_context(viewport={'width': 1300, 'height': 900}).new_page(); ap.on('pageerror', lambda e: errs.append(str(e)))
        ap.goto(B + '/app/'); ap.wait_for_selector('#lg-email'); ap.fill('#lg-email', 't@x.pt'); ap.fill('#lg-pass', 'segredo12')
        ap.click('form[data-form=login] button[type=submit]'); ap.wait_for_selector('[data-a=nav][data-v=ecras]')
        ap.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); ap.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('a ficha tem o seletor «Área do PC» em «Ecrã inteiro»', ap.locator('select[data-a-change=area]').count() == 1 and ap.locator('select[data-a-change=area]').input_value() == 'inteiro')
        ap.select_option('select[data-a-change=area]', 'tl'); time.sleep(2.5)
        ok('a escolha chega ao servidor', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['area'] == 'tl')
        ap.reload(); ap.wait_for_selector('[data-a=nav][data-v=ecras]'); ap.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); ap.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('depois de recarregar a ficha continua em «canto superior esquerdo»', ap.locator('select[data-a-change=area]').input_value() == 'tl')
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
