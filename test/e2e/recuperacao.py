"""Ensaio de recuperação: cria dados, faz uma cópia, «perde» o servidor e restaura a cópia numa pasta nova; confirma que tudo ficou igual.
Corre: python3 test/e2e/recuperacao.py"""
import subprocess, os, json, time, urllib.request, tempfile, glob, hashlib, shutil
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8781; B = 'http://127.0.0.1:%d' % port
env = dict(os.environ, PORT=str(port), ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', CONFIG_FILE='/nonexistent.json')
def start(d):
    p = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=dict(env, DATA_DIR=d), stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(2); return p
def call(m, p, body=None, tok=None, raw=None):
    h = {'Content-Type': 'application/json'}
    if tok: h['Authorization'] = 'Bearer ' + tok
    d = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(urllib.request.Request(B + p, data=d, headers=h, method=m)).read() or b'null')
IMG = HERE + '/img/'
def snap(tok):
    st = call('GET', '/api/state', tok=tok)
    return {'screens': sorted((s['id'], s['playerKey']) for s in st['screens']), 'camps': sorted((c['id'], c['name'], c['end']) for c in st['campaigns']),
            'contents': sorted((c['id'], c['name'], c.get('folder')) for c in st['contents']), 'folders': [f['name'] for f in st['folders']], 'users': sorted(u['email'] for u in st['users']), 'audit': len(st['auditLog'])}
srv = start(data)
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    scr = {'id': 'ECR-001', 'venue': 'Fórum', 'city': 'Braga', 'spot': 'Átrio', 'type': 'Painel', 'res': '1920×1080', 'limit': 2, 'order': [], 'draft': None, 'loc': {'addr': '', 'lat': None, 'lng': None, 'env': '', 'pop': None}}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'screens', 'id': 'ECR-001', 'doc': scr}, {'op': 'put', 'coll': 'folders', 'id': 'P1', 'doc': {'id': 'P1', 'name': 'Braga'}}]}, tok)
    up = lambda n, f: call('PUT', '/api/upload?name=%s&mime=image/png&screens=ECR-001&secs=3&folder=P1' % n, tok=tok, raw=open(IMG + f, 'rb').read())
    f1 = up('a.png', 'i1.png'); f2 = up('b.png', 'p1.png')
    camp = {'id': 'C1', 'name': 'Camp', 'client': 'Cli', 'venues': ['Fórum'], 'start': '2020-01-01', 'end': '2099-01-01', 'h0': 8, 'h1': 22, 'ppm': 2, 'dur': 10, 'priority': 'Normal', 'manual': False, 'color': 2, 'items': [{'f': f1['id'], 'h0': None, 'h1': None, 'd0': None, 'd1': None, 'ppm': 1}], 'sector': '', 'sales': '', 'pauses': []}
    call('POST', '/api/sync', {'ops': [{'op': 'put', 'coll': 'campaigns', 'id': 'C1', 'doc': camp}]}, tok)
    b = call('POST', '/api/backup-now', {}, tok); print('cópia feita:', b)
    time.sleep(.5); before = snap(tok); print('antes:', {k: (len(v) if isinstance(v, list) else v) for k, v in before.items()})
    mfiles = {os.path.basename(p): hashlib.md5(open(p, 'rb').read()).hexdigest() for p in glob.glob(data + '/media/*')}
finally:
    srv.terminate(); srv.wait()
bk = sorted(glob.glob(data + '/backups/enif-*.db')); print('cópias na pasta:', [os.path.basename(x) for x in bk], '| media na cópia:', len(os.listdir(data + '/backups/media')))
# desastre: o servidor perde-se; só sobra a pasta de cópias (como se viesse do exterior)
ext = tempfile.mkdtemp(); shutil.copytree(data + '/backups', ext + '/backups'); shutil.rmtree(data)
# recuperação num servidor novo
new = tempfile.mkdtemp(); os.makedirs(new + '/media')
shutil.copy(bk[-1].replace(data, ext), new + '/enif-data.db')
for f in os.listdir(ext + '/backups/media'): shutil.copy(ext + '/backups/media/' + f, new + '/media/' + f)
srv = start(new)
try:
    tok = call('POST', '/api/login', {'email': 't@x.pt', 'pass': 'segredo12'})['token']
    after = snap(tok)
    for k in before:
        if k == 'audit': print('registo de auditoria: antes %d, depois %d (a cópia é anterior a esta contagem; o servidor regista o arranque)' % (before[k], after[k])); continue
        print(('IGUAL ' if before[k] == after[k] else 'DIFERENTE ') + k)
    m2 = {os.path.basename(p): hashlib.md5(open(p, 'rb').read()).hexdigest() for p in glob.glob(new + '/media/*')}
    print('media iguais byte a byte:', mfiles == m2)
    key = dict(after['screens'])['ECR-001']; pl = call('GET', '/api/player/playlist?code=ECR-001&key=%s' % key); print('player antigo consegue ligar-se com a mesma chave:', 'tz' in pl)
    r = urllib.request.urlopen(urllib.request.Request(B + '/media/' + f1['id'] + '?t=' + tok)); print('imagem serve-se:', r.status, len(r.read()), 'bytes')
finally:
    srv.terminate()
