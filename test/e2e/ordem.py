"""Calendário de campanhas: a mais recente em cima; o botão troca a ordem e a escolha fica guardada na conta.
Corre: python3 test/e2e/ordem.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8778
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
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C2', 'doc': dict(camp, id='C2', name='Segunda')}]}, tok)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        ctx = br.new_context(viewport={'width': 1280, 'height': 900}); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        def entrar():
            pg.goto(B + '/app/'); time.sleep(1.5)
            if pg.locator('#lg-email').count():
                pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12'); pg.click('form[data-form=login] button[type=submit]')
            pg.wait_for_selector('[data-a=nav][data-v=campanhas]')
            pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.8)
        nomes = lambda: pg.eval_on_selector_all('[data-a=edit-camp]', 'e=>e.map(x=>x.textContent.trim())')
        entrar()
        n = nomes()
        ok('por defeito a mais recente fica em cima', n[0].startswith('Segunda') and n[1].startswith('C1'))
        ok('o botão diz «Mais recentes primeiro»', pg.inner_text('[data-a=ccal]') == 'Mais recentes primeiro')
        pg.click('[data-a=ccal]'); time.sleep(.5)
        n = nomes()
        ok('depois de carregar, a mais antiga fica em cima', n[0].startswith('C1') and n[1].startswith('Segunda') and pg.inner_text('[data-a=ccal]') == 'Mais antigas primeiro')
        time.sleep(2.5)
        entrar()
        ok('a escolha fica guardada na conta', nomes()[0].startswith('C1') and pg.inner_text('[data-a=ccal]') == 'Mais antigas primeiro')
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
