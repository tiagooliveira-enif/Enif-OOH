"""Campanha sem fim: botão «Sem fim» ao lado do Fim; guarda com fim 2099 e noEnd; volta a pedir a data quando se carrega em «Definir fim».
Corre: python3 test/e2e/semfim.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8776
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
        pg = br.new_context(viewport={'width': 1280, 'height': 900}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=campanhas]')
        pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.8)
        pg.locator('[data-a=edit-camp]').first.click(); time.sleep(.6)
        ok('o campo Fim tem o botão «Sem fim»', pg.inner_text('#c-noend-btn') == 'Sem fim' and pg.is_visible('#c-end'))
        pg.click('#c-noend-btn'); time.sleep(.2)
        ok('ao carregar, a data some e aparece «Sem fim»', pg.locator('#c-end-open').count() == 1 and not pg.is_visible('#c-end') and pg.inner_text('#c-noend-btn') == 'Definir fim')
        pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(2.5)
        c = [x for x in call('GET', '/api/state', tok=tok)['campaigns'] if x['id'] == 'C1'][0]
        ok('o servidor guardou noEnd com fim 2099', c['noEnd'] is True and c['end'] == '2099-12-31')
        pg.locator('[data-a=edit-camp]').first.click(); time.sleep(.6)
        ok('ao reabrir continua sem fim', pg.locator('#c-end-open').count() == 1)
        pg.click('#c-noend-btn'); time.sleep(.2)
        ok('«Definir fim» volta a mostrar a data', pg.is_visible('#c-end') and pg.locator('#c-end-open').count() == 0)
        pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(2.5)
        c = [x for x in call('GET', '/api/state', tok=tok)['campaigns'] if x['id'] == 'C1'][0]
        ok('guardar com data volta ao normal', c['noEnd'] is False and c['end'] != '2099-12-31')
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
