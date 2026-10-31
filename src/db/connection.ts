
import mongoose from 'mongoose';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is missing from backend/.env');
  }

  const dbName =
    process.env.MONGODB_DB_NAME || 'merchant_autopilot';

  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 15000,
  });

  console.log(
    `Connected to MongoDB database: ${mongoose.connection.name}`,
  );
}
