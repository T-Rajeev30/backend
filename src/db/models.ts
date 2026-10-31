import mongoose, { Schema, Document } from 'mongoose';

// ── Merchant ──
export interface IMerchant extends Document {
  name: string;
  businessType: string;
  dataMode: 'simulated' | 'live';
  address: string;
  city: string;
  phone: string;
  email: string;
}

const MerchantSchema = new Schema<IMerchant>({
  name: { type: String, required: true },
  businessType: { type: String, required: true },
  dataMode: { type: String, enum: ['simulated', 'live'], default: 'simulated', required: true },
  address: String,
  city: String,
  phone: String,
  email: String,
}, { timestamps: true });

export const Merchant = mongoose.model<IMerchant>('Merchant', MerchantSchema);

export type MerchantRole = 'owner' | 'admin' | 'staff';
export interface IAuthUser extends Document { email: string; passwordHash: string; disabled: boolean; }
const AuthUserSchema = new Schema<IAuthUser>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  disabled: { type: Boolean, default: false },
}, { timestamps: true });
export const AuthUser = mongoose.model<IAuthUser>('AuthUser', AuthUserSchema);

export interface IMerchantMembership extends Document {
  userId: mongoose.Types.ObjectId; merchantId: mongoose.Types.ObjectId; role: MerchantRole;
}
const MerchantMembershipSchema = new Schema<IMerchantMembership>({
  userId: { type: Schema.Types.ObjectId, ref: 'AuthUser', required: true, index: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  role: { type: String, enum: ['owner', 'admin', 'staff'], required: true },
}, { timestamps: true });
MerchantMembershipSchema.index({ userId: 1, merchantId: 1 }, { unique: true });
export const MerchantMembership = mongoose.model<IMerchantMembership>('MerchantMembership', MerchantMembershipSchema);

export interface IAuthSession extends Document {
  userId: mongoose.Types.ObjectId; tokenHash: string; csrfHash: string; expiresAt: Date;
}
const AuthSessionSchema = new Schema<IAuthSession>({
  userId: { type: Schema.Types.ObjectId, ref: 'AuthUser', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  csrfHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });
export const AuthSession = mongoose.model<IAuthSession>('AuthSession', AuthSessionSchema);

export interface IRegistrationInvite extends Document {
  email: string; merchantId: mongoose.Types.ObjectId; role: MerchantRole; tokenHash: string; expiresAt: Date; usedAt?: Date;
}
const RegistrationInviteSchema = new Schema<IRegistrationInvite>({
  email: { type: String, required: true, lowercase: true, trim: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  role: { type: String, enum: ['admin', 'staff'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: Date,
}, { timestamps: true });
export const RegistrationInvite = mongoose.model<IRegistrationInvite>('RegistrationInvite', RegistrationInviteSchema);

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
  channel: 'message' | 'voice';
  isDemoCall?: boolean;
  voiceMessage?: string;
  voiceLanguage?: string;
  startDate: Date;
  endDate: Date;
  timeSlotStart?: number;
  timeSlotEnd?: number;
  daysOfWeek?: string;
  budgetAmount: number;
  discountPercent?: number;
  estimatedProfit?: number;
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
  channel: { type: String, enum: ['message', 'voice'], default: 'message' },
  isDemoCall: { type: Boolean, default: false },
  voiceMessage: String,
  voiceLanguage: String,
  startDate: Date,
  endDate: Date,
  timeSlotStart: Number,
  timeSlotEnd: Number,
  daysOfWeek: String,
  budgetAmount: { type: Number, required: true },
  discountPercent: Number,
  estimatedProfit: Number,
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
  costAmount?: number;
  discountAmount?: number;
}

const CampaignTargetSchema = new Schema<ICampaignTarget>({
  campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  groupType: { type: String, enum: ['treatment', 'control'], required: true },
  contacted: { type: Boolean, default: false },
  responded: { type: Boolean, default: false },
  purchased: { type: Boolean, default: false },
  spentAmount: Number,
  costAmount: Number,
  discountAmount: Number,
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
  treatmentGrossProfit?: number;
  controlGrossProfit?: number;
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
  treatmentGrossProfit: Number,
  controlGrossProfit: Number,
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

// ── Demo Call ──
// Lifecycle record for a single controlled outbound AI demo call. One record
// per campaign (unique index) so a campaign can never place more than one call.
export type DemoCallStatus =
  | 'initiating' | 'queued' | 'ringing' | 'in-progress'
  | 'completed' | 'failed' | 'busy' | 'no-answer' | 'rejected';

export interface IDemoCallTranscriptLine {
  role: 'assistant' | 'customer';
  text: string;
  at: Date;
}

export interface IDemoCall extends Document {
  campaignId: mongoose.Types.ObjectId;
  merchantId: mongoose.Types.ObjectId;
  provider: string;
  providerCallId?: string;
  correlationId: string;
  status: DemoCallStatus;
  maskedPhone: string;
  recipientName: string;
  language: 'en-IN' | 'hi-IN';
  streamSid?: string;
  startedAt: Date;
  answeredAt?: Date;
  completedAt?: Date;
  durationSec?: number;
  outcome?: string;
  consentConfirmedAt: Date;
  transcript: IDemoCallTranscriptLine[];
  lastError?: string;
}

const DemoCallSchema = new Schema<IDemoCall>({
  campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, unique: true },
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  provider: { type: String, required: true },
  providerCallId: String,
  correlationId: { type: String, required: true, index: true },
  status: {
    type: String,
    enum: ['initiating', 'queued', 'ringing', 'in-progress', 'completed', 'failed', 'busy', 'no-answer', 'rejected'],
    default: 'initiating',
    required: true,
  },
  maskedPhone: { type: String, required: true },
  recipientName: { type: String, required: true },
  language: { type: String, enum: ['en-IN', 'hi-IN'], default: 'en-IN' },
  streamSid: String,
  startedAt: { type: Date, default: Date.now },
  answeredAt: Date,
  completedAt: Date,
  durationSec: Number,
  outcome: String,
  consentConfirmedAt: { type: Date, required: true },
  transcript: {
    type: [new Schema<IDemoCallTranscriptLine>({
      role: { type: String, enum: ['assistant', 'customer'], required: true },
      text: { type: String, required: true },
      at: { type: Date, default: Date.now },
    }, { _id: false })],
    default: [],
  },
  lastError: String,
}, { timestamps: true });

export const DemoCall = mongoose.model<IDemoCall>('DemoCall', DemoCallSchema);
