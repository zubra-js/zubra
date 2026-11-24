// The help desk: Express routes, EJS views, zubra components rendered on the server and hydrated
// in the browser, and a store (MongoDB or memory).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import express from 'express';
import { sessions } from './auth.js';
import { zubra } from '@zubra/server/express';
import { actions } from '@zubra/actions/express';
import { SLA_HOURS } from './store/seed.js';
import { demo, FULL, NOTICE } from './hosted.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEWS = join(here, '../views');
const STATUSES = ['open', 'pending', 'solved'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const HOUR = 3_600_000;

const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
function ago(at, now) {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

/** `hosted`: the settings of a public demo (hosted.js), which caps and resets the help desk. */
export function createApp({ store, cache = true, now = () => Date.now(), hosted = null }) {
  const app = express();
  const auth = sessions();
  const limits = hosted && demo({ store, now, ...hosted });
  if (limits) store = limits.store;

  app.disable('x-powered-by');
  if (limits) app.use(limits.guard);
  app.use(express.static(join(here, '../public')));
  // Components rendered into the views, and their modules and @zubra/runtime served under /_zubra.
  // (Kept, for the error page at the end: `rendering.zubra` is the server it made.)
  // `compress`: the modules and the pages in Brotli or gzip, for a host with nothing in front that does.
  const rendering = zubra({ components: join(here, '../components'), cache, compress: true, ...(limits && { streamTimeout: limits.streamTimeout }) });
  app.use(rendering);
  app.use(auth.middleware(store));
  // The components' 'use server' functions (the reply box's), with the signed-in user and the
  // store. Before the body parser: an action reads its own body.
  // (A hosted demo is reached over plain HTTP behind a proxy, so the browser's https Origin is
  // named in `origins`; its posts are smaller too.)
  const served = actions({ components: join(here, '../components'), compress: true, context: ({ req }) => ({ user: req.user, store, now }), ...(limits && { origins: limits.origins, maxBytes: limits.maxBytes }) });
  app.use((req, res, next) => served.then((middleware) => middleware(req, res, next), next));
  app.use(express.urlencoded({ extended: false, ...(limits && { limit: limits.maxBytes }) }));

  /**
   * Render `view` inside the layout; `finish()` then adds the CSS of the components the page
   * used to its head and their modules to the end of its body.
   */
  async function page(res, view, locals = {}, status = 200) {
    const components = res.locals.zubra;
    const data = { ...res.locals, ...locals, zubra: components.render, user: res.locals.user, notice: limits ? NOTICE : null, actionsScript: (await served).actions.script() };
    const body = await ejs.renderFile(join(VIEWS, `${view}.ejs`), data, { async: false });
    const html = await ejs.renderFile(join(VIEWS, 'layout.ejs'), { ...data, body });
    res.status(status).type('html');
    // A component given a promise as a prop (the dashboard's recent activity) is pending in the
    // page; the rest streams in as the promise settles.
    if (components.pending) components.stream(html).pipe(res);
    // (Express's `res.req` is the request: whether it takes Brotli or gzip.)
    else rendering.zubra.send(res.req, res, components.finish(html));
  }

  const requireUser = (req, res, next) => (req.user ? next() : res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`));
  const requireAgent = (req, res, next) => (req.user?.role === 'agent' ? next() : res.status(403).send('Agents only'));

  // Display shapes for the components.
  const names = async () => Object.fromEntries((await store.listUsers()).map((user) => [user.id, user]));
  /** The last eight messages across every ticket, newest first (a promise: the page streams it). */
  const recentActivity = async (people, at) => {
    const tickets = await store.listTickets({});
    const hours = (ms) => Math.max(0, Math.round((at - ms) / 3600000));
    return tickets
      .flatMap((ticket) => ticket.messages.filter((message) => !message.internal).map((message) => ({ ticket, message })))
      .sort((a, b) => b.message.at - a.message.at)
      .slice(0, 8)
      .map(({ ticket, message }) => ({
        id: `${ticket.id}:${message.id}`,
        who: people[message.author]?.name ?? '?',
        subject: ticket.subject,
        href: `/tickets/${ticket.id}`,
        ago: hours(message.at) < 1 ? 'just now' : `${hours(message.at)}h ago`,
      }));
  };
  const row = (ticket, people, at) => ({
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    requester: people[ticket.requester]?.name ?? '?',
    assignee: people[ticket.assignee]?.name ?? 'Unassigned',
    updated: ago(ticket.updatedAt, at),
    due: ticket.dueAt,
    now: at,
    solved: ticket.status === 'solved',
    href: `/tickets/${ticket.id}`,
  });
  const visible = (req, ticket) => req.user.role === 'agent' || ticket.requester === req.user.id;

  app.get('/login', async (req, res) => {
    await page(res, 'login', { title: 'Sign in', people: await store.listUsers(), next: req.query.next ?? '/' });
  });
  app.post('/login', async (req, res) => {
    const user = await store.getUser(req.body.user);
    if (!user) return res.redirect(303, '/login');
    auth.signIn(res, user.id);
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
    res.redirect(303, next);
  });
  app.post('/logout', (req, res) => {
    auth.signOut(res);
    res.redirect(303, '/login');
  });

  app.get('/', requireUser, async (req, res) => {
    const at = now();
    const people = await names();
    if (req.user.role === 'customer') {
      const mine = await store.listTickets({ requester: req.user.id });
      return page(res, 'home', { title: 'Your tickets', tickets: mine.map((ticket) => row(ticket, people, at)) });
    }
    const stats = await store.stats(at);
    const queue = (await store.listTickets({})).filter((ticket) => ticket.status !== 'solved' && (ticket.assignee === req.user.id || !ticket.assignee));
    // Streamed: the dashboard doesn't wait for the activity list (`recent-activity` shows
    // "loading" until it arrives, then hydrates the list in place).
    // (A hosted demo streams a bounded number at once; past that the list comes in the page.)
    const activity = !limits || limits.streams.take(res) ? recentActivity(people, at) : await recentActivity(people, at);
    await page(res, 'dashboard', {
      title: 'Dashboard',
      stats,
      activity,
      segments: [
        { label: 'Open', value: stats.byStatus.open, tone: 0 },
        { label: 'Pending', value: stats.byStatus.pending, tone: 2 },
        { label: 'Solved', value: stats.byStatus.solved, tone: 3 },
      ],
      queue: queue.map((ticket) => row(ticket, people, at)),
    });
  });

  app.get('/tickets', requireUser, async (req, res) => {
    const filter = {
      status: STATUSES.includes(req.query.status) ? req.query.status : '',
      priority: PRIORITIES.includes(req.query.priority) ? req.query.priority : '',
      q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '',
    };
    const at = now();
    const people = await names();
    const found = await store.listTickets({ ...filter, requester: req.user.role === 'customer' ? req.user.id : undefined });
    await page(res, 'tickets', { title: 'Tickets', filter, tickets: found.map((ticket) => row(ticket, people, at)) });
  });

  app.get('/tickets/new', requireUser, async (req, res) => {
    await page(res, 'new', { title: 'New ticket', values: { subject: '', body: '', priority: 'normal' }, errors: {} });
  });
  app.post('/tickets', requireUser, async (req, res) => {
    const values = {
      subject: String(req.body.subject ?? '').trim(),
      body: String(req.body.body ?? '').trim(),
      priority: PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal',
    };
    const errors = {};
    if (values.subject.length < 5) errors.subject = 'Give the ticket a subject of at least 5 characters.';
    if (values.subject.length > 120) errors.subject = 'Keep the subject under 120 characters.';
    if (!values.body) errors.body = 'Describe the problem.';
    if (Object.keys(errors).length) return page(res, 'new', { title: 'New ticket', values, errors }, 422);
    const at = now();
    const id = await store.createTicket({
      subject: values.subject,
      requester: req.user.id,
      assignee: null,
      priority: values.priority,
      status: 'open',
      createdAt: at,
      updatedAt: at,
      dueAt: at + SLA_HOURS[values.priority] * HOUR,
      messages: [{ id: `m${at.toString(36)}`, author: req.user.id, body: values.body, at, internal: false }],
    });
    if (id == null) return page(res, 'new', { title: 'New ticket', values, errors: { form: FULL } }, 503);
    res.redirect(303, `/tickets/${id}`);
  });

  app.get('/tickets/:id', requireUser, async (req, res, next) => {
    const ticket = await store.getTicket(Number(req.params.id));
    if (!ticket || !visible(req, ticket)) return next();
    const at = now();
    const people = await names();
    const agent = req.user.role === 'agent';
    const messages = ticket.messages
      .filter((message) => agent || !message.internal)
      .map((message) => ({
        id: message.id,
        author: people[message.author]?.name ?? '?',
        role: people[message.author]?.role ?? 'customer',
        body: message.body,
        at: when.format(message.at),
        internal: message.internal,
      }));
    await page(res, 'ticket', {
      title: `#${ticket.id} ${ticket.subject}`,
      ticket: row(ticket, people, at),
      messages,
      agent,
      agents: (await store.listUsers()).filter((user) => user.role === 'agent'),
      assigneeId: ticket.assignee ?? '',
      updated: req.query.updated === '1',
    });
  });

  app.post('/tickets/:id', requireUser, requireAgent, async (req, res, next) => {
    const id = Number(req.params.id);
    const ticket = await store.getTicket(id);
    if (!ticket) return next();
    const changes = {};
    if (STATUSES.includes(req.body.status)) changes.status = req.body.status;
    if (PRIORITIES.includes(req.body.priority) && req.body.priority !== ticket.priority) {
      changes.priority = req.body.priority;
      changes.dueAt = ticket.createdAt + SLA_HOURS[req.body.priority] * HOUR;
    }
    if (typeof req.body.assignee === 'string') {
      const assignee = req.body.assignee ? await store.getUser(req.body.assignee) : null;
      if (!req.body.assignee || assignee?.role === 'agent') changes.assignee = assignee?.id ?? null;
    }
    changes.updatedAt = now();
    await store.updateTicket(id, changes);
    res.redirect(303, `/tickets/${id}?updated=1`);
  });

  app.use(async (req, res) => {
    await page(res, 'error', { title: 'Not found', message: "That page doesn't exist, or it isn't yours to see." }, 404);
  });
  app.use(async (error, req, res, next) => {
    // (A hosted demo's form post past its limit, read without a length: the limit, not a failure.)
    if (limits && error.type === 'entity.too.large' && !res.headersSent) return res.status(413).type('text').send(`A request body is at most ${limits.maxBytes} bytes.`);
    console.error(error);
    if (res.headersSent) return next(error);
    // In development the page says what and where (usually something to fix in a view or a
    // component); in production only that something went wrong.
    const failed = rendering.zubra.errorPage(error);
    res.status(failed.status).set('content-type', failed.type).send(failed.body);
  });
  return app;
}
