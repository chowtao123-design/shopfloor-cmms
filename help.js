const HELP_SECTIONS = [
  { id: 'help-about', title: 'What this app is' },
  { id: 'help-data', title: 'Your data stays on this device' },
  { id: 'help-quickstart', title: 'Quick start' },
  { id: 'help-glossary', title: 'Glossary' },
  { id: 'help-howto', title: 'How to…' },
  { id: 'help-install', title: 'Install on your phone' },
  { id: 'help-desktop', title: 'Desktop tips' },
  { id: 'help-faq', title: 'FAQ' },
];

function scrollToSection(id) {
  return (event) => {
    event.preventDefault();
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function helpSection(h, id, title, ...children) {
  return h('section', { id, class: 'help-section' }, h('h2', {}, title), ...children);
}

function helpList(h, items) {
  return h('ul', { class: 'help-list' }, ...items.map((item) => h('li', {}, ...item)));
}

function helpSteps(h, steps) {
  return h('ol', { class: 'help-steps' }, ...steps.map((step) => h('li', {}, step)));
}

function helpGlossary(h, entries) {
  return h(
    'dl',
    { class: 'help-glossary' },
    ...entries.flatMap(([term, definition]) => [
      h('dt', {}, term),
      h('dd', {}, definition),
    ]),
  );
}

function helpHowTos(h, entries) {
  return helpList(
    h,
    entries.map(([lead, rest]) => [h('strong', {}, lead), ...rest]),
  );
}

function helpQa(h, question, answer) {
  return [h('h3', { class: 'help-question' }, question), h('p', {}, answer)];
}

function helpAbout(h) {
  return helpSection(
    h,
    'help-about',
    'What this app is',
    h(
      'p',
      {},
      'A maintenance log for one technician: repairs, machines, parts and preventive maintenance (PM) in one place. It is built for use on a phone on the shop floor — short forms, big buttons, and it works offline.',
    ),
    h('p', {}, 'There is no account and nothing to set up. Open the app and start logging.'),
  );
}

function helpData(h) {
  return helpSection(
    h,
    'help-data',
    'Your data stays on this device',
    helpList(h, [
      ['No account, no cloud. Everything you write is saved in this browser, on this device, only.'],
      ['Sharing this link shares the empty app, not your records. Whoever opens it starts with their own empty log.'],
      [
        'To hand your records to someone: ',
        h('strong', {}, 'Settings → Export backup (JSON)'),
        ', send them the file, and they pick ',
        h('strong', {}, 'Import backup'),
        ' in Settings on their device.',
      ],
      ['Clearing your browser data erases your records, so export a backup regularly.'],
    ]),
  );
}

function helpQuickStart(h) {
  return helpSection(
    h,
    'help-quickstart',
    'Quick start',
    h('p', {}, 'Five steps and the app is doing its job:'),
    helpSteps(h, [
      'Add your machines (Machines → + Add machine), or load sample data from Settings to explore first.',
      'Log a repair — Jobs → + Log repair, pick the machine, say what happened.',
      'Update the job’s status as you work: open it and move it along — In progress, Waiting parts, Waiting tech, Done.',
      'Add the parts you keep in stock (Parts → + Add part) and set a minimum quantity for each, so the app warns you before you run out.',
      'Add PM tasks (PM → + Add PM task) with an interval in days, and the app tracks what is due and when.',
    ]),
  );
}

function helpGlossarySection(h) {
  return helpSection(
    h,
    'help-glossary',
    'Glossary',
    helpGlossary(h, [
      ['Work order / job', 'One repair or task, from the moment it is logged until it is marked Done. “Job” and “work order” mean the same thing here.'],
      ['Breakdown', 'A repair logged because a machine stopped working. The app offers to mark that machine Down while the job is open, and Running again after.'],
      ['PM (preventive maintenance)', 'A small, scheduled check that keeps a machine working — cleaning, oiling, checking tension. Example: clean and oil the single-needle machine every 30 days.'],
      ['PM interval', 'How often a PM task repeats, in days from the last time it was done. A 30-day task is due again 30 days after you mark it done.'],
      ['Overdue', 'Past its due date and not done yet.'],
      ['Due soon', 'Due within the next 3 days.'],
      ['Open', 'Logged, but nobody has started on it yet.'],
      ['In progress', 'Someone is working on it right now.'],
      ['Waiting parts', 'Paused until an ordered part arrives.'],
      ['Waiting tech', 'Paused until you (or an outside repair shop) can get to it.'],
      ['Done', 'Finished and closed.'],
      ['Downtime', 'How many minutes the machine was out of service because of this job. Entered on the job as “Machine downtime (minutes)”.'],
      ['Labour minutes', 'How many minutes you spent working on the job — your time, tracked separately from downtime.'],
      ['Low stock / minimum quantity', 'Every part has a minimum quantity. When the quantity on hand falls to it or below, the part is flagged Low so you can reorder in time.'],
      ['Building item', 'Something that is part of the building — a drain, a gutter run, a light — logged like a machine so it can have jobs and PM tasks too.'],
    ]),
  );
}

function helpHowTo(h) {
  return helpSection(
    h,
    'help-howto',
    'How to…',
    helpHowTos(h, [
      [
        'Log a repair in under a minute',
        ' — Jobs → + Log repair, pick the machine, type what happened, then Save work order. Parts, timings and status can all be added later.',
      ],
      [
        'Close a job and deduct parts',
        ' — open the job, add the parts it used, then set its status to Done. Parts are deducted from stock once, at the moment the job is marked Done. If you reopen the job, the used parts go back into stock.',
      ],
      [
        'Mark a PM done',
        ' — PM → open the task → Mark done. The app logs a PM job for the machine and sets the next due date from the interval.',
      ],
      ['Find a part', ' — go to Parts and type a name or part number into the search box.'],
      [
        'See a machine’s history',
        ' — Machines → open the machine → Repair history lists its jobs, newest first.',
      ],
      ['Export to Excel (CSV)', ' — Settings → Export work orders (CSV). The file opens in Excel, Numbers or Google Sheets.'],
      [
        'Back up and restore',
        ' — Settings → Export backup (JSON) saves everything in one file. Settings → Import backup restores it, on this device or another one.',
      ],
    ]),
  );
}

function helpInstall(h) {
  return helpSection(
    h,
    'help-install',
    'Install on your phone',
    helpList(h, [
      ['Android (Chrome): open the ⋮ menu and tap “Install app” (or “Add to Home screen”).'],
      ['iPhone (Safari): tap Share, then “Add to Home Screen”.'],
      ['After your first visit, the app loads with no signal — the whole thing is cached on the device.'],
    ]),
  );
}

function helpShortcutsTable(h) {
  const key = (label) => h('kbd', {}, label);
  const row = (keys, what) =>
    h('tr', {}, h('td', { class: 'help-keys' }, ...keys), h('td', {}, what));
  return h(
    'table',
    { class: 'help-shortcuts' },
    h(
      'thead',
      {},
      h('tr', {}, h('th', { scope: 'col' }, 'Key'), h('th', { scope: 'col' }, 'What it does')),
    ),
    h(
      'tbody',
      {},
      row([key('n')], 'Start a new work order (Log repair)'),
      row([key('/')], 'Focus the search box on the current page'),
      row([key('g'), ' then ', key('h')], 'Go to Home'),
      row([key('g'), ' then ', key('j')], 'Go to Jobs'),
      row([key('g'), ' then ', key('m')], 'Go to Machines'),
      row([key('g'), ' then ', key('p')], 'Go to Parts'),
      row([key('g'), ' then ', key('k')], 'Go to PM'),
    ),
  );
}

function helpDesktop(h) {
  return helpSection(
    h,
    'help-desktop',
    'Desktop tips',
    h(
      'p',
      {},
      'On a wide screen (1024 px or more), the app puts a sidebar on the left in place of the bottom tab bar, lists turn into tables you can sort by clicking a column header, and opening a row shows its details in a pane beside the list. On smaller screens nothing changes.',
    ),
    h('p', {}, 'Keyboard shortcuts (desktop only — they never fire while you are typing in a text field):'),
    helpShortcutsTable(h),
  );
}

function helpFaq(h) {
  return helpSection(
    h,
    'help-faq',
    'FAQ',
    ...helpQa(
      h,
      'I shared the link and my coworker sees nothing',
      'That is by design: records never leave the device that made them, so the link opens the empty app for them. To share your records, use Settings → Export backup (JSON) and send them the file; they use Settings → Import backup.',
    ),
    ...helpQa(
      h,
      'Will I lose data if I update the app?',
      'No. Updates replace the app itself, not the records stored by your browser. Export a backup before updating anyway — it is one button in Settings.',
    ),
    ...helpQa(
      h,
      'Can two people use the same log?',
      'Not in this version: each device keeps its own log. A shared log for several people is planned.',
    ),
  );
}

export function renderHelp(h) {
  return h(
    'div',
    { class: 'page help-page' },
    h('div', { class: 'page-head' }, h('h2', {}, 'Help')),
    h(
      'p',
      { class: 'muted' },
      'A short guide: what this app is, where your data lives, and how to use each part of it.',
    ),
    h(
      'nav',
      { class: 'help-toc', 'aria-label': 'Help sections' },
      h(
        'ul',
        {},
        ...HELP_SECTIONS.map((section) =>
          h(
            'li',
            {},
            h(
              'a',
              { href: `#${section.id}`, onclick: scrollToSection(section.id) },
              section.title,
            ),
          ),
        ),
      ),
    ),
    helpAbout(h),
    helpData(h),
    helpQuickStart(h),
    helpGlossarySection(h),
    helpHowTo(h),
    helpInstall(h),
    helpDesktop(h),
    helpFaq(h),
  );
}