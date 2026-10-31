
import { config } from 'dotenv';
config();

import { connectDB } from './connection.js';
import mongoose from 'mongoose';
import {
  Merchant,
  Customer,
  Product,
  Transaction,
} from './models.js';

const MERCHANT_NAME = "Sharma Ji's Kitchen";

const menu = [
  { name: 'Masala Dosa', category: 'South Indian', price: 90, cost: 35 },
  { name: 'Idli Vada', category: 'South Indian', price: 70, cost: 28 },
  { name: 'Paneer Roll', category: 'Snacks', price: 120, cost: 55 },
  { name: 'Veg Thali', category: 'Meals', price: 180, cost: 95 },
  { name: 'Filter Coffee', category: 'Beverages', price: 40, cost: 14 },
  { name: 'Masala Chai', category: 'Beverages', price: 25, cost: 9 },
  { name: 'Veg Biryani', category: 'Meals', price: 160, cost: 85 },
  { name: 'Samosa', category: 'Snacks', price: 25, cost: 10 },
];

const names = [
  'Aarav Sharma', 'Priya Verma', 'Rahul Mehta',
  'Ananya Rao', 'Rohan Gupta', 'Sneha Iyer',
  'Arjun Nair', 'Kavya Reddy', 'Aditya Jain',
  'Neha Kapoor', 'Vikram Singh', 'Meera Joshi',
  'Karan Patel', 'Divya Menon', 'Ishaan Das',
  'Pooja Shah', 'Kabir Malhotra', 'Riya Sinha',
  'Amit Kulkarni', 'Sanya Mishra',
];

async function main() {
  await connectDB();

  // Upsert only this merchant. Existing merchants are untouched.
  const merchant = await Merchant.findOneAndUpdate(
    { name: MERCHANT_NAME },
    {
      $set: {
        name: MERCHANT_NAME,
        businessType: 'restaurant',
        dataMode: 'simulated',
        address: 'Indiranagar, Bengaluru',
        city: 'Bengaluru',
        email: 'demo@sharmajiskitchen.example',
      },
    },
    { upsert: true, new: true },
  );

  console.log('Merchant:', merchant.name, merchant._id);

  // Create or update the restaurant menu.
  const products = await Promise.all(
    menu.map((item) =>
      Product.findOneAndUpdate(
        { merchantId: merchant._id, name: item.name },
        {
          $set: {
            ...item,
            merchantId: merchant._id,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      ),
    ),
  );

  console.log('Menu items:', products.length);

  // Create fictional demo customers, without duplicating them.
  const customers = await Promise.all(
    Array.from({ length: 40 }, async (_, i) => {
      const segment =
        i < 12 ? 'loyal' :
        i < 25 ? 'regular' :
        i < 34 ? 'inactive' : 'new';

      const daysAgo = i < 34 ? (i % 20) + 1 : (i % 5) + 1;

      return Customer.findOneAndUpdate(
        {
          merchantId: merchant._id,
          phone: `DEMO-CUSTOMER-${String(i + 1).padStart(3, '0')}`,
        },
        {
          $setOnInsert: {
            merchantId: merchant._id,
            name: names[i % names.length],
            phone: `DEMO-CUSTOMER-${String(i + 1).padStart(3, '0')}`,
            email: `customer${i + 1}@example.test`,
            firstVisit: new Date(Date.now() - 180 * 86400000),
            lastVisit: new Date(Date.now() - daysAgo * 86400000),
            totalVisits: 5 + (i * 3) % 40,
            totalSpent: 500 + i * 125,
            segment,
            consentSms: false,
          },
        },
        { upsert: true, new: true },
      );
    }),
  );

  console.log('Demo customers:', customers.length);

  // Generate transactions only if this merchant has none.
  // Re-running this script will not duplicate transaction history.
  const existingTransactions = await Transaction.countDocuments({
    merchantId: merchant._id,
  });

  if (existingTransactions === 0) {
    const transactions = [];

    for (let day = 55; day >= 0; day--) {
      const date = new Date(Date.now() - day * 86400000);

      // Deliberately lower afternoon activity in recent weeks.
      const count =
        day < 14 ? 7 + (day % 3) :
        10 + (day % 5);

      for (let j = 0; j < count; j++) {
        const customer = customers[(day * 7 + j * 3) % customers.length];
        const product = products[(day + j * 2) % products.length];

        const hour =
          j < 3 ? 8 + (j % 3) :
          j < 5 ? 14 + (j % 3) :
          18 + (j % 4);

        const quantity = j % 4 === 0 ? 2 : 1;

        transactions.push({
          merchantId: merchant._id,
          customerId: customer._id,
          productId: product._id,
          amount: product.price * quantity,
          quantity,
          paymentMode: ['upi', 'upi', 'card', 'cash'][j % 4],
          timestamp: new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            hour,
            (j * 7) % 60,
          ),
          hourOfDay: hour,
          dayOfWeek: date.getDay(),
        });
      }
    }

    await Transaction.insertMany(transactions);
    console.log('Transactions created:', transactions.length);
  } else {
    console.log(
      'Existing transactions found. Skipping transaction creation:',
      existingTransactions,
    );
  }

  console.log('✅ Sharma Ji demo data setup complete.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('❌ Demo setup failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
