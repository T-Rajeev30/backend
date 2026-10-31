
import { config } from 'dotenv';
config();
import { connectDB } from './connection.js';
import mongoose from 'mongoose';
import { Merchant, Transaction } from './models.js';

async function diagnose() {
  await connectDB();

  const merchants = await Merchant.find().select('name businessType city dataMode').lean();
  const transactionCounts = await Promise.all(merchants.map(async (merchant) => ({
    merchant: merchant.name,
    count: await Transaction.countDocuments({ merchantId: merchant._id }),
  })));

  console.log('\n========== DATABASE DIAGNOSTIC ==========');
  console.log('Database:', mongoose.connection.name);
  console.log('MongoDB host:', mongoose.connection.host);
  console.log('Total merchants:', merchants.length);
  console.log('Transactions by merchant:', transactionCounts);
  console.log('All merchants:', merchants);
  console.log('=========================================\n');

  await mongoose.disconnect();
}

diagnose().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
