#!/usr/bin/env python3
"""Pede a caixa e a palavra-passe do e-mail, grava-as no enif-config.json (só no servidor), envia um e-mail de teste
e, se correr bem, reinicia a aplicação.
Uso (no servidor, como root):  python3 /opt/enif-ooh/scripts/configurar-email.py [servidor] [porta]"""
import getpass, json, os, shutil, subprocess, sys
FILE = os.environ.get('CONFIG_FILE', '/etc/enif/enif-config.json')
HERE = os.path.dirname(os.path.abspath(__file__))
servidor = sys.argv[1] if len(sys.argv) > 1 else 'mail.enif.pt'
porta = int(sys.argv[2]) if len(sys.argv) > 2 else 587
caixa = input('Caixa que envia (ex.: tiago.oliveira@enif.pt): ').strip()
if '@' not in caixa or ' ' in caixa:
    sys.exit('Isso não parece um e-mail. Corra outra vez.')
palavra = getpass.getpass('Palavra-passe dessa caixa (não aparece nada ao escrever): ')
if not palavra:
    sys.exit('A palavra-passe ficou vazia. Corra outra vez.')
try:
    c = json.load(open(FILE))
except Exception as e:
    sys.exit('Não consegui ler %s: %s' % (FILE, e))
c['smtp'] = {'servidor': servidor, 'porta': porta, 'seguro': porta == 465, 'utilizador': caixa, 'palavraPasse': palavra, 'de': 'Enif DOOH <%s>' % caixa}
json.dump(c, open(FILE, 'w'), ensure_ascii=False, indent=2)
try:
    shutil.chown(FILE, 'root', 'enif')
except Exception:
    pass
os.chmod(FILE, 0o640)
print('Guardado. A enviar um e-mail de teste para %s ...' % caixa)
r = subprocess.run(['node', os.path.join(HERE, 'testar-email.js'), caixa], env=dict(os.environ, CONFIG_FILE=FILE))
if r.returncode == 0:
    subprocess.run(['systemctl', 'restart', 'enif'])
    print('Aplicação reiniciada com o e-mail ligado.')
else:
    print('O envio falhou: copie a linha FALHOU acima e envie-a ao Claude (sem a palavra-passe).')
sys.exit(r.returncode)
