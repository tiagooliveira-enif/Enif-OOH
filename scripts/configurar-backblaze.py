#!/usr/bin/env python3
"""Liga a cópia de segurança externa (Backblaze B2, cifrada com rclone) e agenda-a todas as noites.
Pede o nome do bucket, a chave do Backblaze e a palavra de cifra; guarda tudo só no servidor (/etc/enif/rclone.conf).
Uso (no servidor, como root):  python3 /opt/enif-ooh/scripts/configurar-backblaze.py"""
import getpass, os, shutil, subprocess, sys, tempfile
if os.geteuid() != 0:
    sys.exit('Execute como root.')
CONF = '/etc/enif/rclone.conf'
APP = '/opt/enif-ooh'
if not shutil.which('rclone'):
    print('A instalar o rclone ...')
    if subprocess.run(['apt-get', 'install', '-y', 'rclone'], stdout=subprocess.DEVNULL).returncode != 0 or not shutil.which('rclone'):
        subprocess.run('curl -fsSL https://rclone.org/install.sh | bash', shell=True, check=True)
def ask(texto, secreto=False):
    while True:
        v = (getpass.getpass(texto) if secreto else input(texto)).strip()
        if v:
            return v
        print('   (ficou vazio, escreva outra vez)')
bucket = ask('Nome do bucket do Backblaze (completo): ')
kid = ask('keyID da chave de aplicação: ')
key = ask('applicationKey (não aparece nada ao escrever): ', True)
while True:
    p1 = ask('Palavra de cifra, mínimo 12 caracteres (guarde-a também fora do servidor!): ', True)
    p2 = ask('Repita a palavra de cifra: ', True)
    if p1 == p2 and len(p1) >= 12:
        break
    print('   (as palavras não são iguais ou têm menos de 12 caracteres; escreva outra vez)')
obs = subprocess.run(['rclone', 'obscure', '-'], input=p1, capture_output=True, text=True, check=True).stdout.strip()
with open(CONF, 'w') as f:
    f.write('[b2]\ntype = b2\naccount = %s\nkey = %s\n\n[b2crypt]\ntype = crypt\nremote = b2:%s/enif\npassword = %s\nfilename_encryption = standard\ndirectory_name_encryption = true\n' % (kid, key, bucket, obs))
os.chmod(CONF, 0o600)
env = dict(os.environ, RCONF=CONF, RCLONE_CONFIG=CONF)
print('A testar a ligação (envia e lê um ficheiro de teste cifrado) ...')
t = tempfile.NamedTemporaryFile('w', delete=False, suffix='.txt'); t.write('teste enif'); t.close()
r = subprocess.run(['rclone', 'copyto', t.name, 'b2crypt:teste/teste.txt'], env=env)
if r.returncode != 0:
    sys.exit('FALHOU a ligação ao Backblaze (veja a mensagem acima: chave, bucket ou permissões).')
back = subprocess.run(['rclone', 'cat', 'b2crypt:teste/teste.txt'], env=env, capture_output=True, text=True)
subprocess.run(['rclone', 'delete', 'b2crypt:teste'], env=env)
if back.stdout.strip() != 'teste enif':
    sys.exit('FALHOU a leitura do ficheiro de teste.')
print('Ligação e cifra OK.')
open('/usr/local/bin/enif-backup-externo', 'w').write('''#!/usr/bin/env bash
# Copia (cifrada) os dados do Enif DOOH para o Backblaze. Uso: enif-backup-externo [--verificar]
set -uo pipefail
export RCLONE_CONFIG=/etc/enif/rclone.conf
DADOS=/var/lib/enif
if [ "${1:-}" = "--verificar" ]; then
  echo "Últimas cópias no Backblaze:"; rclone lsl b2crypt:backups --include "enif-*.db" 2>&1 | sort -k2,3 | tail -3
  ULT=$(rclone lsf b2crypt:backups --include "enif-*.db" | sort | tail -1)
  [ -n "$ULT" ] || { echo "Ainda não há cópias externas."; exit 1; }
  T=$(mktemp -d); rclone copyto "b2crypt:backups/$ULT" "$T/$ULT" || exit 1
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$T/$ULT');console.log('Verificação da cópia',process.argv[1],':',d.prepare('PRAGMA integrity_check').get().integrity_check)" "$ULT" 2>/dev/null
  rm -rf "$T"; [ -f $DADOS/ultima-copia-externa ] && echo "Última cópia concluída: $(cat $DADOS/ultima-copia-externa)"; exit 0
fi
ERR=$(mktemp)
{
  rclone sync $DADOS/backups b2crypt:backups --transfers 4 --log-level NOTICE &&
  { [ ! -d $DADOS/reports ] || rclone sync $DADOS/reports b2crypt:reports --transfers 2 --log-level NOTICE; } &&
  rclone copyto /etc/enif/enif-config.json b2crypt:config/enif-config.json
} >"$ERR" 2>&1
if [ $? -eq 0 ]; then
  date -Is > $DADOS/ultima-copia-externa; rm -f "$ERR"; echo "Cópia externa concluída."
else
  echo "FALHOU:"; cat "$ERR"
  CONFIG_FILE=/etc/enif/enif-config.json node /opt/enif-ooh/scripts/avisar-email.js "Enif DOOH: a cópia de segurança externa falhou" "A cópia externa para o Backblaze falhou. Detalhe: $(tail -c 600 "$ERR")" || true
  rm -f "$ERR"; exit 1
fi
''')
os.chmod('/usr/local/bin/enif-backup-externo', 0o755)
open('/etc/systemd/system/enif-backup-externo.service', 'w').write('[Unit]\nDescription=Copia externa Enif DOOH (Backblaze)\nAfter=network-online.target\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/enif-backup-externo\nNice=10\nIOSchedulingClass=idle\n')
open('/etc/systemd/system/enif-backup-externo.timer', 'w').write('[Unit]\nDescription=Copia externa diaria Enif DOOH\n\n[Timer]\nOnCalendar=*-*-* 04:30:00\nRandomizedDelaySec=10min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n')
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'enif-backup-externo.timer'], check=True)
print('A fazer a primeira cópia externa agora (pode demorar) ...')
r = subprocess.run(['/usr/local/bin/enif-backup-externo'])
if r.returncode == 0:
    subprocess.run(['/usr/local/bin/enif-backup-externo', '--verificar'])
    print('\nPRONTO: a cópia externa corre todas as noites às 04:30.')
sys.exit(r.returncode)
