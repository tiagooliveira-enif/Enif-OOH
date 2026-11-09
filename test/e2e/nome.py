"""Mudar o nome (Local e Ponto) do ecrã: botão discreto na ficha; as campanhas acompanham se era o único ecrã do Local.
Corre: python3 test/e2e/nome.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8775
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
    base = {'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel quadrado', 'res': '385×385', 'limit': 14, 'order': [], 'draft': None}
    for i in ('ECR-001', 'ECR-002'):
        d = dict(base, id=i, venue='Fórum' if i == 'ECR-001' else 'Outro Local', spot='Átrio ' + i[-1])
        call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': i, 'doc': d}]}, tok)
    camp = {'id': 'C1', 'name': 'C1', 'client': 'c', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 5, 'priority': 'Normal', 'items': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 800}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]')
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); pg.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('há um botão discreto ao lado do nome', pg.locator('[data-a=edit-name]').count() == 1)
        pg.click('[data-a=edit-name]'); time.sleep(.4)
        pg.fill('#nm-venue', 'Fórum Braga'); pg.fill('#nm-spot', 'Entrada'); pg.click('form[data-form=name] button[type=submit]'); time.sleep(1.5)
        ok('a ficha mostra o nome novo', 'Fórum Braga · Entrada' in pg.inner_text('#modal-root h2'))
        time.sleep(1.5)
        st = call('GET', '/api/state', tok=tok)
        s1 = [x for x in st['screens'] if x['id'] == 'ECR-001'][0]
        ok('o servidor guardou o nome e o código ficou igual', s1['venue'] == 'Fórum Braga' and s1['spot'] == 'Entrada')
        ok('a campanha acompanhou o novo Local', [c for c in st['campaigns'] if c['id'] == 'C1'][0]['venues'] == ['Fórum Braga'])
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
