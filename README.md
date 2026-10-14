# Enif OOH – servidor e player

Plataforma de gestão de ecrãs OOH. Esta pasta tem a parte real: o **servidor** (API + base de dados + ficheiros) e o **player** que corre em cada ecrã. O protótipo visual vive à parte e liga-se a esta API mais tarde.

- Sem dependências externas. Só precisa de **Node.js 22.13 ou superior**.
- Base de dados: SQLite (um ficheiro em `data/enif.db`).

## Testar no teu computador

```
node server.js
```

Abre http://localhost:8080/admin/ (chave de teste: `admin`).

1. **Ecrãs → Novo ecrã**. Copia o «Endereço do player».
2. **Conteúdos**: envia uma imagem ou um vídeo.
3. **Campanhas → Nova campanha**: escolhe o local do ecrã, datas, horas e os conteúdos.
4. Abre o endereço do player num separador (ou no Edge em ecrã inteiro). Carrega em **D** para ver o estado.
5. Na administração, o ecrã passa a **Online** e as passagens aparecem em «Passagens de hoje».

Variáveis (opcionais): `PORT` (8080), `ADMIN_TOKEN` (chave de administração), `DATA_DIR`, `TZ_NAME` (Europe/Lisbon).
**Antes de pôr na internet, define sempre `ADMIN_TOKEN`.**

## Testes

```
npm test                 # lógica do loop (portada do protótipo)
python3 test/e2e.py      # servidor + player real num browser, incluindo queda de internet (precisa de playwright e ffmpeg)
```

## Instalar o player num mini PC Windows

No PowerShell como administrador, na pasta `scripts`:

```
.\instalar-player-windows.ps1 -Servidor "http://ENDERECO:8080" -Codigo "ECR-001" -Chave "CHAVE"
```

O Edge abre em ecrã inteiro com o Windows e reinicia sozinho se fechar. O PC deixa de suspender.

## Como o player funciona

- Pede ao servidor o loop de hoje e de amanhã, hora a hora, e descarrega os ficheiros para a cache do browser.
- Sem internet continua a passar o que tem. As passagens ficam numa fila e seguem quando a internet volta (sem duplicados).
- A cada 30 s envia um sinal de vida. Sem sinal há mais de 2,5 minutos, o ecrã fica **offline** e aparece em Alertas.
- A página do player também fica guardada, por isso o PC arranca mesmo sem internet.
- A cache e o arranque offline precisam de **HTTPS** ou de `localhost`. Com o servidor real, usar sempre HTTPS.

## Regras do loop (iguais ao protótipo)

Campanhas em horário, por prioridade (ou ordem do ecrã), até ao limite do ecrã. «Vezes por minuto» repete a campanha na volta, bem espaçada. Os vídeos de uma campanha alternam a cada passagem. Cada vídeo pode ter dias, horas e vezes por minuto próprios. Lógica em `lib/schedule.js`.

## Ainda por fazer

- Ligar a interface do protótipo a esta API (login, utilizadores, permissões, relatórios completos).
- Notificações por e-mail e mensagem (hoje só há o alerta de ecrã offline na API).
- Conversão automática de vídeos/imagens e conteúdos HTML.
- Servidor com HTTPS e cópias de segurança.
