#!/usr/bin/env python3
"""Ensaio de recuperação: pede a palavra de cifra (como a guardou fora do servidor) e confirma que ela abre as cópias
do Backblaze: descarrega a cópia mais recente para uma pasta temporária, verifica-a e apaga-a.
Não mexe nos dados reais. Uso (no servidor, como root):  python3 /opt/enif-ooh/scripts/ensaiar-recuperacao.py"""
import configparser, getpass, os, shutil, subprocess, sys, tempfile
CONF = '/etc/enif/rclone.conf'
if os.geteuid() != 0:
    sys.exit('Execute como root.')
cp = configparser.ConfigParser(); cp.read(CONF)
if 'b2' not in cp or 'b2crypt' not in cp:
    sys.exit('A cópia externa ainda não está configurada (falta %s).' % CONF)
palavra = getpass.getpass('Palavra de cifra, tal como a guardou fora do servidor (não aparece nada): ')
if not palavra:
    sys.exit('Ficou vazia.')
obs = subprocess.run(['rclone', 'obscure', '-'], input=palavra, capture_output=True, text=True, check=True).stdout.strip()
tmp = tempfile.mkdtemp(); conf2 = os.path.join(tmp, 'rclone.conf')
with open(conf2, 'w') as f:
    f.write('[b2]\ntype = b2\naccount = %s\nkey = %s\n\n[b2crypt]\ntype = crypt\nremote = %s\npassword = %s\nfilename_encryption = standard\ndirectory_name_encryption = true\n'
            % (cp['b2']['account'], cp['b2']['key'], cp['b2crypt']['remote'], obs))
os.chmod(conf2, 0o600)
env = dict(os.environ, RCLONE_CONFIG=conf2)
try:
    ls = subprocess.run(['rclone', 'lsf', 'b2crypt:backups', '--include', 'enif-*.db'], env=env, capture_output=True, text=True)
    nomes = sorted(x for x in ls.stdout.split() if x.endswith('.db'))
    if not nomes:
        print('\nERRADA: com esta palavra não consigo ler as cópias (ou ainda não existem). Procure a palavra certa antes de carregar dados reais.')
        sys.exit(1)
    ult = nomes[-1]
    dest = os.path.join(tmp, ult)
    r = subprocess.run(['rclone', 'copyto', 'b2crypt:backups/' + ult, dest], env=env)
    if r.returncode != 0:
        sys.exit('FALHOU a descarga da cópia.')
    js = ("const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);"
          "const n=c=>d.prepare(\"SELECT COUNT(*) n FROM docs WHERE coll=?\").get(c).n;"
          "console.log('  integridade:',d.prepare('PRAGMA integrity_check').get().integrity_check,'| utilizadores:',n('users'),'| ecrãs:',n('screens'),'| campanhas:',n('campaigns'),'| conteúdos:',n('contents'))")
    subprocess.run(['node', '--disable-warning=ExperimentalWarning', '-e', js, dest])
    cfg = subprocess.run(['rclone', 'lsf', 'b2crypt:config'], env=env, capture_output=True, text=True).stdout.split()
    print('  ficheiro de configuração na cópia externa: %s' % ('sim' if 'enif-config.json' in cfg else 'NÃO'))
    print('\nCERTA: a palavra de cifra guardada abre a cópia %s. Ensaio concluído (nada foi alterado no servidor).' % ult)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
