"""Vista em lista dos conteúdos e ver um conteúdo: carregar no cartão abre uma janela com o vídeo (ou a imagem) para ver. Corre: python3 test/e2e/ver_conteudo.py"""
import subprocess, os, json, time, urllib.request, tempfile, threading, http.server, datetime
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8767; cport = 8768
def fmt(h): return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=h)).strftime('%Y%m%dT%H%M%SZ')
def ev(uid, t, h): return 'BEGIN:VEVENT\r\nUID:%s\r\nSUMMARY:%s\r\nDESCRIPTION:Detalhe %s\r\nDTSTART:%s\r\nEND:VEVENT\r\n' % (uid, t, uid, fmt(h))
ics = 'BEGIN:VCALENDAR\r\n' + ev('a', 'SPOTS DIGITAIS - Entrega', 30) + ev('b', 'SPOTS DIGITAIS - Reuniao', 44) + ev('c', 'SPOTS DIGITAIS - Instalacao', 110) + ev('d', 'Almoco', 20) + 'END:VCALENDAR\r\n'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.send_header('Content-Type', 'text/calendar'); self.end_headers(); self.wfile.write(ics.encode())
    def log_message(self, *a): pass
cs = http.server.ThreadingHTTPServer(('127.0.0.1', cport), H); threading.Thread(target=cs.serve_forever, daemon=True).start()
class OV(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'elements': [{'tags': {'shop': 'x'}}, {'tags': {'shop': 'y'}}, {'tags': {'amenity': 'cafe'}}, {'tags': {'highway': 'bus_stop'}}]}).encode())
    def log_message(self, *a): pass
ovs = http.server.ThreadingHTTPServer(('127.0.0.1', 8769), OV); threading.Thread(target=ovs.serve_forever, daemon=True).start()
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='Tiago', ADMIN_EMAIL='t@enif.pt', ADMIN_PASS='palavra-passe-longa', PORT=str(port), CAL_ICS_URL='http://127.0.0.1:%d/segredo.ics' % cport, CAL_ALLOW_HTTP='1', POI_URL='http://127.0.0.1:8769/api/interpreter', POI_ALLOW_HTTP='1')
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
    tok = call('POST', '/api/login', {'email': 't@enif.pt', 'pass': 'palavra-passe-longa'})['token']
    scr = {'id': 'ECR-001', 'venue': 'Praça Teste', 'city': 'Braga', 'spot': 'Centro', 'type': 'Painel quadrado', 'res': '384×384', 'limit': 14, 'order': [], 'draft': None, 'on': 0, 'off': 24, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}]}, tok)
    from PIL import Image
    import io
    buf = io.BytesIO(); Image.new('RGB', (384, 384), (30, 30, 200)).save(buf, 'PNG')
    def up(name, mime, data):
        req = urllib.request.Request(B + '/api/upload?name=%s&mime=%s&screens=ECR-001&secs=3' % (name, mime), data=data, headers={'Authorization': 'Bearer ' + tok}, method='PUT')
        return json.loads(urllib.request.urlopen(req).read())
    up('Imagem_Teste.png', 'image/png', buf.getvalue()); up('Video_Teste.mp4', 'video/mp4', open('/tmp/v.mp4', 'rb').read())
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        ctx = br.new_context(viewport={'width': 1300, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=conteudos]')
        pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(1)
        ok('o cartão do vídeo mostra a primeira imagem do vídeo', pg.locator('.tile .thumb video').count() >= 1)
        ok('há os botões Cartões e Lista', pg.locator('[data-a=cmode]').count() == 2)
        ok('por defeito é a vista de cartões', pg.locator('.gallery .tile').count() == 2 and pg.locator('table.tbl-cont').count() == 0)
        pg.click('[data-a=cmode][data-m=list]'); time.sleep(.6)
        pg.screenshot(path='/tmp/lista.png')
        ok('a lista mostra uma linha por conteúdo', pg.locator('table.tbl-cont tbody tr').count() == 2 and pg.locator('.gallery').count() == 0)
        ok('na lista também se vê o vídeo ao carregar na miniatura', (pg.locator('table.tbl-cont .thumb[data-a=content-view]').first.click() or True) and (time.sleep(.5) or True) and pg.locator('#modal-root .prev-media').count() == 1)
        pg.locator('#modal-root [data-a=close]').first.click(); time.sleep(.4)
        ok('os filtros continuam a funcionar na lista (só imagens)', (pg.click('[data-a=cfilter][data-f=Imagem]') or True) and (time.sleep(.5) or True) and pg.locator('table.tbl-cont tbody tr').count() == 1)
        pg.click('[data-a=cfilter][data-f=todos]'); time.sleep(.4)
        time.sleep(1.2); pg.reload(); pg.wait_for_selector('[data-a=nav][data-v=conteudos]'); pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(1)
        ok('a vista escolhida fica guardada depois de recarregar', pg.locator('table.tbl-cont').count() == 1)
        pg.click('[data-a=cmode][data-m=cards]'); time.sleep(.5)
        ok('voltar a Cartões', pg.locator('.gallery .tile').count() == 2)
        pg.set_viewport_size({'width': 390, 'height': 800}); pg.click('[data-a=cmode][data-m=list]'); time.sleep(.5)
        ok('no telemóvel a lista não tem barra horizontal', not pg.evaluate('document.documentElement.scrollWidth>innerWidth'))
        pg.set_viewport_size({'width': 1300, 'height': 900}); pg.click('[data-a=cmode][data-m=cards]'); time.sleep(.4)
        pg.locator('.tile:has-text("Video_Teste.mp4") .thumb').click(); time.sleep(.6)
        ok('carregar no vídeo abre a janela com o leitor', pg.locator('#modal-root video.prev-media[controls]').count() == 1 and 'Video_Teste.mp4' in pg.inner_text('#modal-root'))
        ok('o leitor aponta para o ficheiro do servidor', '/media/' in pg.get_attribute('#modal-root video.prev-media', 'src'))
        pg.locator('#modal-root [data-a=close]').first.click(); time.sleep(.4)
        ok('fechar a janela fecha o leitor', pg.locator('#modal-root video').count() == 0)
        pg.locator('.tile:has-text("Imagem_Teste.png") .thumb').click(); time.sleep(.6)
        ok('carregar numa imagem mostra-a em grande', pg.locator('#modal-root img.prev-media').count() == 1)
        ok('zero erros na consola', not errs)
        br.close()
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-300:]); cs.shutdown(); ovs.shutdown()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
