import mongoose from 'mongoose';

export async function connectDB() {
  let uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/merchant_autopilot';
  if (uri.endsWith('/')) uri += 'merchant_autopilot';
  else if (!uri.includes('merchant_autopilot')) uri += '/merchant_autopilot';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');
}