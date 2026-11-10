"""Eliminar conteúdo: vai para a Reciclagem; se estiver numa campanha ativa avisa quais e não deixa eliminar.
Corre: python3 test/e2e/elim_conteudo.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
SP = '/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8779
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
    hoje = time.strftime('%Y-%m-%d')
    IMG = os.path.join(ROOT, 'test', 'e2e', 'img') + '/'
    def upload(name, path):
        req = urllib.request.Request(B + '/api/upload?name=%s&mime=image/png&screens=ECR-001&secs=3' % name, data=open(path, 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')
        return json.loads(urllib.request.urlopen(req).read())
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': {'id': 'ECR-001', 'venue': 'X', 'city': 'Braga', 'spot': 'A', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 1, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': '', 'pop': None}}}]}, tok)
    f1 = upload('livre.png', IMG + 'i1.png')['id']; f2 = upload('usado.png', IMG + 'p1.png')['id']
    camp = {'id': 'C1', 'name': 'Campanha Viva', 'client': 'c', 'venues': ['X'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 5, 'priority': 'Normal', 'items': [{'f': f2, 'w': 1}]}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    try: call('POST', '/api/contents/delete', {'id': f2}, tok); r = 'ok'
    except urllib.error.HTTPError as e: r = e.read().decode()
    ok('o servidor recusa e diz a campanha', 'Campanha Viva' in r)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 900}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=conteudos]')
        pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(1)
        pg.click('[data-a=del-content][data-id="%s"]' % f2); time.sleep(.4)
        t = pg.inner_text('#modal-root')
        ok('aviso mostra a campanha e não há botão eliminar', 'Campanha Viva' in t and pg.locator('[data-a=del-content-ok]').count() == 0)
        pg.click('#modal-root [data-a=close]'); time.sleep(.3)
        pg.click('[data-a=del-content][data-id="%s"]' % f1); time.sleep(.4)
        ok('pede confirmação', pg.locator('[data-a=del-content-ok]').count() == 1)
        pg.click('[data-a=del-content-ok]'); time.sleep(1.5)
        st = call('GET', '/api/state', tok=tok)
        ok('saiu da biblioteca', not [c for c in st['contents'] if c['id'] == f1])
        ok('está na reciclagem', [c for c in st['bin'] if c['id'] == f1])
        call('POST', '/api/contents/restore', {'id': f1}, tok)
        st = call('GET', '/api/state', tok=tok)
        ok('restaura', [c for c in st['contents'] if c['id'] == f1])
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
