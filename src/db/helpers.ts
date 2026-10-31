import { Merchant } from './models.js';
import { Types } from 'mongoose';

const merchantCache = new Map<string, Types.ObjectId>();

export async function getMerchantId(merchantIdParam?: string): Promise<Types.ObjectId> {
  if (merchantIdParam) {
    if (Types.ObjectId.isValid(merchantIdParam)) {
      return new Types.ObjectId(merchantIdParam);
    }
  }
  if (merchantCache.has('default')) return merchantCache.get('default')!;
  const m = await Merchant.findOne().sort({ createdAt: 1 }).lean();
  if (!m) {
    throw new Error('No merchants found. Run "npm run seed" to populate the database.');
  }
  merchantCache.set('default', m._id as Types.ObjectId);
  return m._id as Types.ObjectId;
}

export function clearMerchantCache() {
  merchantCache.clear();
}

export function extractMerchantId(req: { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown> }): string | undefined {
  const fromHeader = req.headers['x-merchant-id'];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  const fromQuery = req.query.merchantId;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  return undefined;
}
