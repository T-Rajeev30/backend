import { config } from 'dotenv';
config();

import mongoose, { Types } from 'mongoose';
import { Merchant, Customer, Product, Transaction } from './models.js';

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(2));
}

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const merchantConfigs = [
  {
    name: 'Cafe Brew',
    businessType: 'cafe',
    address: '45 MG Road, Koramangala',
    city: 'Bengaluru',
    phone: '+91-9876543210',
    email: 'owner@cafebrew.in',
    products: [
      { name: 'Espresso', category: 'coffee', price: 150, cost: 40 },
      { name: 'Cappuccino', category: 'coffee', price: 200, cost: 55 },
      { name: 'Cold Coffee', category: 'coffee', price: 220, cost: 60 },
      { name: 'Latte', category: 'coffee', price: 250, cost: 65 },
      { name: 'Green Tea', category: 'tea', price: 120, cost: 25 },
      { name: 'Masala Chai', category: 'tea', price: 80, cost: 15 },
      { name: 'Veg Sandwich', category: 'snacks', price: 180, cost: 50 },
      { name: 'Paneer Wrap', category: 'snacks', price: 220, cost: 70 },
      { name: 'Chocolate Brownie', category: 'desserts', price: 160, cost: 45 },
      { name: 'Blueberry Muffin', category: 'desserts', price: 140, cost: 35 },
      { name: 'Cold Coffee Combo', category: 'combos', price: 320, cost: 100 },
      { name: 'Breakfast Combo', category: 'combos', price: 350, cost: 110 },
    ],
    customerCount: 150,
    morningBias: ['coffee', 'tea', 'combos'],
  },
  {
    name: 'Sharma Kirana Store',
    businessType: 'kirana',
    address: '12 Lajpat Nagar',
    city: 'Delhi',
    phone: '+91-9876543211',
    email: 'sharma.kirana@gmail.com',
    products: [
      { name: 'Atta (5kg)', category: 'staples', price: 280, cost: 240 },
      { name: 'Rice (5kg)', category: 'staples', price: 350, cost: 300 },
      { name: 'Toor Dal (1kg)', category: 'staples', price: 160, cost: 130 },
      { name: 'Cooking Oil (1L)', category: 'staples', price: 180, cost: 150 },
      { name: 'Sugar (1kg)', category: 'staples', price: 50, cost: 42 },
      { name: 'Amul Milk (1L)', category: 'dairy', price: 64, cost: 56 },
      { name: 'Curd (400g)', category: 'dairy', price: 35, cost: 28 },
      { name: 'Paneer (200g)', category: 'dairy', price: 90, cost: 72 },
      { name: 'Maggi (4-pack)', category: 'packaged', price: 56, cost: 48 },
      { name: 'Biscuits (Marie)', category: 'packaged', price: 30, cost: 25 },
      { name: 'Soap (Dove)', category: 'personal_care', price: 65, cost: 52 },
      { name: 'Shampoo Sachet', category: 'personal_care', price: 5, cost: 3 },
    ],
    customerCount: 200,
    morningBias: ['dairy', 'staples'],
  },
  {
    name: 'Glamour Salon',
    businessType: 'salon',
    address: '8 Brigade Road',
    city: 'Bengaluru',
    phone: '+91-9876543212',
    email: 'glamour.salon@gmail.com',
    products: [
      { name: 'Haircut (Men)', category: 'haircut', price: 300, cost: 50 },
      { name: 'Haircut (Women)', category: 'haircut', price: 500, cost: 80 },
      { name: 'Hair Colour', category: 'colour', price: 1500, cost: 400 },
      { name: 'Highlights', category: 'colour', price: 2500, cost: 600 },
      { name: 'Facial (Basic)', category: 'skincare', price: 800, cost: 200 },
      { name: 'Facial (Premium)', category: 'skincare', price: 1500, cost: 350 },
      { name: 'Manicure', category: 'nails', price: 400, cost: 80 },
      { name: 'Pedicure', category: 'nails', price: 500, cost: 100 },
      { name: 'Head Massage', category: 'spa', price: 350, cost: 60 },
      { name: 'Hair Spa', category: 'spa', price: 1200, cost: 300 },
    ],
    customerCount: 100,
    morningBias: ['haircut', 'skincare'],
  },
];

const firstNames = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan',
  'Priya', 'Ananya', 'Shreya', 'Diya', 'Isha', 'Kavya', 'Riya', 'Anika', 'Saanvi', 'Myra',
  'Rohan', 'Kabir', 'Shaurya', 'Atharv', 'Advait', 'Dhruv', 'Lakshya', 'Neil', 'Arnav', 'Darsh',
  'Meera', 'Tara', 'Kiara', 'Zara', 'Nisha', 'Pooja', 'Sneha', 'Divya', 'Neha', 'Swati',
];

async function main() {
  let uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/merchant_autopilot';
  if (uri.endsWith('/')) uri += 'merchant_autopilot';
  else if (!uri.includes('merchant_autopilot')) uri += '/merchant_autopilot';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');

  for (const mc of merchantConfigs) {
    const merchant = await Merchant.findOneAndUpdate(
      { name: mc.name },
      { $set: {
        name: mc.name,
        businessType: mc.businessType,
        dataMode: 'simulated',
        address: mc.address,
        city: mc.city,
        phone: mc.phone,
        email: mc.email,
      } },
      { upsert: true, new: true },
    );

    const products = await Promise.all(mc.products.map((p) => Product.findOneAndUpdate(
      { merchantId: merchant._id, name: p.name },
      { $set: { ...p, merchantId: merchant._id, isActive: true } },
      { upsert: true, new: true },
    )));

    let customers: Array<{ _id: Types.ObjectId }> = await Customer.find({ merchantId: merchant._id }).select('_id').lean();
    if (customers.length === 0) {
      const customerDocs = [];
      for (let i = 0; i < mc.customerCount; i++) {
        const name = `${randomItem(firstNames)} ${String.fromCharCode(65 + randomBetween(0, 25))}.`;
        const daysAgo = randomBetween(1, 180);
        const firstVisitDaysAgo = randomBetween(daysAgo, 365);
        const totalVisits = randomBetween(1, 60);
        const segment = totalVisits > 30 ? 'loyal' : totalVisits > 10 ? 'regular' : daysAgo > 45 ? 'inactive' : 'new';

        customerDocs.push({
          merchantId: merchant._id,
          name,
          phone: `+91-${randomBetween(7000000000, 9999999999)}`,
          email: i % 3 === 0 ? `${name.toLowerCase().replace(/[^a-z]/g, '')}@gmail.com` : undefined,
          firstVisit: new Date(Date.now() - firstVisitDaysAgo * 86400000),
          lastVisit: new Date(Date.now() - daysAgo * 86400000),
          totalVisits,
          totalSpent: totalVisits * randomFloat(100, 350),
          segment,
          consentSms: true,
        });
      }
      customers = await Customer.insertMany(customerDocs);
    }

    const existingTransactions = await Transaction.countDocuments({ merchantId: merchant._id });
    if (existingTransactions === 0) {
    const now = new Date();
    const transactions: any[] = [];

    for (let dayOffset = 56; dayOffset >= 0; dayOffset--) {
      const date = new Date(now.getTime() - dayOffset * 86400000);
      const dayOfWeek = date.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const isRecentWeek = dayOffset < 28;

      const morningCount = randomBetween(15, 25);
      for (let j = 0; j < morningCount; j++) {
        const hour = randomBetween(8, 11);
        const product = randomItem(products.filter((p) => mc.morningBias.includes(p.category)));
        if (!product) continue;
        const customer = randomItem(customers);
        transactions.push({
          merchantId: merchant._id,
          customerId: customer._id,
          productId: product._id,
          amount: product.price * randomBetween(1, 2),
          quantity: randomBetween(1, 2),
          paymentMode: randomItem(['upi', 'upi', 'upi', 'card', 'cash']),
          timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, randomBetween(0, 59)),
          hourOfDay: hour,
          dayOfWeek,
        });
      }

      const baseAfternoon = isWeekend ? randomBetween(10, 15) : randomBetween(8, 14);
      const afternoonCount = isRecentWeek && !isWeekend ? Math.max(3, Math.floor(baseAfternoon * 0.65)) : baseAfternoon;

      for (let j = 0; j < afternoonCount; j++) {
        const hour = randomBetween(14, 17);
        const product = randomItem(products);
        const customer = randomItem(customers);
        transactions.push({
          merchantId: merchant._id,
          customerId: customer._id,
          productId: product._id,
          amount: product.price * randomBetween(1, 2),
          quantity: randomBetween(1, 2),
          paymentMode: randomItem(['upi', 'upi', 'card', 'cash']),
          timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, randomBetween(0, 59)),
          hourOfDay: hour,
          dayOfWeek,
        });
      }

      const eveningCount = randomBetween(8, 16);
      for (let j = 0; j < eveningCount; j++) {
        const hour = randomBetween(18, 21);
        const product = randomItem(products);
        const customer = randomItem(customers);
        transactions.push({
          merchantId: merchant._id,
          customerId: customer._id,
          productId: product._id,
          amount: product.price,
          quantity: 1,
          paymentMode: randomItem(['upi', 'upi', 'card', 'cash']),
          timestamp: new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, randomBetween(0, 59)),
          hourOfDay: hour,
          dayOfWeek,
        });
      }
    }

    const batchSize = 500;
    for (let i = 0; i < transactions.length; i += batchSize) {
      await Transaction.insertMany(transactions.slice(i, i + batchSize));
    }
    }

    const transactionCount = await Transaction.countDocuments({ merchantId: merchant._id });
    console.log(`Seeded simulated data for ${mc.name}: ${products.length} products, ${customers.length} customers, ${transactionCount} transactions`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
