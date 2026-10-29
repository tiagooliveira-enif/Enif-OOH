import subprocess, os, json, time, urllib.request, tempfile, sys, datetime
from playwright.sync_api import sync_playwright
SP='/tmp/claude-0/-home-claude/cfcdaaf6-aa04-5c4d-97c2-d50a40180670/scratchpad/pl'
data=tempfile.mkdtemp(); port=8765
env=dict(os.environ, DATA_DIR=data, ADMIN_NAME='T', ADMIN_EMAIL='t@x.pt', ADMIN_PASS='segredo12', PORT=str(port), CONFIG_FILE=data+'/none.json')
srv=subprocess.Popen(['node','--disable-warning=ExperimentalWarning','server.js'],cwd='/home/claude/enif-ooh',env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
time.sleep(1.5)
B=f'http://127.0.0.1:{port}'
def call(m,p,body=None,tok=None,raw=None):
    h={'Content-Type':'application/json'}
    if tok:h['Authorization']='Bearer '+tok
    d=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    try:
        r=urllib.request.urlopen(urllib.request.Request(B+p,data=d,headers=h,method=m)); return json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e: print('HTTP',e.code,e.read()[:200]); raise
fails=[]
def ok(n,c):
    print(('PASS ' if c else 'FAIL ')+n); 
    if not c: fails.append(n)
try:
    tok=call('POST','/api/login',{'email':'t@x.pt','pass':'segredo12'})['token']
    def up(name,mime,path):
        return call('POST','/api/upload?name=%s&mime=%s&screens=ECR-001'%(name,mime),tok=tok,raw=open(path,'rb').read()) if False else None
    def upload(name,mime,path,extra=''):
        req=urllib.request.Request(B+'/api/upload?name=%s&mime=%s&screens=ECR-001%s'%(name,mime,extra),data=open(path,'rb').read(),headers={'Authorization':'Bearer '+tok,'Content-Type':'application/octet-stream'},method='PUT')
        return json.loads(urllib.request.urlopen(req).read())
    scr={'id':'ECR-001','venue':'Fórum','city':'Braga','spot':'Átrio','type':'Painel horizontal','res':'1920×1080','limit':1,'order':[],'draft':None,'loc':{'addr':'','lat':None,'lng':None,'env':'centro-comercial','pop':None},'on':0,'off':24,'onT':'00:00','offT':'23:59'}
    call('POST','/api/sync',{'ops':[{'op':'put','coll':'screens','id':'ECR-001','doc':scr}]},tok)
    v=upload('v.webm','video/webm',SP+'/v1.webm'); im=upload('i.png','image/png',SP+'/i1.png','&secs=3')
    sp=upload('sp.png','image/png',SP+'/sp.png','&house=1')
    ok('upload leu a resolução do vídeo', v['res']=='1920×1080' and abs(float(v['dur'].split()[0])-4)<=1)
    print(v['dur'], im.get('secs'), sp['house'])
    today=datetime.date.today().isoformat()
    camp={'id':'C1','name':'Camp','client':'Cli','venues':['Fórum'],'start':'2020-01-01','end':'2099-01-01','h0':0,'h1':24,'ppm':1,'dur':4,'priority':'Normal','manual':False,'color':1,'items':[{'f':v['id'],'h0':None,'h1':None,'d0':None,'d1':None,'ppm':1},{'f':im['id'],'h0':None,'h1':None,'d0':None,'d1':None,'ppm':1}]}
    call('POST','/api/sync',{'ops':[{'op':'put','coll':'campaigns','id':'C1','doc':camp}]},tok)
    pl=call('GET','/api/player/playlist?code=ECR-001&key='+call('GET','/api/state',tok=tok)['screens'][0]['playerKey'])
    key=call('GET','/api/state',tok=tok)['screens'][0]['playerKey']
    print('playerKey',bool(key))
    h=datetime.datetime.now().hour
    ok('playlist com spot5 (ecrã cheio, limite 1)', any(d for d in pl['days'].values()) and list(pl['days'].values())[0][str(h)]['spot5'] is not None)
    with sync_playwright() as p:
        br=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx=br.new_context(viewport={'width':1280,'height':720},service_workers='allow')
        ctx.add_init_script('var __d=Date.now.bind(Date);Date.now=function(){return __d()-3*3600*1000;};')   # relógio do PC 3 h atrasado
        pg=ctx.new_page(); errs=[]
        pg.on('pageerror',lambda e:errs.append(str(e)))
        pg.goto(f'{B}/player/?code=ECR-001&key={key}&hb=2&flush=2&refresh=5&spotgap=15')
        time.sleep(30)
        st=pg.evaluate('window.__enif.state()')
        print(st)
        ok('player está a passar conteúdo', st['stats']['plays']>=3 and st['stats']['fails']==0)
        ok('corrige o relógio do PC com a hora do servidor', abs(st['skew']-3*3600*1000)<120000)
        ok('nunca fica sem elemento no palco', st['children']>=1)
        # offline: arranca de novo sem rede
        ctx.set_offline(True); pg.reload(); time.sleep(20)
        st=pg.evaluate('window.__enif.state()')
        print('offline',st)
        ok('arranca sem rede com a última lista e passa conteúdo', st['stats']['plays']>=1 and st['children']>=1)
        # spot5: um dia de logs
        ctx.set_offline(False); time.sleep(6)
        # comando test
        call('POST','/api/screens/ECR-001/test',{},tok); time.sleep(5)
        ok('ecrã de teste aparece', pg.evaluate("getComputedStyle(document.querySelector('#test')).display")=='block')
        st=call('GET','/api/state',tok=tok)
        lv=[s for s in st['screens']][0]
        print({k:lv.get(k) for k in ('online','w','h','disk')})
        plays=call('GET','/api/plays?from=2020-01-01&to=2099-01-01',tok=tok)
        print(str(plays)[:300])
        sp_n=sum(r['n'] for r in plays['rows'] if r['c']=='__spot'); ok('spot da Enif entrou (a cada 15 s no teste)', sp_n>=1); print('spots',sp_n)
        ok('sem erros JS', not errs); print(errs)
        # ficheiro em falta: apaga conteúdo do cache e da rede -> não fica preto
        pg.evaluate("window.caches.delete('enif-media-v1')"); ctx.set_offline(True); time.sleep(6)
        st=pg.evaluate('window.__enif.state()'); print('sem cache nem rede',st)
        ok('sem cache nem rede mantém o último quadro ou a marca (nunca preto)', st['children']>=1 or pg.evaluate("getComputedStyle(document.querySelector('#brand')).display")=='grid')
        # horário de funcionamento: fora dele o ecrã fica preto total (ao minuto) e volta a ligar
        ctx.set_offline(False); time.sleep(3)
        nw=datetime.datetime.now(); hh=nw.hour+nw.minute/60
        off_scr=dict(scr, on=(hh+1.5 if hh<21 else 0), off=(24 if hh<21 else hh-1))
        call('POST','/api/sync',{'ops':[{'op':'put','coll':'screens','id':'ECR-001','doc':off_scr}]},tok)
        time.sleep(12)
        ok('fora do horário o ecrã fica preto total', pg.evaluate("getComputedStyle(document.querySelector('#off')).display")=='block' and pg.evaluate('window.__enif.state()')['children']==0)
        call('POST','/api/sync',{'ops':[{'op':'put','coll':'screens','id':'ECR-001','doc':scr}]},tok)
        time.sleep(12)
        ok('dentro do horário volta a mostrar conteúdo', pg.evaluate("getComputedStyle(document.querySelector('#off')).display")=='none' and pg.evaluate('window.__enif.state()')['children']>=1)
        # hora sem campanhas: o último conteúdo não fica parado no ecrã
        hr=datetime.datetime.now().hour
        c0,c1=((hr+1,hr+2) if hr<22 else (0,1))
        call('POST','/api/sync',{'ops':[{'op':'put','coll':'campaigns','id':'C1','doc':dict(camp,h0=c0,h1=c1)}]},tok)
        time.sleep(14)
        ok('hora sem campanhas mostra a marca e não o último conteúdo', pg.evaluate('window.__enif.state()')['children']==0 and pg.evaluate("getComputedStyle(document.querySelector('#brand')).display")=='grid')
        call('POST','/api/sync',{'ops':[{'op':'put','coll':'campaigns','id':'C1','doc':camp}]},tok)
        time.sleep(12)
        ok('com campanha volta a passar conteúdo', pg.evaluate('window.__enif.state()')['children']>=1)
        br.close()
finally:
    srv.terminate(); print(srv.stdout.read().decode()[-600:])
print('FALHAS',fails)
