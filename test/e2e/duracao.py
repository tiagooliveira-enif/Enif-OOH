"""Duração própria por conteúdo na campanha: campos lado a lado, máximo = campanha, conflito e gravação.
Corre: NO_PROXY=127.0.0.1 python3 test/e2e/duracao.py"""
import subprocess, os, json, time, urllib.request, tempfile
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8784
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
B = 'http://127.0.0.1:%d' % port
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(1.5)
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
vid = os.path.join(data, 'v.mp4')
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30', '-t', '12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid], check=True)
try:
    h = {'Content-Type': 'application/json'}
    tok = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/login', data=json.dumps({'email': 't@x.pt', 'pass': 'segredo12'}).encode(), headers=h)).read())['token']
    h['Authorization'] = 'Bearer ' + tok
    def post(path, o): return json.loads(urllib.request.urlopen(urllib.request.Request(B + path, data=json.dumps(o).encode(), headers=h, method='POST')).read())
    base = {'venue': 'Fórum', 'city': 'Braga', 'spot': 'Totem', 'type': 'Totem vertical', 'res': '1080×1920', 'limit': 4, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'maps': ''}, 'on': 0, 'off': 24}
    post('/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': dict(base, id='ECR-001')}]})
    d = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/upload?name=abc.mp4&mime=video/mp4&screens=ECR-001', data=open(vid, 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')).read())
    t = time.strftime('%Y-%m-%d')
    post('/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': {'id': 'C1', 'name': 'Verão', 'client': 'Cli', 'venues': ['Fórum'], 'start': t, 'end': '2099-12-30', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 10, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': d['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1}]}}]})
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 900}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=campanhas]'); time.sleep(1)
        pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.6); pg.locator('[data-a=edit-camp]').first.click(); time.sleep(.8)
        row = pg.locator('.ci-row:has(input[name=ci]:checked)').first
        dur_in, ppm_in = row.locator('input[name^=cis_]'), row.locator('input[name^=cip_]')
        a, b = dur_in.bounding_box(), ppm_in.bounding_box()
        ok('«Duração (s)» fica à esquerda de «Vezes/min», na mesma linha', abs(a['y'] - b['y']) < 4 and a['x'] < b['x'])
        ok('o campo sugere a duração da campanha e o máximo é o da campanha', dur_in.get_attribute('placeholder') == '10' and dur_in.get_attribute('max') == '10')
        dur_in.click(); pg.keyboard.type('11'); time.sleep(.3)
        ok('escrever 11 numa campanha de 10 s deixa o campo em 10', dur_in.input_value() == '10')
        dur_in.fill('5'); pg.locator('#c-dur').fill('4'); pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(.5)
        ok('baixar a campanha abaixo do conteúdo dá conflito', 'Conflito' in pg.inner_text('#form-err') and '4 s' in pg.inner_text('#form-err'))
        pg.locator('#c-dur').fill('10'); pg.click('form[data-form=campaign] button[type=submit]'); time.sleep(1)
        ok('com 5 s no conteúdo e 10 s na campanha, grava', pg.locator('form[data-form=campaign]').count() == 0)
        time.sleep(1.2)
        st = json.loads(urllib.request.urlopen(urllib.request.Request(B + '/api/state', headers=h)).read())
        ok('o servidor guardou 5 s no conteúdo', st['campaigns'][0]['items'][0].get('dur') == 5)
        pg.reload(); pg.wait_for_selector('[data-a=nav][data-v=campanhas]'); time.sleep(1); pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.6); pg.locator('[data-a=edit-camp]').first.click(); time.sleep(.8)
        ok('ao reabrir, o 5 aparece no campo', pg.locator('.ci-row:has(input[name=ci]:checked)').first.locator('input[name^=cis_]').input_value() == '5')
        ok('sem erros na página', not errs)
finally:
    srv.terminate()
print('FALHAS', fails)
raise SystemExit(1 if fails else 0)
