import { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AuthSession, AuthUser, Merchant, MerchantMembership, RegistrationInvite } from '../db/models.js';
import { authenticateRequest, cookieToken, getRequestMerchantId, hashToken } from '../db/helpers.js';

const scryptAsync = promisify(scrypt);
const sessionMs = 8 * 60 * 60 * 1000;
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).strict();
const registerSchema = z.object({ invite: z.string().min(32).max(200), password: z.string().min(12).max(200) }).strict();
const inviteSchema = z.object({ email: z.string().email().max(254), role: z.enum(['admin', 'staff']) }).strict();

function setCookie(reply: FastifyReply, name: string, value: string, options: { httpOnly?: boolean; maxAge?: number } = {}) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const httpOnly = options.httpOnly ? '; HttpOnly' : '';
  const maxAge = options.maxAge === undefined ? '' : `; Max-Age=${options.maxAge}`;
  reply.raw.appendHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Strict${httpOnly}${secure}${maxAge}`);
}

async function issueSession(userId: string, reply: FastifyReply) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionMs);
  await AuthSession.create({ userId, tokenHash: hashToken(token), csrfHash: hashToken(csrf), expiresAt });
  setCookie(reply, 'mga_session', token, { httpOnly: true, maxAge: sessionMs / 1000 });
  setCookie(reply, 'mga_csrf', csrf, { maxAge: sessionMs / 1000 });
  return { expiresAt, csrfToken: csrf };
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid email or password' });
    const email = parsed.data.email.toLowerCase().trim();
    const user = await AuthUser.findOne({ email, disabled: false }).select('+passwordHash email').lean();
    if (!user) return reply.status(401).send({ error: 'Invalid email or password' });
    const [salt, stored] = user.passwordHash.split(':');
    const derived = await scryptAsync(parsed.data.password, salt, 64) as Buffer;
    const expected = Buffer.from(stored, 'hex');
    if (expected.length !== derived.length || !timingSafeEqual(expected, derived)) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }
    const { expiresAt, csrfToken } = await issueSession(user._id.toString(), reply);
    return { user: { id: user._id.toString(), email: user.email }, expiresAt, csrfToken };
  });

  app.post<{ Body: unknown }>('/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid registration details' });
    const invite = await RegistrationInvite.findOne({ tokenHash: hashToken(parsed.data.invite), usedAt: null, expiresAt: { $gt: new Date() } });
    if (!invite) return reply.status(400).send({ error: 'Invitation is invalid or expired' });
    if (await AuthUser.exists({ email: invite.email })) return reply.status(409).send({ error: 'This invitation belongs to an existing account. Sign in to accept it.' });
    const salt = randomBytes(16).toString('hex');
    const derived = await scryptAsync(parsed.data.password, salt, 64) as Buffer;
    const user = await AuthUser.create({ email: invite.email, passwordHash: `${salt}:${derived.toString('hex')}` });
    await MerchantMembership.create({ userId: user._id, merchantId: invite.merchantId, role: invite.role });
    invite.usedAt = new Date();
    await invite.save();
    const { expiresAt, csrfToken } = await issueSession(user._id.toString(), reply);
    return reply.status(201).send({ user: { id: user._id.toString(), email: user.email }, expiresAt, csrfToken });
  });

  app.post<{ Body: unknown }>('/accept-invitation', async (req, reply) => {
    const parsed = z.object({ invite: z.string().min(32).max(200) }).strict().safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid invitation' });
    const { user } = await authenticateRequest(req);
    const invite = await RegistrationInvite.findOne({ tokenHash: hashToken(parsed.data.invite), usedAt: null, expiresAt: { $gt: new Date() } });
    if (!invite || invite.email !== user.email) return reply.status(404).send({ error: 'Invitation unavailable for this account' });
    if (await MerchantMembership.exists({ userId: user._id, merchantId: invite.merchantId })) {
      return reply.status(409).send({ error: 'This account already belongs to that merchant' });
    }
    await MerchantMembership.create({ userId: user._id, merchantId: invite.merchantId, role: invite.role });
    invite.usedAt = new Date();
    await invite.save();
    return { ok: true };
  });

  app.get('/session', async (req, reply) => {
    const { user, session } = await authenticateRequest(req);
    const csrfToken = randomBytes(32).toString('base64url');
    await AuthSession.updateOne({ _id: session._id }, { csrfHash: hashToken(csrfToken) });
    setCookie(reply, 'mga_csrf', csrfToken, { maxAge: Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)) });
    return { user: { id: user._id.toString(), email: user.email }, expiresAt: session.expiresAt, csrfToken };
  });

  app.post('/logout', async (req, reply) => {
    const token = cookieToken(req, 'mga_session');
    if (token) await AuthSession.deleteOne({ tokenHash: hashToken(token) });
    setCookie(reply, 'mga_session', '', { httpOnly: true, maxAge: 0 });
    setCookie(reply, 'mga_csrf', '', { maxAge: 0 });
    return { ok: true };
  });

  app.post<{ Body: unknown }>('/invitations', async (req, reply) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid invitation details' });
    const merchantId = await getRequestMerchantId(req, ['owner', 'admin']);
    const merchant = await Merchant.exists({ _id: merchantId });
    if (!merchant) return reply.status(404).send({ error: 'Merchant unavailable' });
    const email = parsed.data.email.toLowerCase().trim();
    const existingUser = await AuthUser.findOne({ email }).select('_id').lean();
    if (existingUser && await MerchantMembership.exists({ userId: existingUser._id, merchantId })) {
      return reply.status(409).send({ error: 'User already belongs to this merchant' });
    }
    const token = randomBytes(32).toString('base64url');
    await RegistrationInvite.create({ email, merchantId, role: parsed.data.role, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) });
    return reply.status(201).send({ invitation: token, registrationPath: `/register#invite=${encodeURIComponent(token)}`, expiresInHours: 48 });
  });
}
