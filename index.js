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
field directly (per Xavier: pending = sales process, progress = active work
including complete-and-invoiced jobs not yet archived, closed = archived).
Use getJobsSummary for that. For granular status detail, use getJobStatus
and report raw status names honestly.

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
    description: 'NOT YET IMPLEMENTED — endpoint not confirmed for Auckland.',
    input_schema: { type: 'object', properties: { jobNumber: { type: 'string' } } }
  },
  {
    name: 'getJobPnl',
    description: 'NOT YET IMPLEMENTED — endpoint not confirmed for Auckland.',
    input_schema: { type: 'object', properties: { jobNumber: { type: 'string' } } }
  },
  {
    name: 'getJobPurchaseOrders',
    description: 'NOT YET IMPLEMENTED — endpoint not confirmed for Auckland.',
    input_schema: { type: 'object', properties: { jobNumber: { type: 'string' } } }
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
    const batch = res.data;
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
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
// Pending = sales process; Progress = active jobs, INCLUDING
// complete-and-invoiced work not yet archived; Archive = fully done.
// Matches case-insensitively and reports anything unrecognized so a
// mismatch is obvious on the first real test rather than silently
// miscounted.
// ---------------------------------------------------------------------------
function categorize(rawSimproStage) {
  const s = (rawSimproStage || '').toLowerCase();
  if (s.includes('pending')) return 'pending';
  if (s.includes('progress')) return 'progress';
  if (s.includes('archive')) return 'closed';
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
      note: "Based on Simpro's Stage field directly: pending = sales process, progress = active including complete-and-invoiced work, closed = archived.",
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

  async getInvoiceStatus() {
    throw new Error('getInvoiceStatus not yet implemented — endpoint not confirmed for Auckland');
  },

  async getJobPnl() {
    throw new Error('getJobPnl not yet implemented — endpoint not confirmed for Auckland');
  },

  async getJobPurchaseOrders() {
    throw new Error('getJobPurchaseOrders not yet implemented — endpoint not confirmed for Auckland');
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
