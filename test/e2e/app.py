"""Teste de ponta a ponta da aplicação (browser real): entrada, todas as páginas, janelas, dois passos e recuperação por e-mail (SMTP falso),
telemóvel (390 e 360 px) e zero erros na consola. Precisa de: pip install playwright, ffmpeg. Corre: python3 test/e2e/app.py"""
import subprocess, os, json, time, urllib.request, urllib.parse, tempfile, threading, socketserver, re, base64, sys, datetime
from playwright.sync_api import sync_playwright
HERE=os.path.dirname(os.path.abspath(__file__)); ROOT=os.path.dirname(os.path.dirname(HERE))
data=tempfile.mkdtemp(); port=8766; smtp_port=2526
inbox=[]
class H(socketserver.StreamRequestHandler):
    def handle(self):
        w=lambda s:self.wfile.write((s+'\r\n').encode()); w('220 fake'); to=''
        while True:
            l=self.rfile.readline().decode('latin1')
            if not l: return
            c=l.strip().upper()
            if c.startswith('EHLO'): w('250-fake'); w('250 AUTH PLAIN')
            elif c.startswith('AUTH'): w('235 ok')
            elif c.startswith('MAIL'): w('250 ok')
            elif c.startswith('RCPT'): to=re.search(r'<([^>]+)>',l).group(1); w('250 ok')
            elif c.startswith('DATA'):
                w('354 go'); buf=''
                while True:
                    x=self.rfile.readline().decode('latin1')
                    if x=='.\r\n': break
                    buf+=x
                inbox.append((to,buf)); w('250 2.0.0 Ok: queued as FAKE')
            elif c.startswith('QUIT'): w('221 bye'); return
            else: w('500 ?')
class TS(socketserver.ThreadingTCPServer): allow_reuse_address=True; daemon_threads=True
ts=TS(('127.0.0.1',smtp_port),H); threading.Thread(target=ts.serve_forever,daemon=True).start()
def code_for(addr):
    for to,raw in reversed(inbox):
        if to==addr:
            body=base64.b64decode(re.sub(r'\s+','',raw.split('\r\n\r\n',1)[1])).decode()
            return re.search(r'Código: (\d{6})',body).group(1)
cfg=os.path.join(data,'cfg.json'); json.dump({'emailRecuperacao':'rec@enif.pt'},open(cfg,'w'))
env=dict(os.environ,DATA_DIR=data,ADMIN_NAME='Tiago',ADMIN_EMAIL='t@enif.pt',ADMIN_PASS='palavra-passe-longa',PORT=str(port),CONFIG_FILE=cfg,SMTP_HOST='127.0.0.1',SMTP_PORT=str(smtp_port),SMTP_PLAIN='1',SMTP_FROM='Enif <no@enif.pt>')
srv=subprocess.Popen(['node','--disable-warning=ExperimentalWarning','server.js'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
time.sleep(1.5); B=f'http://127.0.0.1:{port}'
fails=[]
def ok(n,c):
    print(('PASS ' if c else 'FAIL ')+n)
    if not c: fails.append(n)
def call(m,p,body=None,tok=None,raw=None,ct='application/json'):
    h={'Content-Type':ct}
    if tok:h['Authorization']='Bearer '+tok
    d=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    return json.loads(urllib.request.urlopen(urllib.request.Request(B+p,data=d,headers=h,method=m)).read() or b'null')
try:
    tok=call('POST','/api/login',{'email':'t@enif.pt','pass':'palavra-passe-longa'})['token']
    work=tempfile.mkdtemp()
    subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','color=c=green:s=1920x1080:d=4:r=25','-c:v','libvpx','-b:v','200k',work+'/v.webm'],check=True)
    subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','testsrc=s=1920x1080','-frames:v','1',work+'/i.png'],check=True)
    subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','testsrc=s=1080x1920','-frames:v','1',work+'/p.png'],check=True)
    scr=lambda id,v,res:{'id':id,'venue':v,'city':'Braga','spot':'Átrio','type':'Painel horizontal','res':res,'limit':3,'order':[],'draft':None,'loc':{'addr':'Av. da Liberdade 1','lat':None,'lng':None,'env':'centro-comercial','pop':None},'on':0,'off':24,'onT':'00:00','offT':'23:59','fit':'caber','bri':None}
    call('POST','/api/sync',{'ops':[{'op':'put','coll':'screens','id':'ECR-001','doc':scr('ECR-001','Fórum Braga','1920×1080')},{'op':'put','coll':'screens','id':'ECR-002','doc':scr('ECR-002','Plaza Porto','1080×1920')}]},tok)
    def up(name,mime,path,extra):
        r=urllib.request.Request(B+'/api/upload?name=%s&mime=%s%s'%(urllib.parse.quote(name),urllib.parse.quote(mime,safe=''),extra),data=open(path,'rb').read(),headers={'Authorization':'Bearer '+tok},method='PUT'); return json.loads(urllib.request.urlopen(r).read())
    v=up('Verão.webm','video/webm',work+'/v.webm','&screens=ECR-001'); im=up('Cartaz.png','image/png',work+'/i.png','&screens=ECR-001'); sp=up('Spot_Enif.png','image/png',work+'/i.png','&screens=ECR-001&house=1')
    pi=up('Vertical.png','image/png',work+'/p.png','&screens=ECR-002')
    today=datetime.date.today(); d=lambda n:(today+datetime.timedelta(days=n)).isoformat()
    camp=lambda id,name,items,s,e,venues:{'id':id,'name':name,'client':'Café Central','venues':venues,'sector':'Cafés','sales':'comercial@x.pt','start':s,'end':e,'h0':8,'h1':23,'ppm':1,'dur':10,'priority':'Normal','manual':False,'color':1,'items':[{'f':i,'h0':None,'h1':None,'d0':None,'d1':None,'ppm':1} for i in items],'pauses':[]}
    call('POST','/api/sync',{'ops':[{'op':'put','coll':'campaigns','id':'C1','doc':camp('C1','Verão no Fórum',[v['id'],im['id']],d(-3),d(10),['Fórum Braga'])},{'op':'put','coll':'campaigns','id':'C2','doc':camp('C2','Campanha vertical',[pi['id']],d(-1),d(20),['Plaza Porto'])}]},tok)
    key=[x for x in call('GET','/api/state',tok=tok)['screens'] if x['id']=='ECR-001'][0]['playerKey']
    import uuid
    now=int(time.time()*1000); plays=[{'pid':str(uuid.uuid4()),'c':'C1','f':(v if k%2 else im)['id'],'ts':now-(k*600000),'dur':10,'ok':1} for k in range(40)]
    call('POST','/api/player/plays',{'code':'ECR-001','key':key,'plays':plays})
    with sync_playwright() as p:
        br=p.chromium.launch(); errs=[]
        def newpage(w,h):
            ctx=br.new_context(viewport={'width':w,'height':h}); pg=ctx.new_page()
            pg.on('pageerror',lambda e:errs.append(('pageerror',str(e))))
            pg.on('console',lambda m:errs.append(('console',m.text)) if m.type=='error' and 'agent-proxy' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text else None)
            return ctx,pg
        ctx,pg=newpage(1300,900)
        pg.goto(B+'/app/'); pg.wait_for_selector('#lg-email'); 
        pg.fill('#lg-email','t@enif.pt'); pg.fill('#lg-pass','errada'); pg.click('form[data-form=login] button[type=submit]'); time.sleep(.8)
        ok('palavra-passe errada mostra erro', 'incorretos' in pg.inner_text('#form-err'))
        pg.fill('#lg-pass','palavra-passe-longa'); pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]')
        ok('entrou', True)
        for v_ in ['painel','ecras','campanhas','conteudos','relatorios','utilizadores']:
            pg.click(f'[data-a=nav][data-v={v_}]'); time.sleep(.8)
            ok('página '+v_+' abre', len(pg.inner_text('#view'))>40)
            ov=pg.evaluate('document.documentElement.scrollWidth-window.innerWidth'); ok('sem scroll horizontal em '+v_+' (1300)', ov<=0)
        txt=pg.inner_text('#view')
        ok('Utilizadores mostra Segurança, cópias e auditoria', 'Cópias de segurança' in txt and 'Registo de auditoria' in txt and 'dois passos' in txt)
        ok('auditoria já tem a entrada do administrador', 'Entrou' in txt)
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.5)
        ok('ecrãs reais listados', 'Fórum Braga' in pg.inner_text('#view') and 'Plaza Porto' in pg.inner_text('#view'))
        pg.click('[data-a=open-screen][data-id=ECR-001]'); time.sleep(.6)
        mt=pg.inner_text('.modal') if pg.query_selector('.modal') else ''
        ok('ficha do ecrã mostra Brilho, Ajuste do vídeo e código do player', 'Brilho' in mt and 'Ajuste' in mt)
        pg.keyboard.press('Escape'); pg.evaluate("document.querySelector('[data-a=close]')&&document.querySelector('[data-a=close]').click()")
        pg.click('[data-a=nav][data-v=campanhas]'); time.sleep(.6)
        ok('campanhas reais listadas', 'Verão no Fórum' in pg.inner_text('#view'))
        pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(.6)
        ok('conteúdos reais listados (e o spot da Enif)', 'Cartaz' in pg.inner_text('#view') and 'Spot da Enif' in pg.inner_text('#view') or 'Spot_Enif' in pg.inner_text('#view'))
        # carregar um ficheiro pela interface (resolução lida do ficheiro, ecrãs escolhidos)
        pg.click('[data-a=nav][data-v=conteudos]'); time.sleep(.5)
        pg.set_input_files('#file-input',[work+'/i.png']); pg.wait_for_selector('form[data-form=upload]'); time.sleep(.5)
        ut=pg.inner_text('form[data-form=upload]'); ok('janela de carregamento pede os ecrãs', 'Fórum Braga' in ut or 'ECR-001' in ut)
        print([ (x.get_attribute('name'),x.is_checked()) for x in pg.query_selector_all('form[data-form=upload] input[type=checkbox]')][:6])
        pg.click('form[data-form=upload] input[name=us0] >> nth=0'); pg.click('form[data-form=upload] button[type=submit]'); time.sleep(2.5)
        st_=call('GET','/api/state',tok=tok); newf=[c for c in st_['contents'] if c['name']=='i.png']
        ok('ficheiro carregado pela interface chega ao servidor com ecrãs', len(newf)==1 and newf[0].get('screens'))
        # brilho do ecrã pela interface
        pg.click('[data-a=nav][data-v=ecras]'); time.sleep(.4); pg.click('[data-a=open-screen][data-id=ECR-001]'); time.sleep(.5)
        pg.click('[data-a=edit-bri]'); time.sleep(.4)
        pg.select_option('#b-mode','manual'); pg.select_option('#b-man','60')
        pg.click('form[data-form=bri] button[type=submit]'); time.sleep(1.5)
        b_=[x for x in call('GET','/api/state',tok=tok)['screens'] if x['id']=='ECR-001'][0].get('bri')
        ok('brilho manual guardado no servidor', b_ and b_['mode']=='manual')
        pg.evaluate("document.querySelector('[data-a=close]')&&document.querySelector('[data-a=close]').click()")
        pg.click('[data-a=nav][data-v=relatorios]'); time.sleep(.8)
        time.sleep(1.5); rt=pg.inner_text('#view'); ok('relatórios falam de Visualizações', 'isualizações' in rt and 'mpressões' not in rt and 'Sem reproduções' not in rt)
        if 'isualizações' not in rt: print(rt[:600])
        # dois passos pela interface
        pg.click('[data-a=nav][data-v=utilizadores]'); time.sleep(.5)
        ok('recuperação veio da configuração', 'rec@enif.pt' in pg.input_value('#sec-rec'))
        pg.click('[data-a=twofa-toggle]'); time.sleep(1); ok('dois passos ligados', 'ligada' in pg.inner_text('#view'))
        # mudar o e-mail de recuperação
        pg.fill('#sec-rec','novo@enif.pt'); pg.click('[data-a=rec-save]'); pg.wait_for_selector('#rc-code'); time.sleep(.3)
        pg.fill('#rc-code',code_for('novo@enif.pt')); pg.click('form[data-form=recconfirm] button[type=submit]'); time.sleep(1.2)
        ok('e-mail de recuperação confirmado por código', 'novo@enif.pt' in pg.input_value('#sec-rec'))
        pg.click('[data-a=backup-now]'); time.sleep(1.5); ok('cópia de segurança feita pela interface', 'manual' not in pg.inner_text('#view') and ('feita pelo administrador' in pg.inner_text('#view')))
        pg.evaluate("document.querySelector('[data-a=logout]')&&document.querySelector('[data-a=logout]').click()"); time.sleep(1)
        # login com código
        pg.wait_for_selector('#lg-email'); pg.fill('#lg-email','t@enif.pt'); pg.fill('#lg-pass','palavra-passe-longa'); pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('#tf-code'); time.sleep(.3)
        pg.fill('#tf-code','000000' if code_for('novo@enif.pt')!='000000' else '111111'); pg.click('form[data-form=twofa] button[type=submit]'); time.sleep(.8)
        ok('código errado mostra erro', 'incorreto' in pg.inner_text('#form-err'))
        pg.fill('#tf-code',code_for('novo@enif.pt')); pg.click('form[data-form=twofa] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); ok('entrou com o código enviado ao e-mail de recuperação', True)
        pg.click('[data-a=nav][data-v=utilizadores]'); time.sleep(.5); pg.click('[data-a=twofa-toggle]'); time.sleep(.8)
        # recuperação
        pg.evaluate("document.querySelector('[data-a=logout]')&&document.querySelector('[data-a=logout]').click()"); time.sleep(1)
        pg.wait_for_selector('[data-a=forgot-open]'); pg.click('[data-a=forgot-open]'); pg.fill('#fg-email','t@enif.pt'); pg.click('form[data-form=forgot] button[type=submit]'); pg.wait_for_selector('#fc-code'); time.sleep(.3)
        pg.fill('#fc-code',code_for('novo@enif.pt')); pg.fill('#fc-new','outra-palavra-passe-9'); pg.fill('#fc-new2','outra-palavra-passe-9'); pg.click('form[data-form=forgotcode] button[type=submit]'); pg.wait_for_selector('#lg-email'); time.sleep(.5)
        pg.fill('#lg-email','t@enif.pt'); pg.fill('#lg-pass','outra-palavra-passe-9'); pg.click('form[data-form=login] button[type=submit]'); pg.wait_for_selector('[data-a=nav][data-v=ecras]'); ok('recuperou a palavra-passe e entrou', True)
        ctx.close()
        # telemóvel
        for w,h in ((390,800),(360,740)):
            ctx,pg=newpage(w,h); pg.goto(B+'/app/'); pg.wait_for_selector('#lg-email'); pg.fill('#lg-email','t@enif.pt'); pg.fill('#lg-pass','outra-palavra-passe-9'); pg.click('form[data-form=login] button[type=submit]'); time.sleep(1.5)
            for v_ in ['painel','ecras','campanhas','conteudos','relatorios','utilizadores']:
                el=pg.query_selector(f'[data-a=nav][data-v={v_}]')
                if el and el.is_visible(): el.click()
                else: pg.evaluate(f"state.view='{v_}';render()")
                time.sleep(.6)
                ov=pg.evaluate('document.documentElement.scrollWidth-window.innerWidth'); ok(f'sem scroll horizontal em {v_} ({w})', ov<=2)
            ctx.close()
        br.close()
    ok('zero erros na consola', not errs)
    if errs: print(errs[:6])
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-500:]); ts.shutdown()
print('FALHAS',fails); sys.exit(1 if fails else 0)
