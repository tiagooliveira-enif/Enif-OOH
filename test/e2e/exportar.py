"""Teste de ponta a ponta da janela «Exportar relatório em PDF»: escolher campanhas, conteúdos, ecrãs e período
e confirmar que os números do PDF só contam o que foi escolhido (PDF simulado, sem depender da internet).
Corre: python3 test/e2e/exportar.py"""
import subprocess, os, json, time, urllib.request, tempfile, sqlite3, datetime
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); IMG = HERE + '/img/'
data = tempfile.mkdtemp(); port = 8775
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data + '/none.json')
B = 'http://127.0.0.1:%d' % port
def start():
    p = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(1.5); return p
srv = start(); fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
def call(m, p, body=None, tok=None):
    h = {'Content-Type': 'application/json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=json.dumps(body).encode() if body is not None else None, headers=h, method=m)).read() or b'null')
FAKE = """window.__pdf=[];window.jspdf={jsPDF:function(){const rec={texts:[],tables:[]};window.__pdf.push(rec);
const base={internal:{pageSize:{getWidth:()=>842,getHeight:()=>595}},splitTextToSize:t=>[String(t)],getTextWidth:()=>50,text:t=>{rec.texts.push(String(t));},
autoTable:function(o){rec.tables.push({head:o.head,body:o.body});this.lastAutoTable={finalY:(o.startY||0)+60};},lastAutoTable:{finalY:100},output:()=>new ArrayBuffer(8)};
return new Proxy(base,{get:(t,k)=>k in t?t[k]:(()=>({}))});}};"""
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    def upload(name, path, scr='ECR-001'):
        req = urllib.request.Request(B + '/api/upload?name=%s&mime=image/png&screens=%s&secs=3' % (name, scr), data=open(path, 'rb').read(), headers={'Authorization': 'Bearer ' + tok}, method='PUT')
        return json.loads(urllib.request.urlopen(req).read())
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel horizontal', 'res': '1920×1080', 'limit': 1, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': 'centro-comercial', 'pop': None}, 'on': 0, 'off': 24}
    scr2 = dict(scr, id='ECR-002', spot='Entrada')
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}, {'op': 'put', 'coll': 'screens', 'id': 'ECR-002', 'doc': scr2}]}, tok)
    fa = upload('A_video.png', IMG + 'i1.png'); fb = upload('B_cartaz.png', IMG + 'p1.png'); fc = upload('C_spot.png', IMG + 'p2.png'); fd = upload('D_extra.png', IMG + 'i1.png')
    def camp(i, name, files):
        return {'id': i, 'name': name, 'client': 'Cli', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 0, 'h1': 24, 'ppm': 1, 'dur': 3, 'priority': 'Normal', 'manual': False, 'color': 1, 'items': [{'f': f['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1} for f in files], 'sector': '', 'sales': '', 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp('C1', 'Camp Um', [fa, fb])}, {'op': 'put', 'coll': 'campaigns', 'id': 'C2', 'doc': camp('C2', 'Camp Dois', [fc, fd])}]}, tok)
    srv.terminate(); srv.wait()
    day = datetime.datetime.now(ZoneInfo('Europe/Lisbon')).strftime('%Y-%m-%d'); db = sqlite3.connect(data + '/enif-data.db'); n = 0
    def plays(c, f, hours, per):
        global n
        for h in hours:
            for _ in range(per):
                n += 1; db.execute('INSERT INTO plays(pid,screen,camp,file,ts,day,hour,dur,ok) VALUES(?,?,?,?,?,?,?,?,1)', ('p%d' % n, 'ECR-001', c, f['id'], 1700000000000 + n, day, h, 3))
    plays('C1', fa, (9, 10, 11), 3); plays('C1', fb, (9, 10, 11), 5); plays('C2', fc, (10, 11, 12), 2)
    db.commit(); db.close(); srv = start()
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        pg = br.new_context(viewport={'width': 1280, 'height': 1000}).new_page(); pg.on('pageerror', lambda e: errs.append(str(e))); pg.add_init_script(FAKE)
        pg.goto(B + '/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email', 't@x.pt'); pg.fill('#lg-pass', 'segredo12')
        pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=relatorios]'); pg.click('[data-a=nav][data-v=relatorios]'); time.sleep(1.2)
        def run(label, pick, expect_plays, extra=None):
            pg.click('[data-a=export]'); time.sleep(.4); pg.click('[data-a=exp-none]'); pick(); pg.evaluate('window.__pdf.length=0')
            pg.click('form[data-form=export] button[type=submit]'); time.sleep(2.2)
            r = pg.evaluate('window.__pdf[0]')
            if not r:
                ok(label + ': gerou PDF', False); return None
            kp = [t for t in r['tables'] if t['head'] and t['head'][0][0].startswith('Visualiza')]
            got = int(kp[0]['body'][0][1].replace(' ', '').replace('\xa0', '').replace(' ', '')) if kp else 0
            ok('%s: passagens %d (esperado %d)' % (label, got, expect_plays), got == expect_plays)
            if extra: extra(r)
            return r
        tick = lambda sel: pg.locator(sel).evaluate('e=>e.click()')
        run('tudo', lambda: pg.click('[data-a=exp-all]'), 9 + 15 + 6)
        run('só Camp Um', lambda: tick('input[name=ec][value=C1]'), 24, lambda r: ok('cabeçalho com a campanha', 'Campanha: Camp Um' in r['texts']))
        run('só conteúdo A', lambda: tick('input[name=ef][value="C1|%s"]' % fa['id']), 9, lambda r: ok('cabeçalho com o vídeo A', any(t.startswith('Vídeo: A_video') for t in r['texts'])))
        run('só conteúdo B', lambda: tick('input[name=ef][value="C1|%s"]' % fb['id']), 15)
        run('A e C (de campanhas diferentes)', lambda: (tick('input[name=ef][value="C1|%s"]' % fa['id']), tick('input[name=ef][value="C2|%s"]' % fc['id'])), 9 + 6,
            lambda r: ok('tabela por campanha tem as duas', any(t['head'][0][0] == 'Campanha' and len(t['body']) == 2 for t in r['tables'])))
        run('Camp Um + Camp Dois', lambda: (tick('input[name=ec][value=C1]'), tick('input[name=ec][value=C2]')), 30)
        run('só o ecrã sem passagens', lambda: (pg.click('[data-a=exp-all]'), pg.evaluate("document.querySelectorAll('#modal-root input[name=scr]').forEach(i=>{if(i.value==='ECR-001')i.click()})")), 0,
            lambda r: ok('diz que não há reproduções', 'Sem reproduções neste período para a seleção.' in r['texts']))
        # validações
        pg.click('[data-a=export]'); time.sleep(.4); pg.click('[data-a=exp-none]'); pg.click('form[data-form=export] button[type=submit]'); time.sleep(.3)
        ok('sem campanha escolhida dá erro', 'pelo menos uma campanha' in pg.inner_text('#form-err'))
        pg.click('[data-a=exp-all]'); pg.select_option('#exp-per', 'custom'); pg.fill('#exp-from', ''); pg.click('form[data-form=export] button[type=submit]'); time.sleep(.3)
        ok('período personalizado sem datas dá erro', 'data inicial' in pg.inner_text('#form-err'))
        pg.click('[data-a=close]'); time.sleep(.3)
        ok('zero erros na consola', not errs)
        if errs: print(errs[:4])
        br.close()
finally:
    try: srv.terminate()
    except Exception: pass
print('FALHAS', fails)
raise SystemExit(1 if fails else 0)
