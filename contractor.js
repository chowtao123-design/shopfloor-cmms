// Contractor map page (contractor.html): no login, opened with the secret
// link from the contractor's record (#t=<token>). Shows the machines with
// open service orders for this contractor on the floor plan and lets him
// comment on each. English and Simplified Chinese throughout. The server
// allows one load and one comment per 5 seconds; a quicker F5 shows a wait
// message and loads again by itself.

const SVG_NS = 'http://www.w3.org/2000/svg';
const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';

const STATUS = {
  open: 'Open · 待处理',
  'in-progress': 'In progress · 进行中',
  'waiting-parts': 'Waiting for parts · 等待零件',
  'waiting-tech': 'Waiting for technician · 等待技术员',
};
const PRIORITY = { none: '', low: 'Low · 低', medium: 'Medium · 中', high: 'High · 高', urgent: 'Urgent · 紧急' };

const content = document.getElementById('content');
const notice = document.getElementById('notice');
const who = document.getElementById('who');
const refreshButton = document.getElementById('refresh');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

function show(message, kind = '') {
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = !message;
}

const api = (method, path, body) =>
  fetch(path, {
    method,
    headers: {
      'X-Portal-Token': token,
      'X-Requested-With': 'maint-log',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

let retryTimer = null;
let cooldownTimer = null;

/** The Refresh button counts down the 5 seconds the server asks for. */
function cooldown(seconds) {
  clearInterval(cooldownTimer);
  let left = seconds;
  refreshButton.disabled = true;
  refreshButton.textContent = `Refresh · 刷新 (${left})`;
  cooldownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(cooldownTimer);
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh · 刷新';
    } else {
      refreshButton.textContent = `Refresh · 刷新 (${left})`;
    }
  }, 1000);
}

async function load() {
  clearTimeout(retryTimer);
  if (!token) {
    show('This page needs the link your contact sent you. 请使用联系人发给您的链接打开此页面。', 'error');
    refreshButton.hidden = true;
    return;
  }
  let res;
  try {
    res = await api('GET', '/api/portal');
  } catch {
    show('Cannot reach the server. Check the network and try again. 无法连接服务器，请检查网络后重试。', 'error');
    cooldown(5);
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const wait = Number(data.retryAfter) || 5;
    show(data.message || `Please wait ${wait} s. 请等待 ${wait} 秒。`);
    cooldown(wait);
    retryTimer = setTimeout(load, wait * 1000 + 200);
    return;
  }
  if (!res.ok) {
    show(data.message || 'This link is not valid any more. 此链接已失效。', 'error');
    content.replaceChildren();
    refreshButton.hidden = true;
    return;
  }
  show('');
  cooldown(5);
  render(data);
}

function render(data) {
  who.textContent = [data.contractor.company, data.contractor.contactName].filter(Boolean).join(' · ');
  const orders = data.orders || [];
  if (orders.length === 0) {
    content.replaceChildren(
      el('div', { class: 'card empty' }, el('p', {}, 'No open jobs for you right now.'), el('p', { class: 'zh' }, '目前没有分配给您的工单。')),
    );
    return;
  }
  // The machine's own number/name labels it on the map and on its job cards.
  const numberOf = new Map();
  for (const order of orders) if (!numberOf.has(order.machine.id)) numberOf.set(order.machine.id, order.machine.name || String(numberOf.size + 1));

  const jobs = el(
    'section',
    { class: 'jobs', 'aria-label': 'Jobs' },
    el('h2', {}, `Jobs (${orders.length}) `, el('span', { class: 'zh' }, `工单（${orders.length}）`)),
    ...orders.map((order) => jobCard(order, numberOf.get(order.machine.id))),
  );
  content.replaceChildren(mapCard(data.map, numberOf, orders), jobs);
}

function focusMachine(machineId) {
  for (const node of document.querySelectorAll('[data-machine]')) {
    node.classList.toggle('is-on', node.dataset.machine === machineId);
  }
}

function mapCard(map, numberOf, orders) {
  const card = el('section', { class: 'card map-card', 'aria-label': 'Floor map' }, el('h2', {}, 'Where to go ', el('span', { class: 'zh' }, '位置')));
  if (!map) {
    card.append(el('p', { class: 'zh' }, 'No floor plan yet. 暂无平面图。'));
    return card;
  }
  const root = svg('svg', { viewBox: `0 0 ${map.width} ${map.height}`, role: 'img', 'aria-label': 'Floor plan with your machines in red' });
  for (const f of map.fills) root.append(svg('rect', { x: f.x, y: f.y, width: f.w, height: f.h, fill: f.color || '#e5e7ec' }));
  for (const c of map.corridors) root.append(svg('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: '#9dc3e6' }));
  for (const b of map.boxes) root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: '#ffffff', stroke: '#94a3b8', 'stroke-width': 0.6 }));
  // Where Line A / Line B are: dashed outline + label tag, like the staff map.
  for (const area of map.areas || []) {
    // Bigger than on the staff map: the phone shows the whole floor small.
    const size = 24;
    const color = area.color || '#0f172a';
    const label = `${area.label} · ${area.label.replace(/^Line /, '')}线`;
    // ~0.62 em per Latin character, one extra em for the Chinese one.
    const tagW = (label.length + 1) * size * 0.62 + 10;
    root.append(
      svg('rect', { x: area.x, y: area.y, width: area.w, height: area.h, rx: 3, fill: color, 'fill-opacity': 0.06, stroke: color, 'stroke-width': 3, 'stroke-dasharray': '8 4' }),
      svg('rect', { x: area.x + 4, y: area.y - size * 0.8, width: tagW, height: size * 1.45, rx: 4, fill: color }),
      svg('text', { x: area.x + 9, y: area.y - size * 0.07, 'font-size': size, fill: '#fff', 'font-weight': 800, 'dominant-baseline': 'central' }, document.createTextNode(label)),
    );
  }
  const missing = orders.filter((o) => !map.highlights.some((h) => h.machineId === o.machine.id));
  for (const h of map.highlights) {
    const n = numberOf.get(h.machineId);
    // Largest font that fits the station box (about 0.6 em per character).
    const size = Math.max(2.5, Math.min(h.h * 0.7, (h.w * 0.9) / (0.6 * Math.max(1, String(n).length))));
    const group = svg(
      'g',
      { class: 'hl', 'data-machine': h.machineId, tabindex: 0, role: 'button', 'aria-label': `Machine ${n} · 机器 ${n}` },
      svg('rect', { x: h.x, y: h.y, width: h.w, height: h.h, rx: 1 }),
      svg('text', { x: h.x + h.w / 2, y: h.y + h.h / 2, 'font-size': size }, String(n)),
    );
    const go = () => {
      focusMachine(h.machineId);
      const job = document.querySelector(`.job[data-machine="${h.machineId}"]`);
      if (job) job.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    group.addEventListener('click', go);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') go();
    });
    root.append(group);
  }
  card.append(root);
  card.append(el('p', { class: 'status' }, 'Red = your machines, labelled with the machine number; tap one to see the job. ', el('span', { class: 'zh' }, '红色为您负责的机器，标有机器编号，点击查看工单。')));
  if (missing.length) {
    card.append(el('p', { class: 'status' }, `Not on the plan: ${missing.map((o) => o.machine.name).join(', ')} · 平面图上未标出`));
  }
  return card;
}

function jobCard(order, n) {
  const list = el('ul', { class: 'comments' }, ...order.comments.map(commentItem));
  const box = el('textarea', { maxlength: '1000', placeholder: 'Leave a comment for the maintenance team · 给维修团队留言' });
  const status = el('span', { class: 'status', role: 'status' });
  const send = el('button', { type: 'button' }, 'Send · 发送');
  send.addEventListener('click', async () => {
    const text = box.value.trim();
    if (!text) {
      status.textContent = 'Write a comment first. 请先输入留言。';
      return;
    }
    send.disabled = true;
    status.textContent = 'Sending… 发送中…';
    try {
      const res = await api('POST', '/api/portal/comment', { orderId: order.id, text });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        list.append(commentItem(data.comment));
        box.value = '';
        status.textContent = 'Sent. 已发送。';
      } else {
        status.textContent = data.message || 'Could not send. 发送失败。';
      }
    } catch {
      status.textContent = 'Cannot reach the server. 无法连接服务器。';
    }
    setTimeout(() => {
      send.disabled = false;
    }, 5000);
  });

  const m = order.machine;
  return el(
    'article',
    { class: 'card job', 'data-machine': m.id, onclick: () => focusMachine(m.id) },
    el(
      'div',
      { class: 'job-head' },
      el('span', { class: 'num', 'aria-hidden': 'true' }, String(n)),
      el(
        'div',
        {},
        el('h3', {}, `${order.number ? `${order.number} · ` : ''}${order.title}`),
        el('p', { class: 'meta' }, `Machine 机器: ${m.name}${m.type ? ` (${m.type})` : ''}${order.station ? ` · Station 工位: ${order.station}` : ''}${m.location ? ` · ${m.location}` : ''}`),
      ),
    ),
    el(
      'div',
      { class: 'pills' },
      el('span', { class: 'pill' }, STATUS[order.status] || order.status),
      PRIORITY[order.priority] ? el('span', { class: `pill ${order.priority}` }, PRIORITY[order.priority]) : null,
      order.dueDate ? el('span', { class: 'pill' }, `Due 截止: ${order.dueDate}`) : null,
    ),
    order.problem ? el('p', { class: 'problem' }, order.problem) : null,
    list,
    box,
    el('div', { class: 'row' }, status, send),
  );
}

function commentItem(comment) {
  const when = new Date(comment.at);
  return el('li', {}, el('time', { datetime: comment.at }, `${comment.by} · ${Number.isNaN(when.getTime()) ? comment.at : when.toLocaleString()}`), comment.text);
}

refreshButton.addEventListener('click', load);
load();
