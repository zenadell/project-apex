// agents/revenue.js
// APEX RevenueAgent — Makes money for Temple. Creates Stripe invoices, payment links,
// tracks income, automates the full Jomiez sales pipeline.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import axios from 'axios';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';
import { identity } from '../core/identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVENUE_DIR = path.join(__dirname, '..', '.apex-data', 'revenue');
if (!existsSync(REVENUE_DIR)) mkdirSync(REVENUE_DIR, { recursive: true });

export class RevenueAgent extends BaseAgent {
  constructor() {
    super({
      name: 'RevenueAgent',
      type: 'revenue',
      description: 'Makes money for Temple. Creates Stripe invoices and payment links, tracks income, automates the Jomiez sales pipeline from proposal to payment.',
    });
    this._stripe = null;
  }

  async run(task) {
    const { action = 'status' } = task;
    switch (action) {
      case 'invoice':        return this.createInvoice(task);
      case 'payment_link':   return this.createPaymentLink(task);
      case 'status':         return this.revenueStatus();
      case 'pipeline':       return this.runSalesPipeline(task);
      case 'opportunities':  return this.findOpportunities();
      case 'income_report':  return this.incomeReport();
      case 'automate':       return this.automateIncome(task);
      default:               return this.revenueStatus();
    }
  }

  // ── CREATE STRIPE INVOICE ────────────────────────────────────────────────
  async createInvoice({ clientEmail, clientName, items, dueDate = null, notes = '' }) {
    const stripe = this._getStripe();
    if (!stripe) return this._noStripeError();

    this.log(`Creating invoice for ${clientName} (${clientEmail})`);

    try {
      // Find or create customer
      const customers = await stripe.customers.list({ email: clientEmail, limit: 1 });
      let customer;
      if (customers.data.length > 0) {
        customer = customers.data[0];
      } else {
        customer = await stripe.customers.create({ email: clientEmail, name: clientName });
      }

      // Create invoice
      const invoice = await stripe.invoices.create({
        customer: customer.id,
        collection_method: 'send_invoice',
        days_until_due: dueDate ? Math.ceil((new Date(dueDate) - Date.now()) / 86400000) : 14,
        description: notes || `Services by Jomiez Innovation`,
      });

      // Add line items
      for (const item of items) {
        await stripe.invoiceItems.create({
          customer: customer.id,
          invoice: invoice.id,
          description: item.description,
          amount: Math.round(item.amount * 100), // cents
          currency: item.currency || 'usd',
        });
      }

      // Finalize and send
      const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
      await stripe.invoices.sendInvoice(invoice.id);

      const total = items.reduce((sum, i) => sum + i.amount, 0);
      this._saveTransaction({ type: 'invoice', client: clientName, email: clientEmail, amount: total, invoiceId: invoice.id, status: 'sent' });
      identity.achievement(`Invoice sent to ${clientName}`, `$${total}`);
      bus.emit('revenue:invoice_sent', { client: clientName, amount: total });

      return {
        success: true,
        invoiceId: invoice.id,
        invoiceUrl: finalized.hosted_invoice_url,
        amount: total,
        client: clientName,
        status: 'sent',
      };
    } catch (err) {
      this.log(`Stripe error: ${err.message}`, 'error');
      return { success: false, error: err.message };
    }
  }

  // ── CREATE PAYMENT LINK ──────────────────────────────────────────────────
  async createPaymentLink({ name, amount, currency = 'usd', description = '', quantity = 1 }) {
    const stripe = this._getStripe();
    if (!stripe) return this._noStripeError();

    this.log(`Creating payment link: ${name} — $${amount}`);

    try {
      // Create product
      const product = await stripe.products.create({ name, description });

      // Create price
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(amount * 100),
        currency,
      });

      // Create payment link
      const paymentLink = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity }],
        after_completion: { type: 'redirect', redirect: { url: 'https://jomiez.com/thank-you' } },
        metadata: { created_by: 'APEX', service: name },
      });

      this._saveTransaction({ type: 'payment_link', name, amount, url: paymentLink.url, linkId: paymentLink.id });
      bus.emit('revenue:payment_link_created', { name, amount, url: paymentLink.url });

      return {
        success: true,
        url: paymentLink.url,
        name,
        amount,
        currency: currency.toUpperCase(),
        linkId: paymentLink.id,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── RUN SALES PIPELINE ───────────────────────────────────────────────────
  async runSalesPipeline({ prospect, service, amount = null }) {
    this.log(`Sales pipeline: ${prospect.name} → ${service}`);

    // 1. Research prospect
    const registry = (await import('../core/agent-registry.js')).default;
    const prospector = registry.get('BusinessProspector');
    let research = {};
    if (prospector) {
      research = await prospector.researchBusiness({ name: prospect.name, website: prospect.website });
    }

    // 2. Build proposal
    const proposedAmount = amount || await this._suggestPrice(service, research);
    const proposal = await this._buildSalesProposal(prospect, service, proposedAmount, research);

    // 3. Create payment link ready to send
    const paymentLink = await this.createPaymentLink({
      name: `${service} — Jomiez Innovation`,
      amount: proposedAmount,
      description: `Web/app services for ${prospect.name}`,
    });

    // 4. Draft outreach email with payment link embedded
    const outreachEmail = await complete(
      `Write a professional short email from Temple Nweke at Jomiez Innovation to ${prospect.name}.\nService offered: ${service}\nProposed price: $${proposedAmount}\nPayment link: ${paymentLink.url}\nResearch on their business: ${JSON.stringify(research.analysis || {})}\n\nThe email should:\n1. Open with something specific about their business (shows research)\n2. Propose the service clearly with the price\n3. Include the payment link\n4. Be 3-4 short paragraphs max\n5. Sound human and direct, not templated\n\nSubject line on first line, then blank line, then body.`,
      { temperature: 0.7, maxTokens: 500 }
    );

    Memory.store({
      scope: 'long_term', agent: 'RevenueAgent',
      content: `Sales pipeline: ${prospect.name} | ${service} | $${proposedAmount} | Payment link created`,
      tags: ['sales', 'pipeline', 'revenue'], importance: 9,
    });

    return {
      prospect: prospect.name,
      service,
      proposedAmount,
      paymentLink: paymentLink.url,
      outreachEmail,
      proposal,
      status: 'ready_to_send',
    };
  }

  // ── FIND REVENUE OPPORTUNITIES ───────────────────────────────────────────
  async findOpportunities() {
    this.log('Scanning for revenue opportunities...');

    const opportunities = await structured(
      `You are the revenue agent for Jomiez Innovation, run by Temple Nweke.\nJomiez services: web development, app development, WhatsApp AI bots, document automation, AI integrations.\nTarget clients: US, UK, Canada, Australia, UAE businesses.\n\nIdentify the top 5 immediate revenue opportunities Temple can pursue this week. Be specific and practical.`,
      {
        opportunities: [{
          title: 'opportunity title',
          description: 'what to do',
          estimatedRevenue: 'USD amount range',
          effort: 'hours to complete',
          platform: 'where to find clients',
          immediateAction: 'exact first step',
        }]
      },
      { temperature: 0.5 }
    );

    bus.emit('revenue:opportunities_found', { count: opportunities.opportunities?.length });
    return opportunities;
  }

  // ── AUTOMATE INCOME STREAM ────────────────────────────────────────────────
  async automateIncome({ stream = 'freelance', niche = 'web development', daily = false }) {
    this.log(`Setting up automated income stream: ${stream}`);

    const plan = await structured(
      `Create a detailed automated income plan for Temple Nweke / Jomiez Innovation.\nStream: ${stream}\nNiche: ${niche}\nAvailable tools: web scraping, social messaging, email outreach, Stripe invoicing, code generation, deployment\nGoal: Generate income this week\n\nCreate a step-by-step automation plan APEX can execute autonomously.`,
      {
        streamName: 'income stream name',
        dailyRevenuePotential: '$X-Y per day',
        automationSteps: ['ordered list of steps APEX will execute'],
        platforms: ['where to find clients/customers'],
        deliverables: ['what APEX will build/deliver'],
        pricingStrategy: 'how to price services',
        paymentCollection: 'how payments are collected',
        timeToFirstIncome: 'realistic estimate',
      }
    );

    // If daily mode, schedule this to run every day
    if (daily) {
      const { taskScheduler } = await import('../core/task-scheduler.js');
      taskScheduler.schedule({
        name: `Daily Income: ${stream}`,
        task: { agent: 'RevenueAgent', action: 'pipeline_auto', stream, niche },
        schedule: 'daily:09:00',
      });
    }

    return plan;
  }

  // ── INCOME REPORT ─────────────────────────────────────────────────────────
  async incomeReport() {
    const transactions = this._loadTransactions();
    const totalInvoiced = transactions.filter(t => t.type === 'invoice').reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalLinks = transactions.filter(t => t.type === 'payment_link').length;

    // If Stripe available, get real data
    let stripeData = { balance: null, recent: [] };
    const stripe = this._getStripe();
    if (stripe) {
      try {
        const balance = await stripe.balance.retrieve();
        const charges = await stripe.charges.list({ limit: 10 });
        stripeData = {
          available: (balance.available[0]?.amount || 0) / 100,
          pending: (balance.pending[0]?.amount || 0) / 100,
          currency: balance.available[0]?.currency?.toUpperCase() || 'USD',
          recentCharges: charges.data.map(c => ({
            amount: c.amount / 100,
            description: c.description,
            date: new Date(c.created * 1000).toLocaleDateString(),
            status: c.status,
          })),
        };
      } catch {}
    }

    return {
      totalInvoicedThisSession: totalInvoiced,
      paymentLinksCreated: totalLinks,
      transactions: transactions.slice(-20),
      stripe: stripeData,
      summary: `${transactions.length} transactions tracked. $${totalInvoiced.toFixed(2)} invoiced.`,
    };
  }

  // ── REVENUE STATUS ────────────────────────────────────────────────────────
  async revenueStatus() {
    const stripeConfigured = !!process.env.STRIPE_SECRET_KEY;
    const transactions = this._loadTransactions();
    return {
      stripeConfigured,
      transactionCount: transactions.length,
      recentActivity: transactions.slice(-5),
      message: stripeConfigured ? 'Stripe connected — ready to invoice' : 'Add STRIPE_SECRET_KEY to .env to enable payments',
    };
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  _getStripe() {
    if (this._stripe) return this._stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    try {
      const Stripe = require('stripe');
      this._stripe = new Stripe(key, { apiVersion: '2024-06-20' });
      return this._stripe;
    } catch {
      return null;
    }
  }

  _noStripeError() {
    return {
      success: false,
      error: 'Stripe not configured',
      action: 'Add STRIPE_SECRET_KEY to your .env file. Get it at dashboard.stripe.com/apikeys',
    };
  }

  async _suggestPrice(service, research) {
    const suggestion = await complete(
      `Suggest a fair price in USD for this service for an international client:\nService: ${service}\nClient business type: ${research.analysis?.painPoints?.join(', ') || 'small business'}\nMarket: US/UK/Canada/Australia/UAE\nProvider: Jomiez Innovation (professional, AI-powered)\n\nRespond with just a number (e.g. 500).`,
      { temperature: 0.2, maxTokens: 10 }
    );
    return parseFloat(suggestion.trim().replace(/[^0-9.]/g, '')) || 500;
  }

  async _buildSalesProposal(prospect, service, amount, research) {
    return complete(
      `Write a 1-page sales proposal for ${prospect.name}.\nService: ${service}\nPrice: $${amount}\nFrom: Temple Nweke, Jomiez Innovation\nResearch findings: ${JSON.stringify(research.analysis || {})}\n\nStructure: Problem → Solution → Deliverables → Timeline → Price → CTA`,
      { temperature: 0.5, maxTokens: 800 }
    );
  }

  _saveTransaction(transaction) {
    const transactions = this._loadTransactions();
    transactions.push({ ...transaction, ts: Date.now() });
    writeFileSync(path.join(REVENUE_DIR, 'transactions.json'), JSON.stringify(transactions, null, 2));
  }

  _loadTransactions() {
    const p = path.join(REVENUE_DIR, 'transactions.json');
    if (!existsSync(p)) return [];
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
  }
}

export default RevenueAgent;
