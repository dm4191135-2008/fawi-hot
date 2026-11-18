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
1. Prepara um site estático com `index.html` na raiz.
2. No painel FAWI HOST, escreve o nome do projeto.
3. Seleciona os ficheiros, uma pasta completa ou um ZIP.
4. Clica em **Publicar site**.
5. O endereço público será apresentado na lista de sites publicados.

São aceites ficheiros HTML, CSS, JS/MJS, JSON, imagens, fontes, PDF, áudio/vídeo e outros recursos estáticos comuns. Limite total de upload: 50 MB e 500 ficheiros por publicação. O envio de pastas preserva a estrutura de subpastas. ZIPs são extraídos no servidor e os caminhos são validados para impedir ZIP Slip. Não são aceites ficheiros de servidor como PHP, Node ou executáveis.

## Deploy no Render
1. Envia este projeto para um repositório Git.
2. No Render, cria um **Web Service** ligado ao repositório.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Adiciona um **Persistent Disk** ao serviço, por exemplo com mount path `/var/data`.
7. Em Environment, define `DATA_DIR=/var/data`.
8. Faz deploy.

O diretório `DATA_DIR` conterá `sites/` e `temp/`. Sem Persistent Disk, os sites publicados podem desaparecer num novo deploy/restart/instância. O disco persistente do Render é normalmente associado a uma única instância; dimensiona o serviço e a política de backups de acordo com o uso.

## PWA / instalação
A plataforma inclui `manifest.webmanifest`, ícones PNG, service worker e um menu flutuante inferior em ecrãs móveis. Depois de publicar com HTTPS, abre o endereço no Chrome e escolhe **Instalar app** ou **Adicionar ao ecrã principal**. A disponibilidade do prompt depende do navegador e dos critérios de instalação PWA. A aplicação instalada continua a precisar de ligação à internet para publicar e consultar projetos.

## Endpoints
- `GET /health` — verificação simples de disponibilidade
- `GET /api/sites` — lista publicações
- `POST /api/publish` — recebe `projectName` e ficheiros multipart no campo `files`
- `DELETE /api/sites/:id` — remove um site
- `GET /s/:id/` — serve o site publicado

## Segurança e limitações desta V1
- Upload limitado a 50 MB e 500 ficheiros.
- Lista de extensões estáticas permitidas; caminhos normalizados e validados.
- Extração ZIP com validação de caminhos, limite de quantidade e tamanho descomprimido.
- Identificadores únicos para evitar colisões.
- Os sites são servidos sob `/s/:id/` com uma política CSP `sandbox` para reduzir o acesso do conteúdo publicado à origem do painel.
- Não existe autenticação, quotas por utilizador, pagamentos, domínio personalizado, HTTPS próprio por projeto, CDN, antivírus, nem proteção anti-abuso avançada. O painel é, nesta versão, uma instância partilhada: qualquer pessoa com acesso ao serviço pode ver e apagar publicações. **Não uses esta V1 para dados privados ou produção comercial sem acrescentar autenticação, autorização, quotas e monitorização.**
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
