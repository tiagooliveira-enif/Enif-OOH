"""Teste de ponta a ponta das novidades da v93: cartão do Calendário (servidor a ler um .ics falso) e movimento à volta (Overpass falso), prioridade só Alta/Normal
e posição partilhada guardada no servidor. Corre: python3 test/e2e/novidades.py"""
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
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        for w in (1300, 390):
            ctx = br.new_context(viewport={'width': w, 'height': 900}); pg = ctx.new_page()
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa')
            pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('.cal-card'); time.sleep(1)
            n = pg.locator('[data-a=cal-read]').count()
            ok('(%d) calendário mostra os 2 eventos das próximas 48 h' % w, n == 2)
            ok('(%d) sem scroll horizontal' % w, not pg.evaluate('document.documentElement.scrollWidth>innerWidth'))
            pg.locator('[data-a=cal-open]').first.click(); time.sleep(.3)
            ok('(%d) o + mostra os detalhes' % w, 'Detalhe a' in pg.inner_text('.cal-card'))
            ok('(%d) o endereço secreto nunca aparece' % w, 'segredo' not in pg.content())
            pg.locator('[data-a=cal-read]').first.click(); time.sleep(.8)
            ok('(%d) «Lida» tira o aviso do painel' % w, pg.locator('[data-a=cal-read]').count() == 1)
            pg.reload(); pg.wait_for_selector('.cal-card'); time.sleep(1)
            ok('(%d) continua lida depois de recarregar' % w, pg.locator('[data-a=cal-read]').count() == 1)
            call('POST', '/api/calendar/keyword', {'kw': 'SPOTS DIGITAIS'}, tok)
            # reposição da marca para o 2.º tamanho
            if w == 1300:
                import sqlite3
                c = sqlite3.connect(os.path.join(data, 'enif-data.db')) if os.path.exists(os.path.join(data, 'enif-data.db')) else None
                if c: c.execute('DELETE FROM cal_read'); c.commit(); c.close()
            ctx.close()
        ctx = br.new_context(viewport={'width': 1300, 'height': 900}); pg = ctx.new_page()
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=campanhas]')
        pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.5); pg.click('[data-a=new-camp]'); time.sleep(.4)
        ok('prioridade só tem Alta e Normal', pg.eval_on_selector_all('#c-pri option', 'o=>o.map(x=>x.value)') == ['Alta', 'Normal'])
        ok('há explicação da prioridade Alta', 'garante' in pg.inner_text('#modal-root'))
        call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': {'id': 'ECR-001', 'venue': 'Praça Teste', 'city': 'Lisboa', 'spot': 'Centro', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 5, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'rua', 'pop': None}, 'on': 0, 'off': 24}}]}, tok)
        pg.reload(); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.6)
        pg.click('[data-a=open-screen]:has-text("ECR-001")'); time.sleep(.5)
        pg.locator('[data-a=edit-place]').first.click(); time.sleep(.5)
        pg.fill('#pf-maps', '38.7369, -9.1521'); pg.click('[data-a=poi-calc]'); time.sleep(1)
        ok('movimento à volta calculado pelo servidor', '2 lojas' in pg.inner_text('#poi-res') and 'estimativa' in pg.inner_text('#poi-res'))
        pg.click('form[data-form=place] button[type=submit]'); time.sleep(1.2)
        st_ = call('GET', '/api/state', tok=tok); sc_ = [x for x in st_['screens'] if x['id'] == 'ECR-001'][0]
        ok('movimento guardado no ecrã', (sc_['loc'].get('poi') or {}).get('shops') == 2)
        ok('zero erros na consola', not errs)
    sh = {'id': 'S1', 'name': 'Camp S1', 'client': 'c', 'venues': [], 'start': datetime.date.today().isoformat(), 'end': (datetime.date.today() + datetime.timedelta(days=5)).isoformat(), 'h0': 8, 'h1': 20, 'ppm': 1, 'dur': 10, 'priority': 'Alta', 'share': 'GX', 'manual': False, 'color': 1, 'items': [], 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'S1', 'doc': sh}]}, tok)
    c1 = [c for c in call('GET', '/api/state', tok=tok)['campaigns'] if c['id'] == 'S1'][0]
    ok('Alta e posição partilhada ficam guardadas no servidor', c1['priority'] == 'Alta' and c1['share'] == 'GX')
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-300:]); cs.shutdown(); ovs.shutdown()
print('\nFALHAS', fails)
raise SystemExit(1 if fails else 0)
