"""Mínimo do grupo: o campo no cabeçalho da posição partilhada grava nas campanhas do grupo, aparece a frase «Garantido» e sobrevive a recarregar.
Corre: python3 test/e2e/gmin.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8780
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
    return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, headers=h, method=m)).read())
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 14, 'order': [], 'draft': None}
    camp = lambda i, **k: dict({'id': i, 'name': 'Camp ' + i, 'client': 'c', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 10, 'priority': 'Normal', 'items': []}, **k)
    ops = [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}] + [{'op': 'put', 'coll': 'campaigns', 'id': i, 'doc': camp(i, share='G1')} for i in ('C1', 'C2')] + [{'op': 'put', 'coll': 'campaigns', 'id': 'C3', 'doc': camp('C3')}]
    call('POST', '/api/sync', {'ops': ops}, tok)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 1000}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]')
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); pg.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('há o campo «Mínimo do grupo»', pg.locator('.gm-ctl select').count() == 1)
        pg.select_option('.gm-ctl select', '1'); time.sleep(1.5)
        ok('a frase «Garantido» aparece', 'Garantido' in pg.inner_text('.pl-ghead'))
        st = call('GET', '/api/state', tok=tok); g = {c['id']: c.get('gmin') for c in st['campaigns']}
        ok('as duas do grupo ficam com mínimo 1 e a outra não', g['C1'] == 1 and g['C2'] == 1 and not g['C3'])
        pg.reload(); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); pg.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('continua depois de recarregar', pg.eval_on_selector('.gm-ctl select', 'e=>e.value') == '1')
        pg.select_option('.gm-ctl select', '0'); time.sleep(1.5)
        g = {c['id']: c.get('gmin') for c in call('GET', '/api/state', tok=tok)['campaigns']}
        ok('«Sem mínimo» tira o mínimo às duas', not g['C1'] and not g['C2'])
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
