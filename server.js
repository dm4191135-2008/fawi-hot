'use strict';
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const yauzl = require('yauzl');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);
const DB_FILE = path.join(DATA_DIR, 'fawi-host-db.json');
const SITES_DIR = path.join(DATA_DIR, 'sites');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_FILES = 500;
const ALLOWED = new Set(['.html','.htm','.css','.js','.mjs','.json','.txt','.xml','.webmanifest','.svg','.png','.jpg','.jpeg','.gif','.webp','.avif','.ico','.woff','.woff2','.ttf','.otf','.mp4','.webm','.mp3','.pdf']);
for (const dir of [SITES_DIR, TEMP_DIR]) fs.mkdirSync(dir, { recursive: true });
let db = { secret: crypto.randomBytes(48).toString('hex'), users: [], oauthStates: {} };
try { const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); db = { ...db, ...saved, users: saved.users || [], oauthStates: saved.oauthStates || {} }; } catch {}
if (!db.secret) db.secret = crypto.randomBytes(48).toString('hex');
function saveDb() { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(tmp, DB_FILE); }
saveDb();
function sign(value) { return crypto.createHmac('sha256', db.secret).update(value).digest('base64url'); }
function tokenFor(user) { const payload = Buffer.from(JSON.stringify({ uid: user.id, exp: Date.now() + 30 * 86400000 })).toString('base64url'); return payload + '.' + sign(payload); }
function readToken(req) { const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('fawi_session=')); if (!cookie) return null; const token = decodeURIComponent(cookie.slice('fawi_session='.length)); const [payload, signature] = token.split('.'); if (!payload || !signature) return null; const expected = sign(payload); if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); if (data.exp < Date.now()) return null; return db.users.find(u => u.id === data.uid) || null; } catch { return null; } }
function setSession(req, res, user) { res.cookie('fawi_session', tokenFor(user), { httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 30 * 86400000 }); }
function requireAuth(req, res, next) { req.user = readToken(req); if (!req.user) return res.status(401).json({ error: 'Inicia sessão ou cria uma conta para continuar.' }); next(); }
function publicUser(user) { return { id: user.id, email: user.email, name: user.name || user.email.split('@')[0], provider: user.provider || 'email', picture: user.picture || null }; }
function makePassword(password) { const salt = crypto.randomBytes(16).toString('hex'); return new Promise((resolve, reject) => { crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, (err, key) => { if (err) reject(err); else resolve(salt + key.toString('hex')); }); }); }
function checkPassword(password, stored) { const salt = stored.slice(0, 32), hash = stored.slice(32); return new Promise((resolve, reject) => { crypto.scrypt(password, Buffer.from(salt, 'hex'), 64, (err, key) => { if (err) return reject(err); resolve(crypto.timingSafeEqual(key, Buffer.from(hash, 'hex'))); }); }); }

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use((req, res, next) => {
  if (/^\/(sites|temp)(\/|$)/.test(req.path) || /^\/(server\.js|package\.json|README\.md|\.gitignore|fawi-host-db\.json|fawi-host-db\.json\.tmp)$/.test(req.path)) return res.sendStatus(404);
  next();
});
app.use(express.static(ROOT, { index: 'index.html', dotfiles: 'deny' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  preservePath: true,
  storage, limits: { fileSize: MAX_UPLOAD, files: MAX_FILES, fields: 2, fieldSize: 200 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(ext) && ext !== '.zip') return cb(new Error(`Tipo de ficheiro não permitido: ${ext || 'sem extensão'}`));
    cb(null, true);
  }
});

function cleanName(value) {
  const s = String(value || 'meu-projeto').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'meu-projeto';
}
function safeJoin(root, rel) {
  const normalized = rel.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) ||
      normalized.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error('Caminho inválido no pacote.');
  const out = path.resolve(root, ...normalized.split('/'));
  if (!out.startsWith(path.resolve(root) + path.sep)) throw new Error('Caminho fora da pasta permitida.');
  return out;
}
function allowedFile(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error(`Extensão não permitida: ${ext || 'sem extensão'}`);
}
async function copyUploaded(file, destRoot, rel) {
  allowedFile(rel);
  const dest = safeJoin(destRoot, rel);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(file.path, dest, fs.constants.COPYFILE_EXCL);
}
function extractZip(zipPath, destRoot) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      let count = 0, total = 0, finished = false;
      const fail = e => { if (!finished) { finished = true; zip.close(); reject(e); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!finished) { finished = true; resolve({ count, total }); } });
      zip.on('entry', entry => {
        try {
          if (++count > MAX_FILES) throw new Error('O ZIP contém demasiados ficheiros.');
          const name = entry.fileName.replace(/\\/g, '/');
          if (name.endsWith('/')) { safeJoin(destRoot, name.slice(0, -1) || 'folder'); zip.readEntry(); return; }
          allowedFile(name);
          const dest = safeJoin(destRoot, name);
          total += entry.uncompressedSize || 0;
          if (total > MAX_UPLOAD) throw new Error('O conteúdo extraído ultrapassa 100 MB.');
          fs.promises.mkdir(path.dirname(dest), { recursive: true }).then(() => {
            zip.openReadStream(entry, (streamErr, stream) => {
              if (streamErr) return fail(streamErr);
              const out = fs.createWriteStream(dest, { flags: 'wx' });
              pipeline(stream, out).then(() => zip.readEntry()).catch(fail);
            });
          }).catch(fail);
        } catch (e) { fail(e); }
      });
      zip.readEntry();
    });
  });
}
async function removeFiles(files) {
  await Promise.all((files || []).map(f => fs.promises.rm(f.path, { force: true }).catch(() => {})));
}
async function findUniqueId(slug) {
  const base = cleanName(slug);
  for (let suffix = 1; suffix < 10000; suffix++) {
    const id = suffix === 1 ? base : `${base}-${suffix}`;
    try { await fs.promises.access(path.join(SITES_DIR, id)); } catch { return id; }
  }
  return `${base}-${crypto.randomUUID().slice(0,8)}`;
}
function metadata(id) {
  try { return JSON.parse(fs.readFileSync(path.join(SITES_DIR, id, 'site.json'), 'utf8')); } catch { return null; }
}
function claimLegacySites(ownerId) {
  if (db.users.length !== 0) return;
  for (const entry of fs.readdirSync(SITES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; const info = metadata(entry.name);
    if (info && !info.ownerId) { info.ownerId = ownerId; fs.writeFileSync(path.join(SITES_DIR, entry.name, 'site.json'), JSON.stringify(info, null, 2)); }
  }
}


app.get('/api/auth/me', (req, res) => { const user = readToken(req); res.json({ user: user ? publicUser(user) : null }); });
app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(); const password = String(req.body.password || ''); const name = String(req.body.name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Indica um email válido.' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres.' });
  if (db.users.some(u => u.email === email)) return res.status(409).json({ error: 'Este email já tem uma conta. Inicia sessão.' });
  const user = { id: crypto.randomUUID(), email, name: name || email.split('@')[0], provider: 'email', passwordHash: await makePassword(password), createdAt: new Date().toISOString() };
  claimLegacySites(user.id); db.users.push(user); saveDb(); setSession(req, res, user); res.status(201).json({ user: publicUser(user) });
});
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || ''); const user = db.users.find(u => u.email === email && u.passwordHash);
  if (!user || !(await checkPassword(password, user.passwordHash))) return res.status(401).json({ error: 'Email ou senha incorretos.' });
  setSession(req, res, user); res.json({ user: publicUser(user) });
});
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('fawi_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' }); res.json({ success: true }); });
app.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return res.status(503).send('Login Google ainda não configurado. Define GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no servidor.');
  const state = crypto.randomBytes(24).toString('hex'); db.oauthStates[state] = Date.now() + 10 * 60 * 1000; saveDb();
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`; const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state }); res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});
app.get('/api/auth/google/callback', async (req, res) => {
  const state = String(req.query.state || ''); if (!db.oauthStates[state] || db.oauthStates[state] < Date.now()) { delete db.oauthStates[state]; saveDb(); return res.status(400).send('Pedido de autenticação inválido ou expirado.'); } delete db.oauthStates[state]; saveDb();
  try { const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`; const tokenResp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: String(req.query.code || ''), client_id: process.env.GOOGLE_CLIENT_ID || '', client_secret: process.env.GOOGLE_CLIENT_SECRET || '', redirect_uri: redirectUri, grant_type: 'authorization_code' }) }); const tokens = await tokenResp.json(); if (!tokenResp.ok || !tokens.access_token) throw new Error('Não foi possível validar o Google.'); const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } }); const profile = await profileResp.json(); if (!profile.email || profile.verified_email !== true) throw new Error('O Google não confirmou o email.'); let user = db.users.find(u => u.googleId === profile.id || u.email === String(profile.email).toLowerCase()); if (!user) { user = { id: crypto.randomUUID(), email: String(profile.email).toLowerCase(), name: profile.name || profile.email.split('@')[0], googleId: profile.id, picture: profile.picture || null, provider: 'google', createdAt: new Date().toISOString() }; claimLegacySites(user.id); db.users.push(user); } else { user.googleId = profile.id; user.provider = 'google'; user.name = profile.name || user.name; user.picture = profile.picture || user.picture || null; } saveDb(); setSession(req, res, user); res.redirect('/publish.html?auth=success'); } catch (e) { res.status(400).send(e.message || 'Falha no login Google.'); }
});

// FAWI Smart Security: heuristic static-content screening (not a malware guarantee).
const SCAN_TEXT_EXTS = new Set(['.html','.htm','.js','.mjs','.json','.svg','.xml','.txt','.css']);
async function scanSite(root) {
  const findings = []; let scanned = 0, bytes = 0;
  async function walk(dir) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'site.json') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!SCAN_TEXT_EXTS.has(ext)) continue;
      const stat = await fs.promises.stat(full);
      if (!stat.isFile() || stat.size > 1024 * 1024 || bytes + stat.size > 8 * 1024 * 1024) continue;
      const text = await fs.promises.readFile(full, 'utf8'); scanned++; bytes += stat.size;
      const content = text.toLowerCase();
      const hasPassword = /type\s*=\s*["']password["']|autocomplete\s*=\s*["']current-password["']/.test(content);
      const externalForm = /<form[^>]{0,1000}action\s*=\s*["']https?:\/\//i.test(text);
      const branded = /google|microsoft|apple|paypal|facebook|instagram|bank|banco|outlook|gmail/.test(content);
      const loginWords = /sign[ -]?in|log[ -]?in|login|entrar|iniciar sess[aã]o|password|senha|verify your account|verificar conta/.test(content);
      if (hasPassword && externalForm && branded && loginWords) findings.push({ level: 'block', code: 'credential-brand-external', message: `Formulário de senha ligado a uma marca conhecida e enviado para endereço externo (${entry.name}).` });
      if (hasPassword && externalForm) findings.push({ level: 'review', code: 'external-password-form', message: `Formulário de senha envia dados para endereço externo (${entry.name}).` });
      if (/eval\s*\(\s*(atob|decodeURIComponent)/i.test(text) || (/eval\s*\(/i.test(text) && /atob\s*\(/i.test(text))) findings.push({ level: 'block', code: 'obfuscated-script', message: `Script com combinação de execução e descodificação de código (${entry.name}).` });
      if (/<iframe[^>]+(?:display\s*:\s*none|width\s*=\s*["']0|height\s*=\s*["']0)[^>]*src\s*=\s*["']https?:/i.test(text)) findings.push({ level: 'review', code: 'hidden-external-frame', message: `Iframe externo oculto detetado (${entry.name}).` });
      if (hasPassword && /(addEventListener\s*\(\s*["']key(?:down|up|press)["']|onkey(?:down|up|press)\s*=)/i.test(text) && /(fetch\s*\(|xmlhttprequest|navigator\.sendbeacon)/i.test(text)) findings.push({ level: 'block', code: 'credential-capture-pattern', message: `Código combina campo de senha, captura de teclas e envio de dados (${entry.name}).` });
      if (/(window\.location|location\.href)\s*=\s*["']https?:/i.test(text) && hasPassword) findings.push({ level: 'review', code: 'credential-redirect', message: `Redirecionamento externo associado a campo de senha (${entry.name}).` });
    }
  }
  await walk(root);
  const unique = [...new Map(findings.map(f => [f.code + f.message, f])).values()];
  const status = unique.some(f => f.level === 'block') ? 'blocked' : unique.length ? 'review' : 'safe';
  return { status, scannedFiles: scanned, checkedAt: new Date().toISOString(), findings: unique.slice(0, 20), note: 'Análise automática por indicadores; não garante que o site seja seguro nem substitui revisão humana.' };
}

app.post('/api/publish', requireAuth, upload.array('files', MAX_FILES), async (req, res) => {
  const files = req.files || [];
  let workDir;
  try {
    if (!files.length) return res.status(400).json({ error: 'Seleciona os ficheiros do site ou um ZIP.' });
    const totalUploadSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalUploadSize > MAX_UPLOAD) throw new Error('O envio ultrapassa o limite total de 100 MB.');
    const projectName = cleanName(req.body.projectName);
    workDir = await fs.promises.mkdtemp(path.join(TEMP_DIR, 'publish-'));
    const zipFiles = files.filter(f => path.extname(f.originalname).toLowerCase() === '.zip');
    if (zipFiles.length) {
      if (files.length !== 1) throw new Error('Envia um ZIP de cada vez, sem misturar com outros ficheiros.');
      await extractZip(zipFiles[0].path, workDir);
    } else {
      for (const file of files) {
        const rel = file.originalname.replace(/\\/g, '/').replace(/^\/+/, '');
        await copyUploaded(file, workDir, rel);
      }
    }
    let indexPath = path.join(workDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      const dirs = await fs.promises.readdir(workDir, { withFileTypes: true });
      const nested = dirs.filter(d => d.isDirectory());
      if (nested.length === 1 && fs.existsSync(path.join(workDir, nested[0].name, 'index.html'))) {
        const nestedDir = path.join(workDir, nested[0].name);
        const entries = await fs.promises.readdir(nestedDir);
        for (const entry of entries) await fs.promises.rename(path.join(nestedDir, entry), path.join(workDir, entry));
        await fs.promises.rmdir(nestedDir);
        indexPath = path.join(workDir, 'index.html');
      }
    }
    if (!fs.existsSync(indexPath)) {
      const rootHtml = (await fs.promises.readdir(workDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && /\.html?$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))[0];
      if (rootHtml) {
        await fs.promises.rename(path.join(workDir, rootHtml.name), indexPath);
      }
    }
    if (!fs.existsSync(indexPath)) throw new Error('Não foi encontrado um ficheiro HTML na raiz do site.');
    const security = await scanSite(workDir);
    if (security.status === 'blocked') return res.status(422).json({ error: 'A análise de segurança bloqueou a publicação. Corrige os indicadores encontrados e tenta novamente.', security });
    const id = await findUniqueId(projectName);
    const finalDir = path.join(SITES_DIR, id);
    await fs.promises.rename(workDir, finalDir);
    workDir = null;
    const info = { id, name: projectName, ownerId: req.user.id, createdAt: new Date().toISOString(), files: countFiles(finalDir), security };
    await fs.promises.writeFile(path.join(finalDir, 'site.json'), JSON.stringify(info, null, 2));
    res.status(201).json({ success: true, site: info, security, url: `/s/${id}/` });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Não foi possível publicar o site.' });
  } finally {
    await removeFiles(files);
    if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});
function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'site.json') continue;
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
}
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/sites', requireAuth, (req, res) => {
  const sites = [];
  for (const entry of fs.readdirSync(SITES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) { const data = metadata(entry.name); if (data && data.ownerId === req.user.id) sites.push(data); }
  }
  sites.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ sites });
});
app.post('/api/sites/:id/security-check', requireAuth, async (req, res) => {
  const id = req.params.id; if (!/^[a-z0-9-]{1,64}$/.test(id)) return res.status(400).json({ error: 'Identificador inválido.' });
  const dir = path.resolve(SITES_DIR, id); const info = metadata(id);
  if (!info || info.ownerId !== req.user.id || !dir.startsWith(path.resolve(SITES_DIR) + path.sep)) return res.status(404).json({ error: 'Projeto não encontrado.' });
  try { info.security = await scanSite(dir); await fs.promises.writeFile(path.join(dir, 'site.json'), JSON.stringify(info, null, 2)); res.json({ success: true, security: info.security }); } catch { res.status(500).json({ error: 'Não foi possível analisar o site.' }); }
});
app.delete('/api/sites/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return res.status(400).json({ error: 'Identificador inválido.' });
  const target = path.resolve(SITES_DIR, id);
  if (!target.startsWith(path.resolve(SITES_DIR) + path.sep)) return res.status(400).json({ error: 'Caminho inválido.' });
  try { const info = metadata(id); if (!info || info.ownerId !== req.user.id) return res.status(404).json({ error: 'Projeto não encontrado.' }); await fs.promises.rm(target, { recursive: true, force: true }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Não foi possível apagar o projeto.' }); }
});
app.get('/s/:id/*', (req, res, next) => {
  const id = req.params.id;
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return res.sendStatus(404);
  const root = path.resolve(SITES_DIR, id);
  if (!root.startsWith(path.resolve(SITES_DIR) + path.sep) || !fs.existsSync(path.join(root, 'index.html'))) return res.sendStatus(404);
  const siteInfo = metadata(id); if (siteInfo && siteInfo.security && siteInfo.security.status === 'blocked') return res.status(451).send('Este site foi temporariamente bloqueado pela verificação de segurança FAWI HOST.');
  // Uploaded pages run in a browser sandbox to isolate them from the FAWI HOST dashboard/API origin.
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: https: http:; img-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *");
  const rel = req.params[0] || 'index.html';
  if (rel.split('/').some(part => part.toLowerCase() === 'site.json')) return res.sendStatus(404);
  let target;
  try { target = safeJoin(root, rel || 'index.html'); } catch { return res.sendStatus(404); }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.sendStatus(404);
  res.sendFile(target, { dotfiles: 'deny' }, err => { if (err && !res.headersSent) next(err); });
});
app.get('/s/:id', (req, res) => res.redirect(301, `/s/${req.params.id}/`));
app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError || /^Tipo de ficheiro não permitido:/.test(err.message || '') || /LIMIT_/.test(err.code || '') ? 400 : 500;
  res.status(status).json({ error: err.message || 'Ocorreu um erro inesperado.' });
});
app.listen(PORT, () => console.log(`FAWI HOST a funcionar na porta ${PORT}; DATA_DIR=${DATA_DIR}`));
