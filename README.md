# Enif DOOH

Plataforma interna de gestão de ecrãs OOH: **servidor** (API, base de dados, ficheiros), **aplicação web** (a interface de gestão) e **player** (a página que corre em cada ecrã).

- Sem dependências externas. Só precisa de **Node.js 22.13 ou superior**.
- Dados: SQLite em `data/enif-data.db`; vídeos e imagens em `data/media/`. **Estas duas coisas são tudo o que há para guardar em cópia de segurança.**

## Arrancar

1. Copie `enif-config.example.json` para `enif-config.json` (ao lado do `server.js`) e preencha-o. **Este ficheiro nunca vai para o GitHub** e é o único sítio onde escreve a palavra-passe e os dados do e-mail:

   - `nome`, `email`, `palavraPasse`: a conta de administrador (criada no primeiro arranque; depois pode apagar a palavra-passe do ficheiro).
   - `emailRecuperacao`: para onde vão os códigos de recuperação e de entrada em dois passos.
   - `smtp`: a caixa de correio que envia (código, avisos de fim de campanha e relatórios finais). Sem isto a aplicação funciona, mas **não envia e-mails** e não deixa ligar os dois passos.
   - `calendario` (opcional): `link` = o **endereço secreto em formato iCal** do teu calendário Google (Google Calendar → Definições do calendário → «Endereço secreto em formato iCal»; só leitura) e `palavra` = só os eventos com esta palavra no título ou descrição aparecem no painel (por defeito «SPOTS DIGITAIS»). O painel avisa «Verificar Evento» 48 h antes e podes marcar como lido. **Quem tem este endereço consegue ler o calendário: escreve-o só neste ficheiro, nunca no GitHub nem em conversas.**
   - **Movimento à volta do ecrã:** não precisa de configuração. Ao carregar em «Ver movimento à volta» (Localização e horário de um ecrã com coordenadas), o servidor pergunta ao OpenStreetMap (Overpass, https://overpass-api.de) quantas lojas, restaurantes, paragens, escolas e hospitais há num raio de 250 m e guarda os números. O servidor precisa de acesso à internet. Dados © colaboradores do OpenStreetMap.

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
python3 test/e2e/comprovativo.py   # comprovativo: a lista só mostra o que serve ao ecrã, o player passa só o escolhido e volta ao normal, nada fica nos relatórios
python3 test/e2e/avisos.py   # aviso «campanha abaixo do contratado» e «Ocupação por mês» (demora ~2 min: a conta fica guardada 1 minuto)
python3 test/e2e/recuperacao.py   # ensaio de recuperar uma cópia de segurança numa pasta nova
python3 test/e2e/inatividade.py   # a sessão termina por inatividade (aqui 30 s em vez de 15 min)
python3 test/e2e/limpeza.py   # limpeza de conteúdos sem uso: aviso no painel e «Manter», reciclagem e «Restaurar», prazos
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
- A cada 10 s envia um sinal de vida (e a resolução do ecrã). Sem sinal há mais de 2,5 minutos, o ecrã fica **offline** e gera um alerta.
- «Reiniciar player», «Atualizar agora» e «Teste no ecrã» (padrão de teste durante 30 s) são comandos enviados da aplicação; o ecrã recebe-os em menos de um minuto.
- O player comunica a resolução medida e o espaço livre em disco.
- Brilho: a aplicação guarda o brilho por horário e o manual, mas **um browser não controla o brilho do LED**. É preciso ligar o controlador (Novastar, Colorlight, Linsn…) ou um agente no mini PC: ver as notas do projeto.

## Gravar comprovativo

Para o vídeo semanal de prova: na ficha do ecrã, **Gravar comprovativo** (precisa da permissão de playlist e de o ecrã estar online). A lista mostra **todos os conteúdos da biblioteca que servem a esse ecrã** (os de outra resolução ou proporção não aparecem); escolhem-se 1 ou 2 e a duração (30 s a 2 min; o máximo de 2 minutos é imposto no servidor). Enquanto dura, o ecrã passa **só** esses conteúdos e todo o resto fica em pausa, spot da Enif incluído; o player muda em poucos segundos (sinal de vida a cada 10 s) e volta ao normal sozinho no fim, ou com «Terminar já». As passagens do comprovativo **não são guardadas**, por isso não entram nos relatórios nem no PDF final; ficam só na auditoria e na lista «Comprovativos gravados» da ficha do ecrã. Dados: tabelas `proofs` e `proof_log`; API `POST /api/screens/:id/proof` e `/proof/stop`.

## Aviso «campanha abaixo do contratado»

Só aviso interno (painel «Precisa de atenção» e notificações do tipo «Campanha abaixo do contratado»); **nunca entra nos relatórios**. O servidor compara, hora a hora, as passagens que o loop prevê nas últimas 24 h com as que o player registou. Se uma campanha ativa ficou abaixo de 90 % (e eram previstas pelo menos 20), avisa com a causa principal (ecrã sem sinal, falhas de reprodução ou passagens a menos) e o ecrã mais afetado. «Marcar como resolvido» vale para esse dia. A conta fica guardada 1 minuto no servidor. Constantes `UNDER_PCT` e `UNDER_MIN` em `server.js`.

## Avisos importantes por e-mail ao administrador
Precisa do SMTP configurado (`smtp` no `enif-config.json`). A cada minuto o servidor (`alertMailTick`) vê os avisos em aberto e envia por e-mail só os que não podem esperar: **ecrã sem ligação há 15 minutos ou mais**, **campanha com 10 % ou menos das passagens previstas** (se a causa for o ecrã sem sinal, já há o aviso do ecrã), **disco quase cheio** (ecrã ou servidor) e **cópia de segurança automática falhada**.
- Um e-mail por problema e outro quando se resolve (se foi marcado como resolvido na app, não há segundo e-mail); no máximo 30 por dia. Fica registado na auditoria e na tabela `alert_mail`.
- Só vai para administradores. Cada um escolhe em Notificações > Preferências (coluna E-mail de «Ecrã sem ligação ou com falhas» e de «Campanha abaixo do contratado»); vem ligado por defeito e usa o e-mail indicado em «Onde quer receber».
- Os outros avisos e as mensagens (SMS) continuam sem envio.

## Instalar num servidor (Ubuntu 24.04)

Num servidor limpo, como root: `curl -fsSL https://raw.githubusercontent.com/tiagooliveira-enif/enif-ooh/versao-real-v62/scripts/instalar-servidor.sh -o instalar.sh && bash instalar.sh o.seu.dominio.pt`.
Instala Node 22, a aplicação (`/opt/enif-ooh`), os dados (`/var/lib/enif`), a configuração (`/etc/enif/enif-config.json`, só no servidor), arranque automático (systemd), HTTPS automático (Caddy) e firewall. Para atualizar sem mexer em conteúdos nem programação: `enif-atualizar` (guarda antes uma cópia da base de dados).

## Recuperar uma cópia de segurança
Ensaiado em `test/e2e/recuperacao.py` (cria dados, faz uma cópia, «perde» o servidor e restaura; tudo fica igual, incluindo as chaves dos players). Passos:
1. Pare o servidor.
2. Numa pasta de dados nova, copie a cópia que quer (`backups/enif-AAAAMMDD-HHMMSS-….db`) para `enif-data.db` e o conteúdo de `backups/media/` para `media/`.
3. Arranque o servidor com `DATA_DIR` a apontar para essa pasta. Os players e as sessões continuam a funcionar com as mesmas chaves.
- **Não vai dentro da cópia:** o `enif-config.json` (guarde-o à parte) e os PDF já enviados ao comercial (pasta `reports/`, que fica sempre no servidor).
- A cópia da base de dados é de um dia (feita de madrugada): o que mudou desde então perde-se.

## Limpeza de conteúdos sem uso
Um conteúdo que não está em nenhuma campanha ativa, agendada ou em pausa (e que não é spot da Enif) caduca **180 dias depois de a última campanha acabar**, ou **60 dias depois de carregado** se nunca foi usado. Os dois prazos são do administrador (barra por cima da biblioteca, `POST /api/clean`, guardados em `settings/clean`).
- 30 dias antes aparece uma sugestão no painel e a etiqueta «Sem uso» no ficheiro, com «Manter» (`POST /api/contents/keep`, dá mais 180 dias).
- Caducado, o conteúdo passa da coleção `contents` para `bin` (reciclagem, 30 dias, «Restaurar» em `POST /api/contents/restore`). Não entra nas playlists nem na lista de ecrãs. O ficheiro continua no disco.
- Passados os 30 dias, o ficheiro e a linha em `files` são apagados e fica só o nome (`gone: true`), para os relatórios e comprovativos das campanhas já terminadas continuarem a mostrar o nome.
- A limpeza corre uma vez por dia no `tick` (`cleanSweep`). Tudo fica no registo de auditoria. As datas de caducidade (`exp`) são calculadas no servidor.
- Uma campanha terminada que seja prolongada e use um conteúdo já reciclado fica sem esse conteúdo até ele ser restaurado.

## Ocupação por mês

Em Campanhas › Disponibilidade, por ecrã e para o mês atual (de hoje), o seguinte e o outro: percentagem das vagas do loop que já têm campanha e média de vagas livres por hora, só nas horas em que o ecrã está ligado, mais a média da rede. Calculado na aplicação com a mesma lógica da disponibilidade.

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

## Sessão que termina por inatividade

A sessão de cada utilizador termina se ninguém usar a página durante 15 minutos (um aviso aparece 1 minuto antes). Só contam ações de quem está a usar (clicar, escrever, rodar a roda do rato, tocar); a atualização automática da página não conta, e carregar ficheiros também não deixa a sessão expirar. Para mudar o tempo no servidor, acrescentar `IDLE_MIN=20` (minutos) às variáveis do serviço `enif`.

## Resumo semanal por e-mail

Às segundas-feiras às 8h (hora de Lisboa) os administradores recebem um resumo da semana: ecrãs (online, com atenção, offline), alertas abertos, campanhas (ativas, agendadas, a começar e a terminar nos próximos 7 dias), conteúdos a caducar, espaço livre no servidor, última cópia de segurança local e externa, e os eventos de spots do calendário. Cada administrador pode desligá-lo em «Notificações > Preferências» (linha «Resumo semanal da plataforma», coluna E-mail). O envio é feito pelo servidor, mesmo com a plataforma fechada, e só uma vez por segunda-feira.
