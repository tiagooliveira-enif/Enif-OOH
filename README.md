# Enif DOOH

Plataforma interna de gestão de ecrãs OOH: **servidor** (API, base de dados, ficheiros), **aplicação web** (a interface de gestão) e **player** (a página que corre em cada ecrã).

- Sem dependências externas. Só precisa de **Node.js 22.13 ou superior**.
- Dados: SQLite em `data/enif-data.db`; vídeos e imagens em `data/media/`. **Estas duas coisas são tudo o que há para guardar em cópia de segurança.**

## Arrancar

1. Copie `enif-config.example.json` para `enif-config.json` (ao lado do `server.js`) e preencha-o. **Este ficheiro nunca vai para o GitHub** e é o único sítio onde escreve a palavra-passe e os dados do e-mail:

   - `nome`, `email`, `palavraPasse`: a conta de administrador (criada no primeiro arranque; depois pode apagar a palavra-passe do ficheiro).
   - `emailRecuperacao`: para onde vão os códigos de recuperação e de entrada em dois passos.
   - `smtp`: a caixa de correio que envia (código, avisos de fim de campanha e relatórios finais). Sem isto a aplicação funciona, mas **não envia e-mails** e não deixa ligar os dois passos.

2. `node server.js` e abra http://localhost:8080/. A conta é criada no primeiro arranque; depois pode apagar a palavra-passe do ficheiro.
3. Esquecida a palavra-passe? Ponha uma nova no ficheiro e corra `node server.js --reset-admin`.

Não há registo público: **só um administrador cria contas**, em **Utilizadores**, e quem não tiver conta não entra. Depois faz-se tudo na aplicação:

1. **Ecrãs → Novo ecrã**: mostra o código e a chave do player.
2. **Conteúdos**: carregar imagens, vídeos e páginas HTML5 (mede a resolução e a duração sozinho).
3. **Campanhas → Nova campanha**: locais, datas, horas e conteúdos.
4. Abra a ligação do player num separador (ou instale no mini PC). O ecrã passa a **Online** e as passagens aparecem em **Relatórios**.
5. **Utilizadores**: crie contas com perfis (Administrador, Operador, Só consulta ou personalizado) e data limite de acesso.

Variáveis opcionais: `PORT` (8080), `DATA_DIR`, `TZ_NAME` (Europe/Lisbon), `MAX_UPLOAD_MB` (6144, ou seja, 6 GB por ficheiro), `CONFIG_FILE` (outro caminho para o ficheiro de configuração).

## Segurança

- Palavras-passe guardadas com scrypt; sessões de 30 dias; 8 tentativas falhadas bloqueiam o e-mail 10 minutos.
- **Só o administrador** muda palavras-passe (a sua e as dos outros) e recupera a sua por e-mail (código de 6 dígitos, 15 minutos, 5 tentativas). Os outros utilizadores pedem ao administrador.
- **Verificação em dois passos** (opcional, por e-mail): ao entrar, pede um código enviado para o e-mail de recuperação. Se ficar sem acesso, `node server.js --reset-admin` desliga-a.
- Mudar o e-mail de recuperação exige confirmar um código enviado para o **novo** e-mail.
- **Registo de auditoria** que só se acrescenta (a própria base de dados recusa alterar ou apagar), com quem, quando e IP. O administrador vê-o e descarrega-o em CSV.
- **Cópias de segurança**: todas as noites às 03h30 e sob pedido (base de dados + espelho dos ficheiros), mantidas 30 dias em `data/backups/`. **Ficam no mesmo servidor: guarde também uma cópia fora dele.**
- Cada pedido é verificado no servidor contra as permissões do utilizador (a interface só esconde botões).
- Cada ecrã tem uma chave própria. Quem a tiver pode fazer-se passar por esse ecrã: não a partilhe.
- **Antes de pôr na internet: usar HTTPS** (a cache offline do player também o exige; no mini PC o instalador já trata disso para o endereço do servidor).

## Testes

```
npm test                 # loop (e comparação com o protótipo: 22 mil verificações), API, segurança, e-mail e relatório final (servidor SMTP falso)
python3 test/e2e/player.py   # player real num browser: passa conteúdo, arranca sem internet, spot a cada 5 min, comandos (precisa de playwright e ffmpeg)
python3 test/e2e/app.py      # interface real num browser: entrar, páginas, carregar ficheiro, brilho, dois passos, recuperação, telemóvel
```

## Instalar o player num mini PC Windows

No PowerShell como administrador, na pasta `scripts`:

```
.\instalar-player-windows.ps1 -Servidor "http://ENDERECO:8080" -Codigo "ECR-001" -Chave "CHAVE"
```

A aplicação mostra este comando já preenchido na janela do ecrã (botão «Copiar comando de instalação»). O Edge abre em ecrã inteiro com o Windows e reinicia sozinho se fechar. O PC deixa de suspender.

## Como o player funciona

- Pede ao servidor o loop de hoje e de amanhã, hora a hora, e descarrega os ficheiros para a cache do browser.
- **Nunca fica preto**: arranca sempre com a última lista guardada (mesmo sem internet ou depois de uma falha de luz), um vídeo que falhe é saltado e fica o último quadro, e se não houver nada para mostrar aparece o ecrã da Enif. Só fica escuro quando o horário do ecrã o manda desligar.
- O ecrã deve ligar sozinho quando a luz volta: ativar na BIOS «Power on after power failure» (ou equivalente) e usar o instalador, que põe o player a arrancar com o Windows.
- Spot da Enif: com o ecrã cheio, passa 1 vez a cada 5 minutos, a seguir à passagem em curso.
- Sem internet continua a passar o que tem. As passagens ficam numa fila e seguem quando a internet volta (sem duplicados).
- A cada 30 s envia um sinal de vida (e a resolução do ecrã). Sem sinal há mais de 2,5 minutos, o ecrã fica **offline** e gera um alerta.
- «Reiniciar player», «Atualizar agora» e «Teste no ecrã» (padrão de teste durante 30 s) são comandos enviados da aplicação; o ecrã recebe-os em menos de um minuto.
- O player comunica a resolução medida e o espaço livre em disco.
- Brilho: a aplicação guarda o brilho por horário e o manual, mas **um browser não controla o brilho do LED**. É preciso ligar o controlador (Novastar, Colorlight, Linsn…) ou um agente no mini PC: ver as notas do projeto.

## Relatórios

As **passagens** são reais (registadas pelo player). As **visualizações** são uma estimativa: a audiência do ecrã em cada hora (modelo por tipo de local, cidade e curva do dia) repartida pelo tempo que cada vídeo esteve no ar.

## Regras do loop

Campanhas em horário, por prioridade (ou ordem do ecrã), até ao limite do ecrã. «Vezes por minuto» repete a campanha na volta, bem espaçada. Os vídeos de uma campanha alternam a cada passagem. Cada vídeo pode ter dias, horas e vezes por minuto próprios. Lógica em `lib/schedule.js` (o servidor) e repetida na aplicação para pré-visualizar.

## Envios ao comercial

Uma campanha com «E-mail do comercial» recebe um **aviso 7 dias antes do fim** (uma vez por data de fim) e, **na manhã a seguir ao fim** (a partir das 08h), o **relatório final em PDF** com passagens, visualizações estimadas, quadros por ecrã e dia e a imagem de cada conteúdo. Cada envio fica num registo que só se acrescenta (Message-ID, SHA-256 do PDF, resposta do servidor de e-mail). **«Enviado» quer dizer que o servidor de e-mail aceitou a mensagem**; não prova que foi lida. Falhas repetem-se de hora a hora, até 3 vezes, e há «Tentar de novo» na aplicação.

## Ainda por fazer

- Servidor na internet com HTTPS e cópias de segurança **fora** do servidor.
- Controlo do brilho no hardware (depende da marca do controlador de LED).
- Conversão automática de vídeos para os formatos dos ecrãs.
- Teste de segurança independente e revisão de RGPD antes de abrir ao exterior.
