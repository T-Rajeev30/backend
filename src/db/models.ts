import mongoose, { Schema, Document } from 'mongoose';

// ── Merchant ──
export interface IMerchant extends Document {
  name: string;
  businessType: string;
  address: string;
  city: string;
  phone: string;
  email: string;
}

const MerchantSchema = new Schema<IMerchant>({
  name: { type: String, required: true },
  businessType: { type: String, required: true },
  address: String,
  city: String,
  phone: String,
  email: String,
}, { timestamps: true });

export const Merchant = mongoose.model<IMerchant>('Merchant', MerchantSchema);

// ── Customer ──
export interface ICustomer extends Document {
  merchantId: mongoose.Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  firstVisit: Date;
  lastVisit: Date;
  totalVisits: number;
  totalSpent: number;
  segment: 'regular' | 'loyal' | 'inactive' | 'new';
  consentSms: boolean;
}

const CustomerSchema = new Schema<ICustomer>({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  name: { type: String, required: true },
  phone: String,
  email: String,
  firstVisit: Date,
  lastVisit: Date,
  totalVisits: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  segment: { type: String, enum: ['regular', 'loyal', 'inactive', 'new'], default: 'regular' },
  consentSms: { type: Boolean, default: true },
});

export const Customer = mongoose.model<ICustomer>('Customer', CustomerSchema);

// ── Product ──
export interface IProduct extends Document {
  merchantId: mongoose.Types.ObjectId;
  name: string;
  category: string;
  price: number;
  cost: number;
  isActive: boolean;
}

const ProductSchema = new Schema<IProduct>({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  name: { type: String, required: true },
  category: String,
  price: { type: Number, required: true },
  cost: { type: Number, required: true },
  isActive: { type: Boolean, default: true },
});

export const Product = mongoose.model<IProduct>('Product', ProductSchema);

// ── Transaction ──
export interface ITransaction extends Document {
  merchantId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  amount: number;
  quantity: number;
  paymentMode: string;
  timestamp: Date;
  hourOfDay: number;
  dayOfWeek: number;
}

const TransactionSchema = new Schema<ITransaction>({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  amount: { type: Number, required: true },
  quantity: { type: Number, default: 1 },
  paymentMode: { type: String, default: 'upi' },
  timestamp: { type: Date, required: true },
  hourOfDay: { type: Number, required: true },
  dayOfWeek: { type: Number, required: true },
});

TransactionSchema.index({ merchantId: 1, timestamp: 1 });
TransactionSchema.index({ merchantId: 1, hourOfDay: 1 });

export const Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);

// ── Campaign ──
export interface ICampaign extends Document {
  merchantId: mongoose.Types.ObjectId;
  recommendationId?: mongoose.Types.ObjectId;
  name: string;
  description: string;
  type: string;
  status: 'pending' | 'approved' | 'running' | 'completed' | 'rejected';
  targetSegment: string;
  startDate: Date;
  endDate: Date;
  timeSlotStart?: number;
  timeSlotEnd?: number;
  daysOfWeek?: string;
  budgetAmount: number;
  discountPercent?: number;
  estimatedProfit: number;
  actualCost?: number;
  actualRevenue?: number;
  actualProfit?: number;
  approvedAt?: Date;
  completedAt?: Date;
}

const CampaignSchema = new Schema<ICampaign>({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  recommendationId: { type: Schema.Types.ObjectId, ref: 'AiRecommendation' },
  name: { type: String, required: true },
  description: String,
  type: String,
  status: { type: String, enum: ['pending', 'approved', 'running', 'completed', 'rejected'], default: 'pending' },
  targetSegment: String,
  startDate: Date,
  endDate: Date,
  timeSlotStart: Number,
  timeSlotEnd: Number,
  daysOfWeek: String,
  budgetAmount: { type: Number, required: true },
  discountPercent: Number,
  estimatedProfit: { type: Number, required: true },
  actualCost: Number,
  actualRevenue: Number,
  actualProfit: Number,
  approvedAt: Date,
  completedAt: Date,
}, { timestamps: true });

export const Campaign = mongoose.model<ICampaign>('Campaign', CampaignSchema);

// ── Campaign Target ──
export interface ICampaignTarget extends Document {
  campaignId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  groupType: 'treatment' | 'control';
  contacted: boolean;
  responded: boolean;
  purchased: boolean;
  spentAmount?: number;
}

const CampaignTargetSchema = new Schema<ICampaignTarget>({
  campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  groupType: { type: String, enum: ['treatment', 'control'], required: true },
  contacted: { type: Boolean, default: false },
  responded: { type: Boolean, default: false },
  purchased: { type: Boolean, default: false },
  spentAmount: Number,
});

export const CampaignTarget = mongoose.model<ICampaignTarget>('CampaignTarget', CampaignTargetSchema);

// ── Campaign Result ──
export interface ICampaignResult extends Document {
  campaignId: mongoose.Types.ObjectId;
  totalTargeted: number;
  totalContacted: number;
  totalResponded: number;
  totalPurchased: number;
  controlGroupSize: number;
  controlGroupPurchased: number;
  totalCampaignCost: number;
  treatmentRevenue: number;
  controlRevenue: number;
  incrementalRevenue: number;
  incrementalProfit: number;
  merchantRoi: number;
  calculatedAt: Date;
}

const CampaignResultSchema = new Schema<ICampaignResult>({
  campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  totalTargeted: Number,
  totalContacted: Number,
  totalResponded: Number,
  totalPurchased: Number,
  controlGroupSize: Number,
  controlGroupPurchased: Number,
  totalCampaignCost: Number,
  treatmentRevenue: Number,
  controlRevenue: Number,
  incrementalRevenue: Number,
  incrementalProfit: Number,
  merchantRoi: Number,
  calculatedAt: { type: Date, default: Date.now },
});

export const CampaignResult = mongoose.model<ICampaignResult>('CampaignResult', CampaignResultSchema);

// ── AI Recommendation ──
export interface IAiRecommendation extends Document {
  merchantId: mongoose.Types.ObjectId;
  opportunityType: string;
  title: string;
  description: string;
  reasoning: string;
  severity: 'low' | 'medium' | 'high';
  metrics: Record<string, any>;
  suggestedAction: string;
  estimatedCost: number;
  estimatedProfit: number;
  status: 'new' | 'viewed' | 'actioned' | 'dismissed';
}

const AiRecommendationSchema = new Schema<IAiRecommendation>({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  opportunityType: String,
  title: String,
  description: String,
  reasoning: String,
  severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  metrics: { type: Schema.Types.Mixed, default: {} },
  suggestedAction: String,
  estimatedCost: Number,
  estimatedProfit: Number,
  status: { type: String, enum: ['new', 'viewed', 'actioned', 'dismissed'], default: 'new' },
}, { timestamps: true });

export const AiRecommendation = mongoose.model<IAiRecommendation>('AiRecommendation', AiRecommendationSchema);