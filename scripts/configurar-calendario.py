#!/usr/bin/env python3
"""Liga o calendário Google (só leitura): pede o endereço secreto em formato iCal e a palavra-chave, guarda-os só no
servidor, testa a leitura e reinicia a aplicação.
Uso (no servidor, como root):  python3 /opt/enif-ooh/scripts/configurar-calendario.py"""
import getpass, json, os, shutil, subprocess, sys
FILE = os.environ.get('CONFIG_FILE', '/etc/enif/enif-config.json')
HERE = os.path.dirname(os.path.abspath(__file__))
while True:
    link = getpass.getpass('Endereço secreto em formato iCal (não aparece nada ao colar): ').strip()
    if link.startswith('https://calendar.google.com/') and '.ics' in link:
        break
    print('   (tem de começar por https://calendar.google.com/ e terminar em basic.ics; copie o «Endereço secreto em formato iCal»)')
palavra = input('Palavra-chave dos eventos de spots [SPOTS DIGITAIS]: ').strip() or 'SPOTS DIGITAIS'
try:
    c = json.load(open(FILE))
except Exception as e:
    sys.exit('Não consegui ler %s: %s' % (FILE, e))
c['calendario'] = {'link': link, 'palavra': palavra}
json.dump(c, open(FILE, 'w'), ensure_ascii=False, indent=2)
try:
    shutil.chown(FILE, 'root', 'enif')
except Exception:
    pass
os.chmod(FILE, 0o640)
print('Guardado. A ler o calendário ...')
r = subprocess.run(['node', os.path.join(HERE, 'testar-calendario.js')], env=dict(os.environ, CONFIG_FILE=FILE))
if r.returncode == 0:
    subprocess.run(['systemctl', 'restart', 'enif'])
    print('Aplicação reiniciada com o calendário ligado.')
sys.exit(r.returncode)
