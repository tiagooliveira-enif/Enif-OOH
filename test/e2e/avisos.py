"""Teste de ponta a ponta do aviso «campanha abaixo do contratado» e da «Ocupação por mês» (Disponibilidade).
Corre: python3 test/e2e/avisos.py"""
import subprocess, os, json, time, urllib.request, tempfile, sqlite3, datetime
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); IMG = HERE + '/img/'
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
    return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, headers=h, method=m)).read() or b'null')
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 5, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'centro-comercial', 'pop': None}, 'on': 0, 'off': 24}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    req = urllib.request.Request(B + '/api/upload?name=a.png&mime=image/png&screens=ECR-001&secs=3', data=open(IMG + 'i1.png', 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')
    f = json.loads(urllib.request.urlopen(req).read())
    camp = {'id': 'C1', 'name': 'Campanha Teste', 'client': 'Cli', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 2, 'dur': 10, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': f['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 2}], 'sector': '', 'sales': '', 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    key = call('GET', '/api/state', tok=tok)['screens'][0]['playerKey']
    call('POST', '/api/player/heartbeat', {'code': 'ECR-001', 'key': key, 'ver': '4', 'w': 1920, 'h': 1080})
    c = sqlite3.connect(data + '/enif-data.db'); c.execute('UPDATE live SET first_seen=?', (int((time.time() - 86400) * 1000),)); c.commit(); c.close()
    time.sleep(61)   # a conta fica guardada 1 minuto
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        for w in (1280, 390):
            pg = br.new_context(viewport={'width': w, 'height': 900}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
            pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=campanhas]'); time.sleep(1.2)
            t = pg.inner_text('#view')
            ok('(%d) o painel mostra «abaixo do contratado»' % w, 'Campanha Teste' in t and 'abaixo do contratado' in t and 'Não aparece nos relatórios' in t)
            ok('(%d) há «Ver campanha»' % w, pg.locator('[data-a=edit-camp]:has-text("Ver campanha")').count() == 1)
            pg.locator('[data-a=edit-camp]:has-text("Ver campanha")').first.click(); time.sleep(.4)
            ok('(%d) «Ver campanha» abre a campanha' % w, pg.eval_on_selector_all('#modal-root input[name=name]', 'o=>o.map(x=>x.value)') == ['Campanha Teste']); pg.keyboard.press('Escape')
            pg.click('#head [data-a=notifs]'); time.sleep(.4)
            ok('(%d) chega às notificações' % w, 'abaixo do contratado' in pg.inner_text('#modal-root')); pg.keyboard.press('Escape')
            pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.4); pg.click('[data-a=camp-tab][data-t=disp]'); time.sleep(.6)
            ok('(%d) ocupação por mês: ecrã + média da rede, 3 meses' % w, pg.locator('.occ-r').count() == 3 and pg.locator('.occ-h span').count() == 4)
            ok('(%d) a ocupação tem percentagens' % w, '%' in pg.inner_text('.occ'))
            ok('(%d) sem scroll horizontal' % w, not pg.evaluate('document.documentElement.scrollWidth>innerWidth'))
            if w == 390:
                pg.click('[data-a=nav][data-v=painel]'); time.sleep(.4)
                pg.click('[data-a=resolve-alert]'); time.sleep(1.5)
                ok('marcar como resolvido tira o aviso (e continua resolvido)', 'abaixo do contratado' not in pg.inner_text('#view'))
            pg.context.close()
        ok('zero erros na consola', not errs)
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-200:])
print('\nFALHAS', fails)
