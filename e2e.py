"""Teste ponta a ponta: servidor real + player real (Chromium) + queda de internet.
Uso: python3 test/e2e.py   (precisa de playwright e de ffmpeg para gerar ficheiros de teste)"""
import json, os, subprocess, sys, tempfile, time, urllib.request, shutil
from datetime import date, timedelta
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 18080; BASE = f'http://localhost:{PORT}'; TOK = 'teste'
tmp = tempfile.mkdtemp()
def ff(*a): subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *a], check=True)
ff('-f', 'lavfi', '-i', 'color=c=0x1D5FE5:s=640x360', '-frames:v', '1', f'{tmp}/a.png')
ff('-f', 'lavfi', '-i', 'color=c=0xB4501B:s=640x360', '-frames:v', '1', f'{tmp}/b.png')
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '2', '-c:v', 'libvpx', '-b:v', '300k', f'{tmp}/v.webm')
env = dict(os.environ, PORT=str(PORT), DATA_DIR=f'{tmp}/data', ADMIN_TOKEN=TOK)
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
res = []
def ok(n, c): res.append(('PASS ' if c else 'FAIL ') + n); return c
def api(m, p, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(BASE + p, data=data, method=m, headers={'x-admin-token': TOK, 'Content-Type': ctype})
    with urllib.request.urlopen(r) as x: return json.loads(x.read())
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + '/health'); break
        except Exception: time.sleep(.1)
    sc = api('POST', '/api/admin/screens', {'venue': 'Teste', 'spot': 'Sala', 'on': 0, 'off': 24})
    def up(name, mime, dur):
        return api('PUT', f'/api/admin/files?name={name}&mime={mime}&dur={dur}', raw=open(f'{tmp}/{name}', 'rb').read(), ctype=mime)['id']
    fa, fb, fv = up('a.png', 'image/png', 2), up('b.png', 'image/png', 2), up('v.webm', 'video/webm', 2)
    d0 = (date.today() - timedelta(days=2)).isoformat(); d1 = (date.today() + timedelta(days=2)).isoformat()
    def camp(name, items, ppm=1, **k):
        return api('POST', '/api/admin/campaigns', dict(name=name, client='X', venues=['Teste'], start=d0, end=d1, h0=0, h1=24, ppm=ppm, priority='Normal', items=[{'f': i} for i in items], **k))['id']
    cA = camp('Camp A', [fa, fv]); cB = camp('Camp B', [fb])
    try: api('POST', '/api/admin/campaigns', dict(name='Mau', client='', venues=['Teste'], start=d1, end=d0, items=[])); ok('datas inválidas recusadas', False)
    except Exception: ok('datas inválidas recusadas', True)
    try: urllib.request.urlopen(BASE + f'/api/player/playlist?code={sc["code"]}&key=errada'); ok('chave errada recusada', False)
    except Exception as e: ok('chave errada recusada', '401' in str(e))
    try: urllib.request.urlopen(BASE + '/api/admin/overview'); ok('admin sem chave recusado', False)
    except Exception as e: ok('admin sem chave recusado', '401' in str(e))
    pl = json.load(urllib.request.urlopen(BASE + f'/api/player/playlist?code={sc["code"]}&key={sc["key"]}'))
    ok('playlist tem 2 dias e 3 ficheiros', len(pl['days']) == 2 and len(pl['files']) == 3)
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 960, 'height': 540}); pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'{BASE}/player/?code={sc["code"]}&key={sc["key"]}&hb=3&flush=3&refresh=5&debug=1')
        pg.wait_for_timeout(14000)
        pg.evaluate("navigator.serviceWorker.ready")
        ov = api('GET', '/api/admin/overview'); s = ov['screens'][0]
        ok('ecrã aparece online', s['online'])
        rep = api('GET', '/api/admin/report?from=0'); n1 = sum(x['plays'] for x in rep['byCampaign'])
        ok(f'passagens registadas ({n1})', n1 >= 4)
        files_seen = {x['file'] for x in rep['byFile']}
        ok('os 2 vídeos da campanha A alternam', {fa, fv} <= files_seen)
        ok('sem erros na página', not errs)
        pg.screenshot(path='/tmp/e2e/player.png')
        # queda de internet
        ctx.set_offline(True); pg.wait_for_timeout(9000)
        q = pg.evaluate("JSON.parse(localStorage.getItem('enif.queue')||'[]').length")
        ok(f'offline: continua a passar e guarda fila ({q})', q >= 2)
        ctx.set_offline(False); pg.wait_for_timeout(8000)
        q2 = pg.evaluate("JSON.parse(localStorage.getItem('enif.queue')||'[]').length")
        rep2 = api('GET', '/api/admin/report?from=0'); n2 = sum(x['plays'] for x in rep2['byCampaign'])
        ok(f'regressa a internet: fila enviada (fila {q2}, total {n2})', n2 >= n1 + 3 and q2 <= 2)
        pids = [r[0] for r in []]
        # recarregar a página offline: continua com a playlist em cache
        ctx.set_offline(True); pg.reload(); pg.wait_for_timeout(7000)
        t = pg.inner_text('#dbg')
        ok('reinício offline: toca da cache', 'a passar C' in t)
        ok('reinício offline: sem erros fatais', not errs)
        ctx.set_offline(False); b.close()
    # ecrã deixa de dar sinal -> alerta
    time.sleep(0.5)
finally:
    srv.terminate(); shutil.rmtree(tmp, ignore_errors=True)
print('\n'.join(res)); sys.exit(1 if any(r.startswith('FAIL') for r in res) else 0)
