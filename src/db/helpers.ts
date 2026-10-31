import { createHash, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { AuthSession, AuthUser, MerchantMembership, MerchantRole } from './models.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function cookieValue(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join(';') : header || '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); } catch { return undefined; }
    }
  }
  return undefined;
}

export async function authenticateRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}) {
  const token = cookieValue(req.headers.cookie, 'mga_session');
  if (!token || token.length > 200) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  const session = await AuthSession.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).lean();
  if (!session) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  const user = await AuthUser.findOne({ _id: session.userId, disabled: false }).select('_id email').lean();
  if (!user) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  return { user, session };
}

export async function getRequestMerchantId(req: {
  headers: Record<string, string | string[] | undefined>;
  query?: unknown;
}, roles?: MerchantRole[]): Promise<Types.ObjectId> {
  const { user } = await authenticateRequest(req);
  const header = req.headers['x-merchant-id'];
  const queryId = (req.query as Record<string, unknown> | undefined)?.merchantId;
  const merchantId = typeof header === 'string' && header ? header : typeof queryId === 'string' ? queryId : '';
  if (!/^[a-f\d]{24}$/i.test(merchantId)) {
    throw Object.assign(new Error('Merchant access unavailable'), { statusCode: 403 });
  }
  const membership = await MerchantMembership.findOne({ userId: user._id, merchantId }).select('role').lean();
  if (!membership || (roles && !roles.includes(membership.role))) {
    throw Object.assign(new Error('Merchant access unavailable'), { statusCode: 403 });
  }
  return new Types.ObjectId(merchantId);
}

export function verifyCsrf(req: { headers: Record<string, string | string[] | undefined> }, csrfHash: string) {
  const cookie = cookieValue(req.headers.cookie, 'mga_csrf');
  const header = req.headers['x-csrf-token'];
  if (typeof header !== 'string' || !cookie || cookie !== header) {
    throw Object.assign(new Error('Invalid request token'), { statusCode: 403 });
  }
  const actual = Buffer.from(hashToken(header));
  const expected = Buffer.from(csrfHash);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw Object.assign(new Error('Invalid request token'), { statusCode: 403 });
  }
}

export function cookieToken(req: { headers: Record<string, string | string[] | undefined> }, name: string) {
  return cookieValue(req.headers.cookie, name);
}
