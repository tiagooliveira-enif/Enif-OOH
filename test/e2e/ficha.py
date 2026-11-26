"""Ficha técnica do ecrã: o administrador carrega o PDF (e usa-o noutros ecrãs da cidade); quem só vê os ecrãs descarrega.
Corre: python3 test/e2e/ficha.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8781
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
B = 'http://127.0.0.1:%d' % port
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(1.5)
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
pdf = os.path.join(data, 'Braga_Normas.pdf'); open(pdf, 'wb').write(b'%PDF-1.4\n%teste\n' + b'x' * 3000)
try:
    h = {'Content-Type': 'application/json'}
    tok = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/login', data=json.dumps({'email': 't@x.pt', 'pass': 'segredo12'}).encode(), headers=h)).read())['token']
    h['Authorization'] = 'Bearer ' + tok
    def sync(ops): urllib.request.urlopen(urllib.request.Request(B + '/api/sync', data=json.dumps({'ops': ops}).encode(), headers=h, method='POST'))
    base = {'venue': 'Rotunda', 'city': 'Braga', 'spot': 'Painel', 'type': 'Painel horizontal', 'res': '864×264', 'limit': 4, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': '', 'pop': None}}
    sync([{'op': 'put', 'coll': 'screens', 'id': i, 'doc': dict(base, id=i, city=c)} for i, c in (('ECR-001', 'Braga'), ('ECR-002', 'Braga'), ('ECR-003', 'Porto'))])
    sync([{'op': 'put', 'coll': 'users', 'id': 'u2', 'doc': {'id': 'u2', 'name': 'Comercial', 'email': 'c@x.pt', 'admin': False, 'perms': ['ecras.ver'], 'until': None, 'active': True, 'pass': 'abcdef'}}])
    def entrar(pg, mail, pw):
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', mail); pg.fill('#lg-pass', pw)
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); time.sleep(1)
    def abrir(pg, i):
        pg.keyboard.press('Escape'); time.sleep(.3); pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.5); pg.click('[data-a=open-screen][data-id=%s]' % i); time.sleep(.6)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        ctx = br.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        entrar(pg, 't@x.pt', 'segredo12'); abrir(pg, 'ECR-001')
        m = pg.inner_text('#modal-root')
        ok('administrador: sem ficha vê «Adicionar PDF»', 'Adicionar PDF' in m and 'Descarregar' not in m)
        bad = os.path.join(data, 'x.txt'); open(bad, 'w').write('olá')
        pg.set_input_files('.ficha-in', bad); time.sleep(.4)
        ok('ficheiro que não é PDF é recusado', 'tem de ser um PDF' in pg.inner_text('.toast') and pg.locator('[data-a=ficha-save]').count() == 0)
        pg.set_input_files('.ficha-in', pdf); time.sleep(.5)
        m = pg.inner_text('#modal-root')
        ok('a janela mostra o ficheiro e a opção «Braga» com 1 outro ecrã', 'Braga_Normas.pdf' in m and 'outros ecrãs de Braga (1)' in m)
        pg.check('#ficha-all'); pg.click('[data-a=ficha-save]'); time.sleep(1.2)
        m = pg.inner_text('#modal-root')
        ok('depois de guardar vê «Descarregar ficha técnica» e «Substituir»', 'Descarregar ficha técnica' in m and 'Substituir' in m and pg.locator('[data-a=ficha-del]').count() == 1)
        with pg.expect_download() as d: pg.click('[data-a=ficha-dl]')
        dp = d.value.path(); ok('o administrador descarrega o PDF igual', d.value.suggested_filename == 'Braga_Normas.pdf' and open(dp, 'rb').read() == open(pdf, 'rb').read())
        abrir(pg, 'ECR-002'); ok('o outro ecrã de Braga também ficou com a ficha', 'Descarregar ficha técnica' in pg.inner_text('#modal-root'))
        abrir(pg, 'ECR-003'); ok('o ecrã do Porto não', 'Adicionar PDF' in pg.inner_text('#modal-root'))
        ctx2 = br.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True); pv = ctx2.new_page(); pv.on('pageerror', lambda e: errs.append(str(e)))
        entrar(pv, 'c@x.pt', 'abcdef'); abrir(pv, 'ECR-001'); m = pv.inner_text('#modal-root')
        ok('comercial: só vê «Descarregar ficha técnica»', 'Descarregar ficha técnica' in m and 'Substituir' not in m and pv.locator('[data-a=ficha-del]').count() == 0 and pv.locator('.ficha-in').count() == 0)
        with pv.expect_download() as d2: pv.click('[data-a=ficha-dl]')
        ok('o comercial descarrega o PDF', open(d2.value.path(), 'rb').read() == open(pdf, 'rb').read())
        abrir(pv, 'ECR-003'); ok('comercial: ecrã sem ficha não mostra a linha', 'Ficha técnica' not in pv.inner_text('#modal-root'))
        abrir(pg, 'ECR-001'); pg.click('[data-a=ficha-del]'); time.sleep(1)
        ok('o administrador remove a ficha', 'Adicionar PDF' in pg.inner_text('#modal-root'))
        ok('sem erros na página', not errs)
        if errs: print(errs)
finally:
    srv.terminate()
print('FALHAS', fails)
raise SystemExit(1 if fails else 0)
