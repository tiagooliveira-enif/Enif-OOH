# Enif OOH

Plataforma interna de gestão de ecrãs OOH: **servidor** (API, base de dados, ficheiros), **aplicação web** (a interface de gestão) e **player** (a página que corre em cada ecrã).

- Sem dependências externas. Só precisa de **Node.js 22.13 ou superior**.
- Dados: SQLite em `data/enif-data.db`; vídeos e imagens em `data/media/`. **Estas duas coisas são tudo o que há para guardar em cópia de segurança.**

## Arrancar

```
node server.js
```

Abra http://localhost:8080/. Na **primeira vez** pede para criar a conta de administrador. Depois faz-se tudo na aplicação:

1. **Ecrãs → Novo ecrã**: mostra o código e a chave do player.
2. **Conteúdos**: carregar imagens, vídeos e páginas HTML5 (mede a resolução e a duração sozinho).
3. **Campanhas → Nova campanha**: locais, datas, horas e conteúdos.
4. Abra a ligação do player num separador (ou instale no mini PC). O ecrã passa a **Online** e as passagens aparecem em **Relatórios**.
5. **Utilizadores**: crie contas com perfis (Administrador, Operador, Só consulta ou personalizado) e data limite de acesso.

Variáveis opcionais: `PORT` (8080), `DATA_DIR`, `TZ_NAME` (Europe/Lisbon), `MAX_UPLOAD_MB` (1024).

## Segurança

- Palavras-passe guardadas com scrypt; sessões de 30 dias; 8 tentativas falhadas bloqueiam o e-mail 10 minutos.
- Cada pedido é verificado no servidor contra as permissões do utilizador (a interface só esconde botões).
- Cada ecrã tem uma chave própria. Quem a tiver pode fazer-se passar por esse ecrã: não a partilhe.
- **Antes de pôr na internet: usar HTTPS** (a cache offline do player também o exige).

## Testes

```
npm test                 # lógica do loop + API (login, permissões, sincronização, upload, player, alertas)
python3 test/e2e.py      # servidor + interface + player real num browser, incluindo queda de internet (precisa de playwright e ffmpeg)
```

## Instalar o player num mini PC Windows

No PowerShell como administrador, na pasta `scripts`:

```
.\instalar-player-windows.ps1 -Servidor "http://ENDERECO:8080" -Codigo "ECR-001" -Chave "CHAVE"
```

A aplicação mostra este comando já preenchido na janela do ecrã (botão «Copiar comando de instalação»). O Edge abre em ecrã inteiro com o Windows e reinicia sozinho se fechar. O PC deixa de suspender.

## Como o player funciona

- Pede ao servidor o loop de hoje e de amanhã, hora a hora, e descarrega os ficheiros para a cache do browser.
- Sem internet continua a passar o que tem. As passagens ficam numa fila e seguem quando a internet volta (sem duplicados).
- A cada 30 s envia um sinal de vida (e a resolução do ecrã). Sem sinal há mais de 2,5 minutos, o ecrã fica **offline** e gera um alerta.
- «Reiniciar player» na aplicação recarrega a página do ecrã.

## Relatórios

As **passagens** são reais (registadas pelo player). As **impressões** continuam a ser uma estimativa: a audiência do ecrã em cada hora (modelo por tipo de local, cidade e curva do dia) repartida pelo tempo que cada vídeo esteve no ar.

## Regras do loop

Campanhas em horário, por prioridade (ou ordem do ecrã), até ao limite do ecrã. «Vezes por minuto» repete a campanha na volta, bem espaçada. Os vídeos de uma campanha alternam a cada passagem. Cada vídeo pode ter dias, horas e vezes por minuto próprios. Lógica em `lib/schedule.js` (o servidor) e repetida na aplicação para pré-visualizar.

## Ainda por fazer

- E-mail e mensagens a sério (hoje os avisos aparecem no sino e como notificações do computador; o envio por e-mail/SMS é só registado).
- Conversão automática de vídeos para os formatos dos ecrãs.
- Servidor na internet com HTTPS e cópias de segurança automáticas.
- Mudar a própria palavra-passe (hoje só um administrador a altera).
