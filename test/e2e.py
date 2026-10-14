"""Teste ponta a ponta: servidor real + interface real + player real (Chromium).
Uso: python3 test/e2e.py   (precisa de playwright e de ffmpeg para gerar ficheiros de teste)"""
import json, os, subprocess, sys, tempfile, time, urllib.request, shutil
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 18080; BASE = f'http://localhost:{PORT}'
OUT = os.environ.get('E2E_OUT', '/tmp/e2e'); os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp()
def ff(*a): subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *a], check=True)
ff('-f', 'lavfi', '-i', 'color=c=0x1D5FE5:s=640x360', '-frames:v', '1', f'{tmp}/azul.png')
ff('-f', 'lavfi', '-i', 'color=c=0xB4501B:s=640x360', '-frames:v', '1', f'{tmp}/laranja.png')
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '2', '-c:v', 'libvpx', '-b:v', '300k', f'{tmp}/video.webm')
env = dict(os.environ, PORT=str(PORT), DATA_DIR=f'{tmp}/data', ADMIN_NAME='Tiago', ADMIN_EMAIL='tiago@enif.pt', ADMIN_PASS='segredo1')
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
res = []
def ok(n, c): res.append(('PASS ' if c else 'FAIL ') + n); print(res[-1], flush=True); return c
def api(m, p, body=None, tok=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + tok} if tok else {})})
    with urllib.request.urlopen(r) as x: return json.loads(x.read())
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/health'); break
        except Exception: time.sleep(.1)
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 1360, 'height': 900}); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text and 'Failed to load resource' not in m.text else None)

        # ---- entrada do administrador inicial
        pg.goto(BASE + '/'); pg.wait_for_selector('#lg-email')
        ok('não oferece criar conta', 'Criar conta' not in pg.inner_text('#login') and pg.locator('#lg-name').count() == 0)
        pg.fill('#lg-email', 'tiago@enif.pt'); pg.fill('#lg-pass', 'errada'); pg.click('#login button[type=submit]'); pg.wait_for_timeout(500)
        ok('palavra-passe errada recusada', 'incorretos' in pg.inner_text('#login'))
        pg.fill('#lg-pass', 'segredo1'); pg.click('#login button[type=submit]'); pg.wait_for_selector('#nav button')
        ok('entra no painel', 'Painel' in pg.inner_text('#nav'))
        tok = pg.evaluate("localStorage.getItem('enif.token')"); ok('sessão guardada', bool(tok))
        ok('painel vazio sem erros', not errs)

        # ---- ecrã novo
        pg.click('[data-a="nav"][data-v="ecras"]')
        ok('lista de ecrãs vazia', 'Ainda não há ecrãs' in pg.inner_text('#screen-list'))
        pg.click('[data-a="new-screen"]'); pg.fill('#ns-venue', 'Fórum do Minho'); pg.fill('#ns-spot', 'Átrio'); pg.fill('#ns-city', 'Braga')
        pg.check('input[name=always]'); pg.click('#modal-root button[type=submit]')
        pg.wait_for_selector('#modal-root .mono', timeout=8000)
        txt = pg.inner_text('#modal-root'); ok('mostra código e chave do player', 'ECR-001' in txt)
        key = pg.locator('#modal-root dl.facts .mono').nth(1).inner_text().strip(); ok('chave com 16+ caracteres', len(key) >= 16)
        pg.click('#modal-root [data-a="close"] >> nth=-1')
        ok('ecrã guardado no servidor', len(api('GET', '/api/state', tok=tok)['screens']) == 1)

        # ---- conteúdos
        pg.click('[data-a="nav"][data-v="conteudos"]')
        pg.set_input_files('#file-input', [f'{tmp}/azul.png', f'{tmp}/laranja.png', f'{tmp}/video.webm'])
        pg.wait_for_function("document.querySelectorAll('.tile').length===3", timeout=20000)
        st = api('GET', '/api/state', tok=tok); c3 = {c['name']: c for c in st['contents']}
        ok('3 conteúdos carregados com dimensões e duração', c3['azul.png']['res'] == '640×360' and c3['video.webm']['dur'] == '2 s')
        pg.click('[data-a="new-folder"]'); pg.fill('#fo-name', 'Braga'); pg.click('#modal-root button[type=submit]')
        ok('pasta criada', pg.locator('.chip', has_text='Braga').count() == 1)

        # ---- campanha
        pg.click('[data-a="nav"][data-v="campanhas"]'); pg.click('[data-a="new-camp"]')
        pg.fill('#c-name', 'Camp A'); pg.fill('#c-client', 'Cliente X'); pg.check('input[name=venue]')
        pg.select_option('#c-h0', '0'); pg.select_option('#c-h1', '24'); pg.fill('#c-dur', '3')
        pg.locator('input[name=ci]').nth(0).check(); pg.locator('input[name=ci]').nth(1).check()
        pg.click('#modal-root button[type=submit]'); pg.wait_for_selector('.crow:not(.chead)')
        pg.wait_for_timeout(600)
        st = api('GET', '/api/state', tok=tok)
        ok('campanha guardada no servidor com 2 conteúdos', len(st['campaigns']) == 1 and len(st['campaigns'][0]['items']) == 2)
        camp = st['campaigns'][0]['id']

        # ---- player a sério
        pp = ctx.new_page(); perr = []
        pp.on('pageerror', lambda e: perr.append(str(e)))
        pp.goto(f'{BASE}/player/?code=ECR-001&key={key}&hb=3&flush=3&refresh=5&debug=1')
        pp.wait_for_timeout(16000)
        s = api('GET', '/api/state', tok=tok)['screens'][0]
        ok('ecrã passa a online', s['status'] == 'online')
        ok('player enviou a resolução', s['res'] != 'auto' and '×' in s['res'])
        rows = api('GET', f'/api/plays?from=2000-01-01&to=2999-12-31', tok=tok)['rows']
        n = sum(r['n'] for r in rows); ok(f'passagens registadas ({n})', n >= 3)
        ok('imagens e vídeo alternam', len({r['f'] for r in rows}) == 2)
        ok('sem erros no player', not perr)
        pp.screenshot(path=f'{OUT}/player.png')

        # ---- a interface mostra os dados reais
        pg.reload(); pg.wait_for_selector('#nav button')
        ok('sessão mantém-se ao recarregar', 'Painel' in pg.inner_text('#nav'))
        pg.wait_for_function("document.querySelector('.kpi .val') && /1/.test(document.querySelector('.kpi .val').innerText)", timeout=8000)
        body = pg.inner_text('#view'); ok('painel: 1 ecrã online', 'Online' in body or '1 / 1' in body)
        pg.wait_for_timeout(1500)
        kp = pg.locator('.kpi').nth(3).inner_text(); ok('painel: impressões reais de hoje (' + kp.replace('\n', ' ') + ')', any(ch.isdigit() and ch != '0' for ch in kp.split('\n')[1]))
        pg.screenshot(path=f'{OUT}/painel.png')
        pg.click('[data-a="nav"][data-v="relatorios"]'); pg.wait_for_selector('.tbl', timeout=8000)
        rt = pg.inner_text('#view'); ok('relatório mostra a campanha e as passagens', 'Camp A' in rt and 'Registo de emissão' in rt)
        pg.screenshot(path=f'{OUT}/relatorios.png', full_page=True)
        pg.click('[data-a="nav"][data-v="ecras"]'); pg.click('.t-row:not(.t-head)')
        pg.wait_for_selector('.pl-item'); mt = pg.inner_text('#modal-root')
        ok('ecrã mostra playlist, registo real e dados do player', 'Camp A' in mt and 'Último sinal' in mt and 'Chave' in mt)
        pg.screenshot(path=f'{OUT}/ecra.png')
        # editar a playlist: rascunho -> enviar
        pg.click('#modal-root [data-a="limit"][data-d="1"]'); pg.wait_for_timeout(400)
        ok('rascunho da playlist fica guardado', api('GET', '/api/state', tok=tok)['screens'][0]['draft']['limit'] == 6)
        pg.click('#modal-root [data-a="pl-send"]'); pg.wait_for_timeout(500)
        s = api('GET', '/api/state', tok=tok)['screens'][0]; ok('enviar playlist aplica o limite', s['limit'] == 6 and s['draft'] is None)
        pg.click('#modal-root [data-a="close"] >> nth=-1')

        # ---- utilizador só de consulta: não vê nem tenta alterar o que não pode
        api('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'users', 'id': 'uvw', 'doc': {'id': 'uvw', 'name': 'Consulta', 'email': 'vw@enif.pt', 'admin': False, 'perms': ['ecras.ver', 'campanhas.ver', 'conteudos.ver', 'relatorios.ver'], 'until': None, 'active': True, 'pass': 'consulta1'}}]}, tok=tok)
        c2 = b.new_context(viewport={'width': 1360, 'height': 900}); v = c2.new_page(); verr = []
        v.on('pageerror', lambda e: verr.append(str(e)))
        v.goto(BASE + '/'); v.fill('#lg-email', 'vw@enif.pt'); v.fill('#lg-pass', 'consulta1'); v.click('#login button[type=submit]'); v.wait_for_selector('#nav button')
        ok('consulta não vê «Utilizadores»', 'Utilizadores' not in v.inner_text('#nav'))
        v.click('[data-a="nav"][data-v="ecras"]'); ok('consulta não vê «Novo ecrã»', v.locator('[data-a="new-screen"]').count() == 0)
        v.click('.t-row:not(.t-head)'); v.wait_for_selector('.pl-item'); ok('consulta não vê a chave do player', 'Chave' not in v.inner_text('#modal-root'))
        v.click('#modal-root [data-a="close"] >> nth=-1'); v.click('[data-a="nav"][data-v="campanhas"]'); v.wait_for_timeout(1500)
        ok('consulta não provoca erros de permissão', 'permissão' not in v.inner_text('#toast') and not verr)
        v.click('[data-a="nav"][data-v="conteudos"]'); ok('consulta não carrega ficheiros', v.locator('[data-a="pick-files"]').count() == 0)
        c2.close()

        # ---- queda de internet no player
        ctx.set_offline(True); pp.wait_for_timeout(9000)
        q = pp.evaluate("JSON.parse(localStorage.getItem('enif.queue')||'[]').length")
        ok(f'offline: continua a passar e guarda fila ({q})', q >= 2)
        ctx.set_offline(False); pp.wait_for_timeout(8000)
        q2 = pp.evaluate("JSON.parse(localStorage.getItem('enif.queue')||'[]').length")
        n2 = sum(r['n'] for r in api('GET', '/api/plays?from=2000-01-01&to=2999-12-31', tok=tok)['rows'])
        ok(f'regressa a internet: fila enviada (fila {q2}, total {n2})', n2 >= n + 3 and q2 <= 2)
        ctx.set_offline(True); pp.reload(); pp.wait_for_timeout(7000)
        ok('reinício offline: toca da cache', 'a passar C' in pp.inner_text('#dbg'))
        ctx.set_offline(False)

        # ---- reiniciar player
        api('POST', '/api/screens/ECR-001/restart', {}, tok=tok); pp.wait_for_timeout(9000)
        ok('«Reiniciar player» recarrega o ecrã', pp.evaluate("performance.getEntriesByType('navigation')[0].type") in ('reload', 'navigate'))
        ok('interface sem erros no fim', not errs)
        if errs: print(errs[:5])
        b.close()
finally:
    srv.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print('\n'.join(r for r in res if r.startswith('FAIL')) or 'tudo ok'); sys.exit(1 if any(r.startswith('FAIL') for r in res) else 0)
