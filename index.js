import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(express.json());

// CORS — same as Wellington, lets a browser-based test tool call this.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// AUTH — same shared-secret pattern as Wellington. Use a DIFFERENT key value.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const provided = req.header('x-api-key');
  if (!process.env.API_KEY || provided !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// Unlike Wellington, Auckland's status-code → stage mapping (what counts as
// "needs organizing" vs "active" etc.) is NOT yet confirmed. So this agent
// is told to work with raw Simpro status names honestly, rather than
// pretend to categorize jobs the way Wellington's agent does.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the Auckland Ops Agent for Kiwiseal's franchisor
Business Hub. You only answer questions about the Auckland franchise's job
status using data from the Simpro Auckland API. Do not reference or infer
data from Wellington, Bay of Plenty, or any other franchise — you have no
access to them.

Important: Auckland's status-code meanings (the granular ones like "Deposit
paid", "Warranty Work" etc.) have not been individually confirmed. For the
main pending/progress/closed breakdown, this agent uses Simpro's own Stage
field directly (per Xavier: pending = sales process, progress = only jobs
actually in progress, closed = finished work — Invoiced, Complete, and
Archived jobs all count as closed). Use getJobsSummary for that. For
granular status detail, use getJobStatus and report raw status names
honestly.

Give direct, concise, numbers-first answers. If a tool call fails or returns
incomplete data, say so plainly rather than guessing.`;

const TOOLS = [
  {
    name: 'getJobStatus',
    description: 'Returns job status for a given job number or filter, from Simpro Auckland, using raw status names.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string', description: 'Specific Simpro job number, if known' },
        filter: { type: 'string', description: 'Free-text filter, e.g. customer name or job name' }
      }
    }
  },
  {
    name: 'getJobsSummary',
    description:
      "Returns total job count, plus pending/progress/closed breakdown using Simpro's own Stage field " +
      '— the key franchisor-level snapshot for Auckland, used for cross-checking against Pipely.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'getSchedulingGaps',
    description:
      'NOT YET CONFIRMED for Auckland — Wellington-equivalent status-code mapping has not been set up. ' +
      'Calling this will return an explanation rather than data.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'getInvoiceStatus',
    description: 'Returns invoiced vs outstanding amounts and per-invoice detail for a given job or date range in Auckland.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string' },
        dateFrom: { type: 'string', description: 'ISO date, filters by DateIssued' },
        dateTo: { type: 'string', description: 'ISO date, filters by DateIssued' }
      }
    }
  },
  {
    name: 'getJobPnl',
    description: 'Returns cost breakdown, margin %, and cost-vs-sell for a given Auckland job.',
    input_schema: {
      type: 'object',
      properties: { jobNumber: { type: 'string' } },
      required: ['jobNumber']
    }
  },
  {
    name: 'getJobPurchaseOrders',
    description:
      'Returns, per job: total PO value (all time), total job/contract value (franchise fee basis), ' +
      'and PO value as a % of job value. Full history by default — only filters by date if asked.',
    input_schema: {
      type: 'object',
      properties: {
        jobNumber: { type: 'string' },
        dateFrom: { type: 'string', description: 'Only set if the user explicitly asked to filter by date' },
        dateTo: { type: 'string' }
      }
    }
  }
];

// ---------------------------------------------------------------------------
// SIMPRO API CLIENT
// Same request shape as Wellington's confirmed getJobsReal pattern
// (companies/{COMPANY_ID}/jobs/, paginated) — this is standard Simpro REST
// structure, so it should carry over. Not yet tested against Auckland's
// real instance though, so treat the first real call as the actual test.
// ---------------------------------------------------------------------------
async function simproRequest(path, params = {}) {
  if (!process.env.SIMPRO_BEARER_TOKEN) {
    throw new Error('SIMPRO_BEARER_TOKEN not configured');
  }
  const base = process.env.SIMPRO_BASE_URL.endsWith('/')
    ? process.env.SIMPRO_BASE_URL
    : process.env.SIMPRO_BASE_URL + '/';
  const cleanPath = path.replace(/^\/+/, '');
  const url = new URL(cleanPath, base);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.SIMPRO_BEARER_TOKEN}`,
      Accept: 'application/json'
    }
  });
  if (!res.ok) {
    throw new Error(`Simpro API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchAllJobs() {
  if (!process.env.SIMPRO_COMPANY_ID) {
    throw new Error('SIMPRO_COMPANY_ID not configured — find this in Auckland\'s Simpro instance');
  }
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${process.env.SIMPRO_COMPANY_ID}/jobs/`, {
      pageSize: '100',
      page: String(page),
      columns: 'ID,Status,Stage,Type,Total,DateIssued,DueDate,Site,Customer,Name'
    });
    // Simpro's jobs endpoint returns a bare array, not {data: [...]} — handle
    // both shapes defensively in case that ever changes.
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Confirmed real endpoints for invoices / purchase orders (called
// "vendorOrders" in Simpro's own API) / job P&L — same discovery process
// used for Wellington, verified against real Auckland data before porting.
// Two path quirks that don't follow the jobs-collection pattern:
//   - Single job detail (`jobs/{id}`) takes NO trailing slash — the
//     opposite of the collection endpoints below, which all need one.
//   - Purchase orders are "vendorOrders" in Simpro, not "purchaseOrders".
// ---------------------------------------------------------------------------
async function fetchAllInvoices() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${process.env.SIMPRO_COMPANY_ID}/invoices/`, {
      pageSize: '100',
      page: String(page),
      columns: 'ID,Type,Customer,Jobs,Total,IsPaid,DateIssued,Status'
    });
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function fetchAllVendorOrders() {
  const all = [];
  let page = 1;
  while (true) {
    const res = await simproRequest(`companies/${process.env.SIMPRO_COMPANY_ID}/vendorOrders/`, {
      pageSize: '100',
      page: String(page),
      columns: 'ID,Stage,Reference,Totals,AssignedTo,DateIssued'
    });
    const batch = Array.isArray(res) ? res : res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

function pnlHealth(marginPct) {
  if (marginPct >= 60) return 'strong';
  if (marginPct >= 40) return 'ok';
  if (marginPct >= 0) return 'tight';
  return 'loss';
}

function shapeJob(j) {
  const customer = j.Customer?.CompanyName
    || `${j.Customer?.GivenName ?? ''} ${j.Customer?.FamilyName ?? ''}`.trim()
    || 'Unknown';
  const rawSimproStage = (typeof j.Stage === 'string' ? j.Stage : j.Stage?.Name) ?? 'Unknown';
  return {
    id: j.ID,
    name: j.Name ?? `Job #${j.ID}`,
    statusName: (j.Status?.Name ?? 'Unknown').trim(),
    rawSimproStage,
    customer,
    siteAddress: j.Site?.Name ?? '',
    totalIncTax: j.Total?.IncTax ?? 0,
    dateIssued: j.DateIssued ?? '',
    dueDate: j.DueDate ?? ''
  };
}

// ---------------------------------------------------------------------------
// Cross-franchise waterfall model — corrected per Xavier: uses Simpro's
// actual Stage field directly, not inferred from status names/order.
// Pending = sales process; Progress = only jobs actually in progress;
// Closed = finished work, which includes Invoiced, Complete, AND Archived
// jobs (not just Archived). Matches case-insensitively and reports
// anything unrecognized so a mismatch is obvious on the first real test
// rather than silently miscounted.
// ---------------------------------------------------------------------------
function categorize(rawSimproStage) {
  const s = (rawSimproStage || '').toLowerCase();
  if (s.includes('pending')) return 'pending';
  if (s.includes('progress')) return 'progress';
  if (s.includes('archive') || s.includes('invoiced') || s.includes('complete')) return 'closed';
  return 'uncategorized';
}

const toolImplementations = {
  async getJobStatus({ jobNumber, filter }) {
    const jobs = (await fetchAllJobs()).map(shapeJob);

    if (jobNumber) {
      const match = jobs.find((j) => String(j.id) === String(jobNumber));
      return match ? { job: match } : { error: `No job found with number ${jobNumber}` };
    }

    if (filter) {
      const needle = filter.toLowerCase();
      const matches = jobs.filter(
        (j) => j.name.toLowerCase().includes(needle) || j.customer.toLowerCase().includes(needle)
      );
      return { count: matches.length, jobs: matches.slice(0, 25) };
    }

    return { count: jobs.length, jobs: jobs.slice(0, 25) };
  },

  async getJobsSummary() {
    const jobs = (await fetchAllJobs()).map(shapeJob);
    const byCategory = { pending: [], progress: [], closed: [], uncategorized: [] };
    for (const j of jobs) byCategory[categorize(j.rawSimproStage)].push(j);

    const summarize = (arr) => ({ count: arr.length, totalValue: arr.reduce((s, j) => s + j.totalIncTax, 0) });

    return {
      totalJobs: jobs.length,
      pending: summarize(byCategory.pending),
      progress: summarize(byCategory.progress),
      closed: summarize(byCategory.closed),
      note: "Based on Simpro's Stage field directly: pending = sales process, progress = only jobs actually in progress, closed = finished work (Invoiced, Complete, and Archived jobs all count as closed).",
      uncategorized:
        byCategory.uncategorized.length > 0
          ? { count: byCategory.uncategorized.length, rawStages: [...new Set(byCategory.uncategorized.map((j) => j.rawSimproStage))] }
          : undefined
    };
  },

  async getSchedulingGaps() {
    return {
      error:
        "Auckland's status-code mapping (which statuses mean 'needs scheduling') hasn't been " +
        'confirmed yet. Use getJobStatus to see raw status names, or update this tool once the mapping is known.'
    };
  },

  async getInvoiceStatus({ jobNumber, dateFrom, dateTo }) {
    let invoices = await fetchAllInvoices();

    if (jobNumber) {
      invoices = invoices.filter((inv) => (inv.Jobs || []).some((j) => String(j.ID) === String(jobNumber)));
    }
    if (dateFrom) invoices = invoices.filter((inv) => (inv.DateIssued ?? '') >= dateFrom);
    if (dateTo) invoices = invoices.filter((inv) => (inv.DateIssued ?? '') <= dateTo);

    const shaped = invoices.map((inv) => ({
      invoiceId: inv.ID,
      type: inv.Type,
      customer: inv.Customer?.CompanyName
        || `${inv.Customer?.GivenName ?? ''} ${inv.Customer?.FamilyName ?? ''}`.trim()
        || 'Unknown',
      jobIds: (inv.Jobs || []).map((j) => j.ID),
      statusName: inv.Status?.Name ?? 'Unknown',
      dateIssued: inv.DateIssued ?? '',
      totalIncTax: inv.Total?.IncTax ?? 0,
      balanceDue: inv.Total?.BalanceDue ?? 0,
      isPaid: inv.IsPaid ?? false
    }));

    return {
      count: shaped.length,
      totalInvoiced: shaped.reduce((s, i) => s + i.totalIncTax, 0),
      totalOutstanding: shaped.reduce((s, i) => s + i.balanceDue, 0),
      totalPaid: shaped.filter((i) => i.isPaid).reduce((s, i) => s + i.totalIncTax, 0),
      invoices: shaped.slice(0, 25)
    };
  },

  async getJobPnl({ jobNumber }) {
    const j = await simproRequest(`companies/${process.env.SIMPRO_COMPANY_ID}/jobs/${jobNumber}`, {
      columns: 'ID,Name,Stage,Status,Customer,Total,Totals,DateIssued'
    });

    const exTax = j.Total?.ExTax ?? 0;
    const gp = j.Totals?.GrossProfitLoss?.Actual ?? 0;
    const margin = j.Totals?.GrossMargin?.Actual ?? (exTax > 0 ? Math.round((gp / exTax) * 10000) / 100 : 0);
    const matActual = j.Totals?.MaterialsCost?.Actual ?? 0;
    const matCommitted = j.Totals?.MaterialsCost?.Committed ?? 0;
    const labourActual = j.Totals?.ResourcesCost?.Labor?.Actual ?? 0;
    const totalCostsActual = (j.Totals?.ResourcesCost?.Total?.Actual ?? 0) + matActual;
    const costPct = exTax > 0 ? Math.round((totalCostsActual / exTax) * 100) : 0;

    return {
      jobId: String(j.ID),
      customer: j.Customer?.CompanyName
        || `${j.Customer?.GivenName ?? ''} ${j.Customer?.FamilyName ?? ''}`.trim()
        || 'Unknown',
      stage: j.Stage ?? '',
      statusName: j.Status?.Name ?? '',
      dateIssued: j.DateIssued ?? '',
      contractExTax: exTax,
      contractIncTax: j.Total?.IncTax ?? 0,
      grossProfitActual: gp,
      grossMarginPct: margin,
      materialsCostActual: matActual,
      materialsCostCommitted: matCommitted,
      labourCostActual: labourActual,
      totalCostsActual,
      costPctOfSell: `${costPct}% of sell price`,
      health: pnlHealth(margin)
    };
  },

  async getJobPurchaseOrders({ jobNumber, dateFrom, dateTo }) {
    let orders = await fetchAllVendorOrders();

    if (jobNumber) orders = orders.filter((po) => String(po.AssignedTo?.Job) === String(jobNumber));
    if (dateFrom) orders = orders.filter((po) => (po.DateIssued ?? '') >= dateFrom);
    if (dateTo) orders = orders.filter((po) => (po.DateIssued ?? '') <= dateTo);

    const shaped = orders.map((po) => ({
      poId: po.ID,
      jobId: po.AssignedTo?.Job ?? null,
      stage: po.Stage,
      reference: po.Reference,
      totalExTax: po.Totals?.ExTax ?? 0,
      totalIncTax: po.Totals?.IncTax ?? 0,
      dateIssued: po.DateIssued ?? ''
    }));

    const totalPoValue = shaped.reduce((s, p) => s + p.totalIncTax, 0);

    let jobContractValue = null;
    let poPctOfJobValue = null;
    if (jobNumber) {
      try {
        const job = await simproRequest(`companies/${process.env.SIMPRO_COMPANY_ID}/jobs/${jobNumber}`, { columns: 'ID,Total' });
        jobContractValue = job.Total?.IncTax ?? null;
        if (jobContractValue) poPctOfJobValue = Math.round((totalPoValue / jobContractValue) * 1000) / 10;
      } catch (e) {
        // Job lookup failed — leave the comparison out rather than guessing.
      }
    }

    return {
      count: shaped.length,
      totalPoValue,
      jobContractValue,
      poPctOfJobValue,
      orders: shaped.slice(0, 25)
    };
  }
};

// ---------------------------------------------------------------------------
// AGENT LOOP (identical shape to Wellington)
// ---------------------------------------------------------------------------
async function runAgent(userMessage, conversationHistory = []) {
  const messages = [...conversationHistory, { role: 'user', content: userMessage }];

  while (true) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b) => b.type === 'text');
      return { reply: textBlock?.text ?? '', messages: [...messages, { role: 'assistant', content: response.content }] };
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const block of toolUseBlocks) {
      let result;
      try {
        const impl = toolImplementations[block.name];
        if (!impl) throw new Error(`No implementation for tool ${block.name}`);
        result = await impl(block.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result)
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

app.post('/chat', async (req, res) => {
  const { message, conversationHistory } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    const result = await runAgent(message, conversationHistory);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3002;
app.listen(port, () => console.log(`Auckland Simpro Agent listening on :${port}`));
