"""Teste de ponta a ponta do comprovativo: a interface lista só os conteúdos que servem ao ecrã, o player passa só os escolhidos
(sem o resto nem o spot), volta ao normal ao terminar, e nada disto fica nas passagens dos relatórios.
Corre: python3 test/e2e/comprovativo.py"""
import subprocess, os, json, time, urllib.request, tempfile, sqlite3, datetime
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); IMG = HERE + '/img/'
data = tempfile.mkdtemp(); port = 8771
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
    def upload(name, path, extra='', scr='ECR-001'):
        req = urllib.request.Request(B + '/api/upload?name=%s&mime=image/png&screens=%s&secs=3%s' % (name, scr, extra), data=open(path, 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')
        return json.loads(urllib.request.urlopen(req).read())
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 1, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'centro-comercial', 'pop': None}, 'on': 0, 'off': 24}
    scr2 = dict(scr, id='ECR-002', res='1080×1920', spot='Entrada')
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}, {'op': 'put', 'coll': 'screens', 'id': 'ECR-002', 'doc': scr2}]}, tok)
    camp_f = upload('campanha.png', IMG + 'i1.png'); p1 = upload('prova1.png', IMG + 'p1.png'); p2 = upload('prova2.png', IMG + 'p2.png'); vert = upload('vertical.png', IMG + 'vertical.png', '', 'ECR-002'); sp = upload('spot.png', IMG + 'p2.png', '&house=1')
    camp = {'id': 'C1', 'name': 'Camp', 'client': 'Cli', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 3, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': camp_f['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1}], 'sector': '', 'sales': '', 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    key = [x for x in call('GET', '/api/state', tok=tok)['screens'] if x['id'] == 'ECR-001'][0]['playerKey']
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        errs = []
        pl = br.new_context(viewport={'width': 1280, 'height': 720}, service_workers='allow').new_page(); pl.on('pageerror', lambda e: errs.append(str(e)))
        pl.goto('%s/player/?code=ECR-001&key=%s&hb=1&flush=2&refresh=5&spotgap=15' % (B, key))
        cur = lambda: pl.evaluate('window.__enif.state().cur.f')
        time.sleep(10)
        ok('antes do comprovativo passa a campanha', cur() == camp_f['id'])
        for w in (1280, 390):
            ap = br.new_context(viewport={'width': w, 'height': 900}).new_page(); ap.on('pageerror', lambda e: errs.append(str(e)))
            ap.goto(B + '/app/'); ap.wait_for_selector('#lg-email'); ap.fill('#lg-email', 't@x.pt'); ap.fill('#lg-pass', 'segredo12')
            ap.click('form[data-form=login] button[type=submit]'); ap.wait_for_selector('[data-a=nav][data-v=ecras]'); ap.click('[data-a=nav][data-v=ecras]'); time.sleep(.6)
            ap.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.6)
            ap.click('[data-a=proof-open]'); time.sleep(.5)
            names = ap.eval_on_selector_all('#pr-files .row-check', 'o=>o.map(x=>x.innerText)')
            txt = ' '.join(names)
            ok('(%d) a lista tem os conteúdos que servem ao ecrã' % w, 'prova1.png' in txt and 'prova2.png' in txt and 'campanha.png' in txt)
            ok('(%d) o conteúdo de outra resolução não aparece' % w, 'vertical.png' not in txt)
            ok('(%d) sem scroll horizontal' % w, not ap.evaluate('document.documentElement.scrollWidth>innerWidth'))
            boxes = ap.locator('#pr-files input'); n = boxes.count()
            ap.click('form[data-form=proof] button[type=submit]'); time.sleep(.4)
            ok('(%d) sem escolher nada pede 1 ou 2' % w, '1 ou 2' in ap.inner_text('#form-err'))
            if w == 1280:
                for i in range(n):
                    if ap.eval_on_selector_all('#pr-files .row-check', 'o=>o.map(x=>x.innerText)')[i].startswith(('prova1', 'prova2')): boxes.nth(i).check()
                ap.select_option('#pr-secs', '60'); ap.click('form[data-form=proof] button[type=submit]'); time.sleep(1.5)
                ok('a barra de comprovativo aparece com os dois conteúdos', 'prova1.png' in ap.inner_text('.proof-bar') and 'prova2.png' in ap.inner_text('.proof-bar'))
                seen = []
                for _ in range(5): time.sleep(3); seen.append(cur())
                print('player durante o comprovativo:', seen)
                ok('o player passa só os conteúdos do comprovativo', all(f in (p1['id'], p2['id']) for f in seen[1:]) and p1['id'] in seen + [cur()])
                ap.click('[data-a=proof-stop]'); time.sleep(2)
                ok('terminar já tira a barra', ap.locator('.proof-bar').count() == 0)
                back = []
                for _ in range(4): time.sleep(3); back.append(cur())
                print('player depois:', back)
                ok('o player volta à campanha', camp_f['id'] in back)
                ok('fica registado na ficha do ecrã', 'prova1.png' in ap.inner_text('#modal-root') and 'Não conta nos relatórios' in ap.inner_text('#modal-root'))
            ap.context.close()
        time.sleep(3)
        c = sqlite3.connect(data + '/enif-data.db')
        ok('as passagens do comprovativo não ficaram nos relatórios', c.execute("SELECT COUNT(*) FROM plays WHERE camp='__proof' OR file IN (?,?)", (p1['id'], p2['id'])).fetchone()[0] == 0)
        ok('a campanha continua a contar', c.execute("SELECT COUNT(*) FROM plays WHERE camp='C1'").fetchone()[0] >= 2)
        ok('zero erros na consola', not errs)
        if errs: print(errs)
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-200:])
print('\nFALHAS', fails)
