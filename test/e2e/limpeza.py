"""Teste de ponta a ponta da limpeza de conteúdos sem uso: aviso no painel com «Manter», separador «A expirar»,
reciclagem com «Restaurar» e prazos alteráveis (computador e telemóvel).
Corre: python3 test/e2e/limpeza.py"""
import subprocess, os, json, time, urllib.request, tempfile, sqlite3, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); IMG = HERE + '/img/'
if len(sys.argv) < 2:        # cada largura (computador e telemóvel) começa com dados novos
    raise SystemExit(max(subprocess.call([sys.executable, __file__, w]) for w in ('1280', '390')))
W = int(sys.argv[1])
data = tempfile.mkdtemp(); port = 8772 if W > 800 else 8773
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
B = 'http://127.0.0.1:%d' % port
def start():
    p = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(1.5); return p
srv = start()
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
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 1, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': '', 'pop': None}}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    def upload(name, path):
        req = urllib.request.Request(B + '/api/upload?name=%s&mime=image/png&screens=ECR-001&secs=3' % name, data=open(path, 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')
        return json.loads(urllib.request.urlopen(req).read())
    a = upload('Quase_a_caducar.png', IMG + 'i1.png'); b = upload('Ja_caducado.png', IMG + 'p1.png'); c = upload('Recente.png', IMG + 'p2.png')
    srv.terminate(); srv.wait()
    db = sqlite3.connect(data + '/enif-data.db'); day = 86400000; now = int(time.time() * 1000)
    for fid, age in ((a['id'], 50), (b['id'], 100), (c['id'], 2)):
        j = json.loads(db.execute("SELECT json FROM docs WHERE coll='contents' AND id=?", (fid,)).fetchone()[0]); j['up'] = now - age * day
        db.execute("UPDATE docs SET json=? WHERE coll='contents' AND id=?", (json.dumps(j), fid))
    db.commit(); db.close()
    srv = start(); time.sleep(6)       # o arranque faz a limpeza do dia
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    st = call('GET', '/api/state', tok=tok)
    ok('o conteúdo caducado foi para a reciclagem', [x['name'] for x in st['bin']] == ['Ja_caducado.png'] and all(x['name'] != 'Ja_caducado.png' for x in st['contents']))
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        for w in (W,):
            pg = br.new_context(viewport={'width': w, 'height': 900}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
            pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=conteudos]'); time.sleep(.8)
            t = pg.inner_text('#view')
            ok('%d: o painel avisa do conteúdo sem uso' % w, 'Quase_a_caducar.png' in t and 'vão ser apagados' not in t and 'sem uso vai ser apagado' in t)
            pg.screenshot(path='/tmp/limpeza_painel_%d.png' % w)
            pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(.5)
            seg = pg.inner_text('[aria-label=Biblioteca]').replace('\n', ' ')
            ok('%d: separadores com contagens' % w, 'A expirar 1' in seg and 'Reciclagem 1' in seg)
            ok('%d: etiqueta «Sem uso» no ficheiro' % w, pg.locator('.pill.warn:has-text("Sem uso")').count() == 1)
            pg.click('[data-a=cview][data-v=bin]'); time.sleep(.4)
            ok('%d: reciclagem mostra o ficheiro e o prazo' % w, 'Ja_caducado.png' in pg.inner_text('#view') and 'Apagado definitivamente' in pg.inner_text('#view'))
            pg.screenshot(path='/tmp/limpeza_bin_%d.png' % w)
            pg.click('[data-a=restore]'); time.sleep(1.2)
            ok('%d: «Restaurar» devolve à biblioteca' % w, pg.locator('[data-a=restore]').count() == 0)
            pg.click('[data-a=cview][data-v=lib]'); time.sleep(.4)
            ok('%d: o restaurado está na biblioteca' % w, 'Ja_caducado.png' in pg.inner_text('#view'))
            pg.click('[data-a=cview][data-v=exp]'); time.sleep(.3)
            pg.click('[data-a=keep]'); time.sleep(1.2)
            ok('%d: «Manter» tira-o dos que vão expirar' % w, call('GET', '/api/state', tok=tok)['contents'] and not [x for x in call('GET', '/api/state', tok=tok)['contents'] if x['name'] == 'Quase_a_caducar.png' and x.get('exp') and x['exp'] < time.strftime('%Y-%m-%d', time.gmtime(time.time() + 170 * 86400))])
            pg.click('[data-a=cview][data-v=lib]'); time.sleep(.3)
            pg.fill('#cl-used', '120'); pg.press('#cl-used', 'Tab'); time.sleep(1.2)
            ok('%d: o administrador muda o prazo' % w, call('GET', '/api/state', tok=tok)['clean']['used'] == 120)
            ok('%d: sem barra horizontal' % w, not pg.evaluate('document.documentElement.scrollWidth>innerWidth'))
            pg.click('#head [data-a=help]'); ok('%d: manual explica a limpeza' % w, 'Limpeza automática' in pg.inner_text('#modal-root')); pg.keyboard.press('Escape')
        ok('sem erros na página', not errs)
        br.close()
finally:
    srv.terminate()
print('\n%d falhas' % len(fails)); raise SystemExit(1 if fails else 0)
