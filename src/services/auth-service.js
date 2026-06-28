import crypto from 'node:crypto';

const cookieName = 'apple_mcp_token';

export class AuthService {
  constructor(repository) {
    this.repository = repository;
  }

  get cookieName() {
    return cookieName;
  }

  generateToken() {
    return `${crypto.randomUUID()}.${crypto.randomBytes(48).toString('base64url')}`;
  }

  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async issueToken() {
    const token = this.generateToken();
    await this.repository.saveState({
      started: false,
      tokenHash: this.hashToken(token),
      tokenIssuedAt: new Date()
    });
    return token;
  }

  async start(token) {
    if (!(await this.validateToken(token))) return false;
    await this.repository.saveState({ started: true, startedAt: new Date() });
    return true;
  }

  extractToken(req) {
    const header = req.get('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    return req.get('x-auth-token') || req.cookies?.[cookieName] || req.body?.token || req.query?.token;
  }

  async validateToken(token) {
    if (!token) return false;
    const state = await this.repository.getState();
    if (!state.tokenHash) return false;
    const actual = Buffer.from(this.hashToken(token), 'hex');
    const expected = Buffer.from(state.tokenHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async requireToken(req, res, next) {
    if (await this.validateToken(this.extractToken(req))) return next();
    res.status(401).json({ error: 'token required' });
  }

  async requireTokenWhenStarted(req, res, next) {
    const state = await this.repository.getState();
    if (!state.started || (await this.validateToken(this.extractToken(req)))) return next();
    res.status(401).json({ error: 'token required' });
  }

  setCookie(res, token) {
    res.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: false
    });
  }
}
