"""Avisos push no navegador: o bloco «Avisos com a página fechada» nas Preferências das notificações, o service worker,
ativar (com uma subscrição simulada, porque o navegador de testes não tem serviço de push), enviar teste e desativar.
Corre: python3 test/e2e/push.py"""
import subprocess, os, json, time, urllib.request, tempfile, base64
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
data = tempfile.mkdtemp(); port = 8774
env = dict(os.environ, DATA_DIR=data, ADMIN_NAME='Tiago', ADMIN_EMAIL='t@enif.pt', ADMIN_PASS='palavra-passe-longa', PORT=str(port))
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.5); B = 'http://127.0.0.1:%d' % port
fails = []
def ok(n, c):
    print(('PASS ' if c else 'FAIL ') + n)
    if not c: fails.append(n)
def u(b): return base64.urlsafe_b64encode(b).decode().rstrip('=')
try:
    with sync_playwright() as p:
        br = p.chromium.launch(); errs = []
        ctx = br.new_context(viewport={'width': 1300, 'height': 900}, permissions=['notifications'])
        # subscrição simulada: endereço do Google e chaves de 65 e 16 bytes
        ctx.add_init_script("""
          const b = (n, f) => btoa(String.fromCharCode(...new Uint8Array(n).fill(f))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
          let fake = null;
          Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
          const mk = () => { const ep = 'https://fcm.googleapis.com/fcm/send/teste' + Math.random().toString(16).slice(2); const k = new Uint8Array(65).fill(7); k[0] = 4;
            return { endpoint: ep, unsubscribe: async () => { fake = null; return true; }, options: { applicationServerKey: null }, toJSON: () => ({ endpoint: ep, keys: { p256dh: btoa(String.fromCharCode(...k)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''), auth: b(16, 3) } }) }; };
          if (window.PushManager) {
            PushManager.prototype.subscribe = async function () { fake = mk(); return fake; };
            PushManager.prototype.getSubscription = async function () { return fake; };
          }
        """)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(B + '/app/'); time.sleep(1.5)
        pg.fill('#lg-email', 't@enif.pt'); pg.fill('#lg-pass', 'palavra-passe-longa'); pg.click('form[data-form=login] button[type=submit]')
        pg.wait_for_selector('[data-a=nav][data-v=ecras]'); time.sleep(.8)
        sw = urllib.request.urlopen(B + '/app/sw.js'); ok('o service worker é servido como JavaScript', sw.status == 200 and 'javascript' in sw.headers['Content-Type'] and b'showNotification' in sw.read())
        pg.click('[data-a=notifs]'); time.sleep(.5); pg.click('[data-a=notif-tab][data-t=pref]'); time.sleep(.8)
        txt = pg.inner_text('#modal-root')
        ok('as Preferências mostram «Avisos com a página fechada» desligados', 'Avisos com a página fechada' in txt and 'Desligados neste computador' in txt)
        ok('há o botão «Ativar neste computador»', pg.locator('[data-a=push-on]').count() == 1)
        pg.click('[data-a=push-on]'); time.sleep(2)
        txt = pg.inner_text('#modal-root')
        ok('depois de ativar, mostra «Ativos neste computador» com Enviar teste e Desativar', 'Ativos neste computador' in txt and pg.locator('[data-a=push-test]').count() == 1 and pg.locator('[data-a=push-off]').count() == 1)
        pg.click('[data-a=push-test]'); time.sleep(1.5)
        ok('«Enviar teste» responde (a subscrição é falsa, por isso o Google recusa e a app avisa)', 'O servidor não conseguiu enviar o teste' in pg.inner_text('.toast'))
        pg.click('[data-a=push-off]'); time.sleep(1.5)
        ok('«Desativar» volta ao estado desligado', 'Desligados neste computador' in pg.inner_text('#modal-root'))
        ok('sem erros na página', not errs)
        if errs: print(errs)
        br.close()
finally:
    srv.terminate()
print('\n' + ('FALHOU: ' + '; '.join(fails) if fails else 'tudo certo'))
raise SystemExit(1 if fails else 0)
