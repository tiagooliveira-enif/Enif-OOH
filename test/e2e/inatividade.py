"""Teste de ponta a ponta: a sessão termina por inatividade (aqui 30 s em vez de 15 min) e prolonga-se com ações.
Corre: python3 test/e2e/inatividade.py"""
import subprocess, os, time, tempfile, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8774
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json', IDLE_MIN='0.5')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(1.5)
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 800}); pg.goto('http://127.0.0.1:%d/app/' % port)
        pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12'); pg.click('#login button[type=submit]'); pg.wait_for_selector('[data-a="nav"]')
        ok('entra e vê a aplicação', pg.locator('[data-a="nav"]').count() > 0)
        for i in range(6):                      # 6 x 8 s = 48 s, mais do que os 30 s, mas sempre com ações
            time.sleep(8); pg.mouse.click(700, 500); pg.keyboard.press('Shift')
        ok('com ações a sessão continua depois de mais de 30 s', pg.locator('[data-a="nav"]').count() > 0)
        time.sleep(26)
        ok('aviso 1 minuto antes de terminar', 'termina dentro de 1 minuto' in (pg.inner_text('#toast') or ''))
        time.sleep(14)
        pg.wait_for_selector('#login:not([hidden])', timeout=15000)
        ok('sem ações a sessão termina', pg.locator('#login').is_visible())
        ok('o ecrã de entrada explica porquê', 'inatividade' in pg.inner_text('#form-err'))
        ok('já não há dados da sessão guardados', pg.evaluate("localStorage.getItem('enif.token')") is None)
        pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12'); pg.click('#login button[type=submit]'); pg.wait_for_selector('[data-a="nav"]', timeout=8000)
        ok('volta a entrar normalmente', not pg.locator('#login').is_visible())
        b.close()
finally:
    srv.terminate()
print('FALHAS', fails); sys.exit(1 if fails else 0)
