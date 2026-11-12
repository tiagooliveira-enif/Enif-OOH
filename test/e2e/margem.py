"""Margem oculta: o player desenha só na parte visível (área do PC menos a margem); a app guarda a margem e mostra a resolução útil; o servidor recusa margens absurdas.
Corre: python3 test/e2e/margem.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data = tempfile.mkdtemp(); port = 8782
from PIL import Image
SQ = data + '/sq.png'; Image.new('RGB', (385, 385), (200, 30, 30)).save(SQ)
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
    try: return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, headers=h, method=m)).read() or b'null')
    except urllib.error.HTTPError as e: print(e.read()); raise
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel quadrado', 'res': '385×385', 'limit': 14, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}, 'on': 0, 'off': 24}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    req = urllib.request.Request(B + '/api/upload?name=a.png&mime=image/png&screens=ECR-001&secs=5', data=open(SQ, 'rb').read(), headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/octet-stream'}, method='PUT')
    f = json.loads(urllib.request.urlopen(req).read())
    camp = {'id': 'C1', 'name': 'C1', 'client': 'c', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 5, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': f['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1}], 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    st = call('GET', '/api/state', tok=tok); key = st['screens'][0]['playerKey']
    ok('por defeito o ecrã fica em «inteiro»', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['area'] == 'inteiro')
    ok('sem margem a playlist traz crop vazio', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['crop'] is None)
    def put(**k):
        d = dict(scr); d.update(k); call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': d}]}, tok)
    try:
        put(crop={'t': 150, 'b': 0, 'l': 0, 'r': 0}); ok('margem que deixa menos de 240 px é recusada', False)
    except urllib.error.HTTPError as e: ok('margem que deixa menos de 240 px é recusada', e.code == 400)
    try:
        put(crop={'t': -3, 'b': 0, 'l': 0, 'r': 0}); ok('margem negativa é recusada', False)
    except urllib.error.HTTPError as e: ok('margem negativa é recusada', e.code == 400)
    put(area='tl', crop={'t': 5, 'b': 0, 'l': 0, 'r': 0})
    ok('o servidor guarda a margem e envia-a ao player', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['crop'] == {'t': 5, 'b': 0, 'l': 0, 'r': 0})
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 720}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        box = lambda: pg.evaluate("(()=>{const r=document.querySelector('#stage').getBoundingClientRect();return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})()")
        pg.goto('%s/player/?code=ECR-001&key=%s&hb=2&flush=2&refresh=2' % (B, key)); time.sleep(5)
        ok('canto + margem de 5 px em cima: palco 385×380 a 5 px do topo', box() == [0, 5, 385, 380])
        ok('o conteúdo quase quadrado (diferença de 5 px) passa e enche a parte visível', pg.evaluate("document.querySelectorAll('#stage img').length") >= 1)
        put(area='br', crop={'t': 5, 'b': 0, 'l': 10, 'r': 0}); time.sleep(5)
        ok('canto inferior direito + margens: palco 375×380 em [905,340]', box() == [905, 340, 375, 380])
        put(area='inteiro', res='1280×720', crop={'t': 30, 'b': 0, 'l': 0, 'r': 0}); time.sleep(5)
        ok('ecrã inteiro + 30 px em cima: palco 1280×690 a 30 px do topo', box() == [0, 30, 1280, 690])
        put(area='inteiro', res='385×385', crop=None); time.sleep(5)
        ok('tirar a margem devolve a janela toda', box() == [0, 0, 1280, 720])
        def objpos(want=None):
            for _ in range(40):
                v = pg.evaluate("(()=>{const e=document.querySelector('#stage img, #stage video');return e?getComputedStyle(e).objectPosition:''})()")
                if v and (want is None or v == want): return v
                time.sleep(.5)
            return ''
        put(area='inteiro', res='385×385', crop=None, align='inicio'); time.sleep(5)
        ok('alinhamento «esquerda/cima»: o vídeo fica encostado', objpos('0% 0%') == '0% 0%')
        put(align='centro'); time.sleep(5)
        ok('alinhamento ao centro (por defeito)', objpos('50% 50%') == '50% 50%')
        try:
            put(align='xx'); ok('alinhamento inválido ignorado', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['align'] == 'centro')
        except urllib.error.HTTPError: ok('alinhamento inválido ignorado', True)
        put(area='inteiro', res='385×385', crop=None)
        ok('sem erros JS no player', not errs)
        put(area='tl', crop={'t': 30, 'b': 0, 'l': 0, 'r': 0}); time.sleep(3)
        pl = call('GET', '/api/player/playlist?code=ECR-001&key=' + key)
        ok('a margem não conta para a compatibilidade: a imagem quadrada continua a passar', pl['screen']['crop']['t'] == 30 and len(pl['days']) > 0)
        put(area='tl', crop=None)
        # interface
        ap = br.new_context(viewport={'width': 1300, 'height': 900}).new_page(); ap.on('pageerror', lambda e: errs.append(str(e)))
        ap.goto(B + '/app/'); ap.wait_for_selector('#lg-email'); ap.fill('#lg-email', 't@x.pt'); ap.fill('#lg-pass', 'segredo12')
        ap.click('form[data-form=login] button[type=submit]'); ap.wait_for_selector('[data-a=nav][data-v=ecras]')
        ap.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); ap.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('a ficha tem «Margem oculta» em «Nenhuma»', 'Margem oculta' in ap.inner_text('#modal-root') and 'Nenhuma' in ap.inner_text('#modal-root'))
        ap.click('[data-a=edit-crop]'); time.sleep(.4)
        ap.fill('#cr-t', '5'); ap.fill('#cr-l', '3'); ap.press('#cr-l', 'Tab'); time.sleep(.3)
        ok('a janela mostra a resolução útil a mudar (382×380)', '382×380' in ap.inner_text('#crop-useful'))
        ap.fill('#cr-t', '200'); ap.click('form[data-form=crop] button[type=submit]'); time.sleep(.5)
        ok('margem grande demais dá erro na janela', 'grande demais' in ap.inner_text('#form-err'))
        ap.fill('#cr-t', '5'); ap.click('form[data-form=crop] button[type=submit]'); time.sleep(2.5)
        ok('a ficha mostra «cima 5 px» e a resolução útil', 'cima 5 px' in ap.inner_text('#modal-root') and '382×380' in ap.inner_text('#modal-root'))
        ok('a margem chega ao servidor', call('GET', '/api/player/playlist?code=ECR-001&key=' + key)['screen']['crop'] == {'t': 5, 'b': 0, 'l': 3, 'r': 0})
        ap.reload(); ap.wait_for_selector('[data-a=nav][data-v=ecras]'); ap.click('[data-a=nav][data-v=ecras]'); time.sleep(.6); ap.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.8)
        ok('depois de recarregar continua «cima 5 px»', 'cima 5 px' in ap.inner_text('#modal-root'))
        ok('zero erros JS', not errs)
        br.close()
finally:
    srv.terminate()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
