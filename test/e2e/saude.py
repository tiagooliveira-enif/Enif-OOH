"""Saúde do ecrã (24 h), qualidade do vídeo com «Ignorar aviso» e a nova ordem da ficha do ecrã.
Corre: NO_PROXY=127.0.0.1 python3 test/e2e/saude.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8783
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
B = 'http://127.0.0.1:%d' % port
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(1.5)
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
vid = os.path.join(data, 'pesado.mp4')
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=60', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid], check=True)
try:
    h = {'Content-Type': 'application/json'}
    tok = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/login', data=json.dumps({'email': 't@x.pt', 'pass': 'segredo12'}).encode(), headers=h)).read())['token']
    h['Authorization'] = 'Bearer ' + tok
    def post(path, o, hh=None): return json.loads(urllib.request.urlopen(urllib.request.Request(B + path, data=json.dumps(o).encode(), headers=hh or h, method='POST')).read())
    base = {'venue': 'Fórum', 'city': 'Braga', 'spot': 'Totem', 'type': 'Totem vertical', 'res': '1080×1920', 'limit': 4, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'maps': ''}, 'on': 0, 'off': 24}
    post('/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': dict(base, id='ECR-001')}]})
    d = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/upload?name=pesado.mp4&mime=video/mp4&screens=ECR-001', data=open(vid, 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')).read())
    state = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/state', headers=h)).read())
    key = state['screens'][0]['playerKey']
    post('/api/player/heartbeat', {'code': 'ECR-001', 'key': key, 'ver': '17', 'w': 1080, 'h': 1920, 'boot': int(time.time() * 1000) - 600000, 'miss': 2})
    post('/api/player/plays', {'code': 'ECR-001', 'key': key, 'plays': [{'pid': 'f%d' % i, 'c': 'X', 'f': d['id'], 'ts': int(time.time() * 1000), 'dur': 0, 'ok': 0, 'why': 'erro'} for i in range(4)]})
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 900}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); time.sleep(1)
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.5); pg.click('[data-a=open-screen][data-id=ECR-001]'); time.sleep(1.2)
        labs = pg.eval_on_selector_all('#modal-root dl.facts > div > dt', 'e=>e.map(x=>x.textContent)')
        ok('ordem da ficha do ecrã', labs[:12] == ['Estado', 'Disco do PC', 'Última ligação', 'Disponibilidade (7 dias)', 'Brilho', 'Horário', 'A reproduzir', 'Resolução', 'Saúde do ecrã', 'Localização', 'Imagem', 'Ficha técnica'] or labs[:11] == ['Estado', 'Disco do PC', 'Última ligação', 'Disponibilidade (7 dias)', 'Brilho', 'Horário', 'A reproduzir', 'Resolução', 'Saúde do ecrã', 'Localização', 'Imagem'])
        ok('«Tipo» já não é um campo à parte', 'Tipo' not in labs)
        ok('a ficha diz que faltam 2 ficheiros a descarregar', 'A descarregar 2 ficheiros' in pg.inner_text('#modal-root'))
        ok('o botão da saúde mostra o aviso do vídeo a falhar', '1 aviso' in pg.inner_text('[data-a=health]'))
        pg.click('[data-a=health]'); time.sleep(.8)
        m = pg.inner_text('#modal-root')
        ok('a saúde mostra reinícios, sinais e o vídeo a falhar', 'Reinícios' in m and 'Sinais perdidos' in m and 'pesado.mp4' in m and 'falhou 4 vezes' in m and 'O player reiniciou' in m)
        ok('o vídeo a falhar traz o motivo da qualidade (60 fps) e o motivo da falha', '60 fps' in m and 'Motivo: erro' in m)
        pg.click('#modal-root [data-a=content-view]'); time.sleep(.8)
        m = pg.inner_text('#modal-root')
        ok('o cartão do vídeo mostra codec, fps e o aviso', 'H264' in m and '60 fps' in m and 'Qualidade do vídeo: atenção' in m)
        pg.click('[data-a=q-ign]'); time.sleep(.8)
        ok('depois de ignorar, o cartão diz que o aviso foi ignorado', 'Aviso de qualidade ignorado' in pg.inner_text('#modal-root') and 'Voltar a avisar' in pg.inner_text('#modal-root'))
        pg.keyboard.press('Escape'); time.sleep(.3)
        pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(.8)
        ok('na biblioteca já não há etiqueta nem faixa de aviso', 'Atenção ao vídeo' not in pg.inner_text('#view') and 'podem engasgar' not in pg.inner_text('#view'))
        time.sleep(1.5)
        r = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/state', headers=h)).read())
        ok('o «ignorar» ficou guardado no servidor e o alerta desapareceu', [c for c in r['contents'] if c['id'] == d['id']][0].get('qIgn') is True and not any(a['title'] == 'Vídeo a falhar' for a in r['alerts']))
        # aviso logo depois de carregar um vídeo pesado
        pg.keyboard.press('Escape'); pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(.6)
        pg.set_input_files('#file-input', vid); time.sleep(1.5)
        pg.check('#modal-root input[name=us0]') if pg.locator('#modal-root input[name=us0]').count() else None
        pg.locator('#modal-root input[type=checkbox]').first.check(); pg.click('form[data-form=upload] button[type=submit]'); time.sleep(3)
        m = pg.inner_text('#modal-root')
        ok('depois de carregar um vídeo pesado aparece «Atenção à qualidade»', 'Atenção à qualidade' in m and 'pesado.mp4' in m and '60 fps' in m)
        pg.click('#modal-root [data-a=q-ign]'); time.sleep(.6)
        ok('ignorar na própria janela mantém-na aberta e marca o aviso', 'Atenção à qualidade' in pg.inner_text('#modal-root') and 'Voltar a avisar' in pg.inner_text('#modal-root'))
        pg.click('#modal-root .modal-f [data-a=close]'); time.sleep(.3)
        pg.reload(); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); time.sleep(1); pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.5); pg.click('[data-a=open-screen][data-id=ECR-001]'); time.sleep(1.5)
        ok('com o aviso ignorado, a saúde deixa de contar o vídeo', 'aviso' not in pg.inner_text('[data-a=health]'))
        pg.click('[data-a=edit-res]'); time.sleep(.5)
        ok('«Resolução e tipo»: o tipo escolhe-se aqui', 'Resolução e tipo do ecrã' in pg.inner_text('#modal-root') and pg.locator('#rs-type').count() == 1)
        pg.select_option('#rs-type', label='Painel horizontal'); pg.click('form[data-form=res] button[type=submit]'); time.sleep(.8)
        pg.click('[data-a=edit-res]'); time.sleep(.4)
        ok('o tipo ficou guardado', pg.eval_on_selector('#rs-type', 'e=>e.options[e.selectedIndex].textContent') == 'Painel horizontal')
        ok('sem erros na página', not errs)
        if errs: print(errs)
finally:
    srv.terminate()
print('FALHAS', fails)
raise SystemExit(1 if fails else 0)
