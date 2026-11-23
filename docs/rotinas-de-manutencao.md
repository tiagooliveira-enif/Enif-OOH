# Enif DOOH · Rotinas de manutenção

Guia curto do que convém fazer de vez em quando para a plataforma continuar saudável. Nada aqui é urgente: é prevenção.

## Resumo (calendário sugerido)

| Quando | O quê | Quanto tempo |
|---|---|---|
| Uma vez por semana | Olhar para o Painel (ecrãs online), a página Utilizadores → Segurança (cópias e disco) e o Registo de auditoria (tentativas falhadas) | 3 min |
| Todos os meses | Ensaiar a cópia externa (secção 1) | 5 min |
| Todos os 3 meses | Atualizar o Windows dos ecrãs (secção 3) | ~30 min por PC |
| Uma vez | Ligar a monitorização do servidor (secção 2) | 5 min |
| Em 31/12 e 01/01 | Confirmar que os ecrãs continuam online (secção 4) | 2 min |

## 1. Ensaiar a cópia de segurança externa

As cópias da base de dados são feitas todas as noites às 03h30 e ficam no servidor. A cópia **fora** do servidor (Backblaze, cifrada) protege-te se o servidor se perder. Só sabes que serve se a abrires de vez em quando.

No servidor, como `root`:

```
python3 /opt/enif-ooh/scripts/ensaiar-recuperacao.py
```

Pede a palavra de cifra (a que guardaste fora do servidor), descarrega a cópia mais recente para uma pasta temporária, verifica-a e apaga-a. **Não mexe nos dados reais.** Deve acabar com «CERTA: a palavra de cifra guardada abre a cópia…».

Se disser «ERRADA» ou «a cópia externa ainda não está configurada»: a cópia externa não está a funcionar. Configura-a com `python3 /opt/enif-ooh/scripts/configurar-backblaze.py` e volta a ensaiar.

Para recuperar de verdade (servidor perdido), os passos estão no README, secção «Recuperar uma cópia de segurança». O ensaio completo é automático (`test/e2e/recuperacao.py`) e passa.

## 2. Aviso se o servidor cair

Hoje só dás por isso quando abres a app ou um ecrã fica offline. Um serviço gratuito avisa-te por e-mail.

1. Cria uma conta grátis em **uptimerobot.com**.
2. **Add New Monitor** → tipo **HTTP(s)**.
3. Nome: `Enif DOOH`. URL: `https://enifdooh.pt/api/status`.
4. Intervalo: **5 minutos**.
5. Em «Alert contacts» escolhe o teu e-mail.
6. Guarda. Para testar, o serviço tem um botão de teste; ou desliga o servidor um minuto fora de horas.

Se o servidor deixar de responder durante uns minutos, recebes um e-mail. Quando voltar, recebes outro.

## 3. Atualizações do Windows nos ecrãs (de 3 em 3 meses)

As atualizações automáticas estão desligadas de propósito (para o PC não reiniciar sozinho a meio do dia). Isso quer dizer que os PCs ficam sem correções de segurança se ninguém as fizer à mão.

Faz **um PC de cada vez**, fora de horas (de madrugada ou depois do fecho), com o AnyDesk:

1. Abre o PowerShell **como administrador** e liga o Windows Update:
   ```
   Set-Service wuauserv -StartupType Manual; Set-Service UsoSvc -StartupType Manual; Start-Service wuauserv; Start-Service UsoSvc
   ```
2. Definições → Windows Update → **Verificar atualizações** → instalar tudo → reiniciar quando pedir.
3. Depois do reinício, confirma que o player voltou sozinho (o ecrã mostra os vídeos e fica **Online** na app).
4. **Desliga outra vez** o Windows Update (PowerShell como administrador):
   ```
   Stop-Service wuauserv -Force; Stop-Service UsoSvc -Force; Set-Service wuauserv -StartupType Disabled; Set-Service UsoSvc -StartupType Disabled
   ```
5. Só passas ao PC seguinte quando este estiver online e a reproduzir.

Notas: se um PC não voltar ao arranque normal, usa o ponto de restauro «antes-Enif» criado na instalação. Os ecrãs de cliente com PC deles (YPORTAL) seguem o mesmo procedimento.

## 4. Passagem de ano

Está testada automaticamente (`test/virada-ano.test.js`): 31/12 → 01/01, campanhas e pausas que atravessam o ano, o dia e a hora das passagens, anos bissextos e mudanças de hora (28/03/2027 e 31/10/2027). Nada a fazer antes.

Em 01/01 de manhã, espreita o Painel: os ecrãs devem estar online e a campanha em curso a passar. Os relatórios de dezembro e de janeiro somam-se normalmente se escolheres um período que atravesse o ano.

## 5. O que já é automático (não precisas de fazer nada)

- Cópia da base de dados todas as noites às 03h30 (30 dias guardados) e, se estiver configurada, cópia externa cifrada.
- Renovação do certificado HTTPS (Caddy).
- Limpeza de conteúdos sem uso (reciclagem durante 30 dias).
- Os ecrãs reiniciam o player às 03h00 e atualizam-se sozinhos quando a versão muda.
- Bloqueio da entrada após 4 tentativas falhadas (10 minutos).
