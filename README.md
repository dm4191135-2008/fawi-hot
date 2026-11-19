# FAWI HOST

**Your Website. Your Space. Your World.**  
Primeira versão funcional para alojamento e publicação de sites estáticos HTML, CSS, JavaScript e recursos.

## Requisitos
- Node.js 20 ou superior
- npm

## Instalação local
```bash
npm install
npm start
```
Abre `http://localhost:3000`.

## Publicar um site
1. Prepara um site estático com um ficheiro HTML na raiz (se não se chamar `index.html`, a FAWI HOST usa-o como página inicial).
2. No painel FAWI HOST, escreve o nome do projeto.
3. Seleciona os ficheiros, uma pasta completa ou um ZIP.
4. Clica em **Publicar site**.
5. O endereço público será apresentado na lista de sites publicados.

São aceites ficheiros HTML, CSS, JS/MJS, JSON, imagens, fontes, PDF, áudio/vídeo e outros recursos estáticos comuns. Limite total de upload: 100 MB e 500 ficheiros por publicação. Os ZIPs preservam a estrutura de subpastas. ZIPs são extraídos no servidor e os caminhos são validados para impedir ZIP Slip. Não são aceites ficheiros de servidor como PHP, Node ou executáveis.

## Deploy no Render
1. Envia este projeto para um repositório Git.
2. No Render, cria um **Web Service** ligado ao repositório.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Adiciona um **Persistent Disk** ao serviço, com mount path `/var/data`.
7. Em Environment, define `DATA_DIR=/var/data`.
8. Para ativar o Google login, cria credenciais OAuth 2.0 do tipo Web no Google Cloud e define `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. Regista também o URI de redirecionamento `https://TEU-DOMINIO/api/auth/google/callback` nas credenciais.
9. Faz deploy.

O diretório `DATA_DIR` conterá `sites/`, `temp/` e o ficheiro `fawi-host-db.json` (contas e dados de associação dos projetos). Sem Persistent Disk, os sites e contas podem desaparecer num novo deploy/restart/instância. O disco persistente do Render é normalmente associado a uma única instância; dimensiona o serviço e a política de backups de acordo com o uso.

## PWA / instalação
A plataforma inclui `manifest.webmanifest`, ícones PNG, service worker e um menu flutuante inferior em ecrãs móveis. Depois de publicar com HTTPS, abre o endereço no Chrome e escolhe **Instalar app** ou **Adicionar ao ecrã principal**. A disponibilidade do prompt depende do navegador e dos critérios de instalação PWA. A aplicação instalada continua a precisar de ligação à internet para publicar e consultar projetos.

## Endpoints
- `GET /health` — verificação simples de disponibilidade
- `GET /api/auth/me` — verifica a sessão atual
- `POST /api/auth/register` — cria conta com email e senha
- `POST /api/auth/login` — inicia sessão
- `POST /api/auth/logout` — encerra sessão
- `GET /api/auth/google` e callback — autenticação Google OAuth (requer credenciais)
- `GET /api/sites` — lista apenas os projetos da conta autenticada
- `POST /api/publish` — publica ficheiros, associando o projeto à conta autenticada
- `DELETE /api/sites/:id` — remove apenas um projeto pertencente à conta autenticada
- `GET /s/:id/` — serve o site publicado

## Contas e projetos
- A FAWI HOST inclui registo e login com email/senha (senhas protegidas por scrypt) e sessão em cookie HttpOnly.
- Cada publicação fica associada ao utilizador; a lista e a remoção verificam a propriedade.
- A base de dados JSON e os sites devem estar no Persistent Disk do Render via `DATA_DIR`.
- Google login só funciona após configuração de `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no Render.

## Segurança e limitações desta V1
- Upload limitado a 100 MB e 500 ficheiros.
- Lista de extensões estáticas permitidas; caminhos normalizados e validados.
- Extração ZIP com validação de caminhos, limite de quantidade e tamanho descomprimido.
- Identificadores únicos para evitar colisões.
- Os sites são servidos sob `/s/:id/` com uma política CSP `sandbox` para reduzir o acesso do conteúdo publicado à origem do painel.
- Não existe verificação de email, recuperação de senha, quotas por utilizador, pagamentos, domínio personalizado, CDN, antivírus ou proteção anti-abuso avançada. Configura Google OAuth e backups do Persistent Disk antes de uso público amplo.
- Para sites que dependem de cookies, service workers próprios, APIs específicas de origem ou integrações que exigem mesma origem, a política sandbox pode limitar funcionalidades. A arquitetura de produção recomendada é servir cada site num domínio/subdomínio isolado.

## Estrutura
```text
FAWI_HOST/
├── server.js
├── package.json
├── README.md
├── .gitignore
├── index.html
├── style.css
├── app.js
├── logo.svg
├── favicon.svg
├── manifest.webmanifest
├── sw.js
├── icon-192.png
├── icon-512.png
├── sites/
└── temp/
```

## Navegação da plataforma
A interface está dividida em páginas independentes:
- `index.html` — página inicial
- `publish.html` — publicar um novo site
- `sites.html` — gerir os meus sites
- `about.html` — saber mais / como funciona

Para pré-visualizar o aspeto, abre `index.html` diretamente no computador. Para testar uploads, gestão de sites e publicação, inicia o servidor com `npm install` e `npm start` e abre `http://localhost:3000`.

## FAWI Smart Security

Uploads are screened before publication using static, heuristic indicators in HTML, JavaScript, CSS, JSON, SVG, XML and TXT files. High-confidence patterns block publishing; suspicious indicators produce a review warning. Published projects can be re-scanned from the projects list. A project marked blocked is not served publicly.

This is a heuristic check, **not an AI malware detector and not a guarantee of safety**. It can miss harmful content and may flag legitimate forms or scripts. It does not currently query Google Safe Browsing/Web Risk or other external reputation services. The owner should inspect review findings and request a Google Search Console review only after remediation.
