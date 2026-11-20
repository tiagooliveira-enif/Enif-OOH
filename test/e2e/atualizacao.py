"""A página redesenha-se sozinha (de 15 em 15 s quando algo muda). Isso não pode mudar o que a pessoa está a ver:
- as listas de 10 linhas («Ver tudo») nunca mostram mais de 10 linhas, nem por um instante;
- uma lista aberta com «Ver tudo» fica aberta;
- o scroll da página e a pesquisa escrita ficam como estavam.
Corre: python3 test/e2e/atualizacao.py   (demora ~1 min: espera pelos redesenhos automáticos)"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8771
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='Tiago', ADMIN_EMAIL='t@enif.pt', ADMIN_PASS='palavra-passe-longa', PORT=str(port))
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
N = 14
def scr(i, nome):
    return {'id': 'ECR-%03d' % i, 'venue': nome, 'city': 'Braga', 'spot': 'Centro', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 14, 'order': [], 'draft': None, 'on': 0, 'off': 24, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}}
try:
    tok = call('POST', '/api/login', {'email': 't@enif.pt', 'pass': 'palavra-passe-longa'})['token']
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-%03d' % i, 'doc': scr(i, 'Local %d' % i)} for i in range(1, N + 1)]}, tok=tok)
    def mexer(k):   # muda um ecrã: o painel vê a alteração no próximo ciclo e redesenha-se
        call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr(1, 'Local 1 v%d' % k)}]}, tok=tok)
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1300, 'height': 900}).new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); time.sleep(1.5)
        pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa'); pg.click('form[data-form=login] button[type=submit]')
        pg.wait_for_selector('[data-a=nav][data-v=ecras]'); time.sleep(.8)
        pg.click('[data-a=play-view][data-m=screen]'); time.sleep(.8)
        SEL = '.stile'
        # amostrador: por cada imagem desenhada, quantas linhas estão visíveis; e quantas vezes a página foi redesenhada
        # amostrador: por cada imagem desenhada, quantas linhas estão visíveis
        pg.evaluate("""() => {
            window.__vis = []; window.__run = true;
            const f = () => { window.__vis.push(document.querySelectorAll('.stile:not(.lim-h)').length); if (window.__run) requestAnimationFrame(f); };
            requestAnimationFrame(f);
        }""")
        ok('há mais de 10 ecrãs e a lista mostra só 10', pg.locator(SEL).count() == N and pg.locator(SEL + ':not(.lim-h)').count() == 10)
        def esperar_redesenho(k):   # a página redesenhou-se quando o cartão que marcámos deixa de existir
            pg.evaluate("window.__n0 = document.querySelector('.stile, #q')"); mexer(k)
            for _ in range(60):
                time.sleep(.5)
                if pg.evaluate('!document.contains(window.__n0)'): return True
            return False
        ok('a página redesenha-se sozinha quando algo muda', esperar_redesenho(1))
        time.sleep(.5)
        vis = pg.evaluate('window.__vis')
        ok('lista fechada: nenhuma imagem mostrou mais de 10 linhas (vistas %d imagens)' % len(vis), len(vis) > 20 and max(vis) <= 10)
        pg.evaluate('window.__vis = []')
        pg.click('[data-a=lim-toggle]'); time.sleep(.4)
        ok('«Ver tudo» abre a lista toda', pg.locator(SEL + ':not(.lim-h)').count() == N)
        ok('a lista aberta fica aberta depois de redesenhar', esperar_redesenho(2))
        time.sleep(.5)
        vis = pg.evaluate('window.__vis')
        ok('lista aberta: nenhuma imagem a mostrou fechada', len(vis) > 20 and min(vis[2:]) == N)
        # scroll e pesquisa ficam
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.8)
        pg.fill('#q', 'Local 1'); time.sleep(.5)
        pg.evaluate('window.scrollTo(0, 120)'); time.sleep(.3)
        y0 = pg.evaluate('window.scrollY')
        pg.evaluate('document.activeElement && document.activeElement.blur()')
        esperar_redesenho(3); time.sleep(.5)
        ok('a pesquisa escrita fica depois de redesenhar', pg.input_value('#q') == 'Local 1')
        ok('o scroll fica onde estava (%d → %d)' % (y0, pg.evaluate('window.scrollY')), abs(pg.evaluate('window.scrollY') - y0) <= 2)
        pg.evaluate('window.__run = false')
        ok('zero erros na consola', not errs)
        br.close()
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-300:])
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
