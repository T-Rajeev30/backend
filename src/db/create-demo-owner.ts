import { config } from 'dotenv';
config();
import { scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { connectDB } from './connection.js';
import { AuthUser, Merchant, MerchantMembership } from './models.js';

const scrypt = promisify(scryptCallback);

async function main() {
  const email = process.env.DEMO_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.DEMO_OWNER_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error('Set DEMO_OWNER_EMAIL and a DEMO_OWNER_PASSWORD of at least 12 characters');
  await connectDB();
  const merchant = await Merchant.findOne({ name: "Sharma Ji's Kitchen" });
  if (!merchant) throw new Error("Sharma Ji's Kitchen is missing; run the safe demo data setup first");
  const existing = await AuthUser.findOne({ email });
  if (existing) {
    const membership = await MerchantMembership.findOne({ userId: existing._id, merchantId: merchant._id });
    if (!membership || membership.role !== 'owner') throw new Error('This email already exists without the expected demo owner membership; no changes were made');
    console.log('Demo owner account is already configured.');
    return;
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  const user = await AuthUser.create({ email, passwordHash: `${salt}:${hash.toString('hex')}` });
  await MerchantMembership.create({ userId: user._id, merchantId: merchant._id, role: 'owner' });
  console.log('Demo owner account created and associated with Sharma Ji’s Kitchen.');
}

main().catch((error) => { console.error('Demo owner setup failed:', error.message); process.exitCode = 1; })
  .finally(async () => { if (mongoose.connection.readyState) await mongoose.disconnect(); });
