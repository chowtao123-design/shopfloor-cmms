const HELP_SECTIONS = [
  { id: 'help-about', title: 'What this app is' },
  { id: 'help-data', title: 'Your data' },
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
      'A maintenance log for a garment shop: repairs, machines, parts and preventive maintenance (PM) in one place. It is built for use on a phone on the shop floor — short forms, big buttons, and it keeps working when the Wi-Fi drops.',
    ),
    h(
      'p',
      {},
      'On the team server, everyone signs in with a team account and shares one log: you see what your coworkers log, every record says who last edited it, and nothing is lost when two people save at the same time.',
    ),
  );
}

function helpData(h) {
  return helpSection(
    h,
    'help-data',
    'Your data',
    helpList(h, [
      [
        'One shared log on the company server. ',
        'Everything you see is the team’s log stored on your company’s server. Sign in with your team account and you see everyone’s records, and they see yours.',
      ],
      [
        'Who edited what. ',
        'Every record shows ',
        h('strong', {}, 'Edited by <Name> · <time>'),
        ' (hold to see the exact time), and detail pages also show who created it. Your own edits that have not reached the server yet say ',
        h('strong', {}, 'Not synced yet'),
        '.',
      ],
      [
        'History for every record. ',
        'Open any service order, machine, part or PM task and scroll to ',
        h('strong', {}, 'History'),
        ' to see every saved version — who changed it, when, and which fields changed. Nothing is thrown away, not even versions that were saved over.',
      ],
      [
        'Offline is fine. ',
        'The status pill in the header says what is happening: ',
        h('strong', {}, 'Synced'),
        ' (you have everything), ',
        h('strong', {}, 'Saving… (n)'),
        ' (sending n of your changes), ',
        h('strong', {}, 'Offline – n changes waiting'),
        ' (no server, your edits are queued on this device), ',
        h('strong', {}, 'Sign in needed'),
        ', or ',
        h('strong', {}, 'n changes failed to sync'),
        ' (the server rejected a change — Settings shows why and offers Retry).',
      ],
      [
        'Backups live on the server. ',
        h('strong', {}, 'Settings → Back up now'),
        ' saves a backup file on the server with one click — anyone signed in can do it. The server also backs itself up automatically every night. Admins can download backup files.',
      ],
      [
        'Admins manage teammates. ',
        'In Settings, admins add users, set roles (administrator or technician), disable accounts and reset passwords. Accounts are never self-serve.',
      ],
      [
        'Standalone copies. ',
        'If this app was opened without a team server, that copy keeps everything in this browser, on this device, and ',
        h('strong', {}, 'Settings → Export backup (JSON)'),
        ' is the way to hand records over.',
      ],
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
      'Add your machines (Machines → + Add machine) — or, if your shop is moving over from the old single-device app, an administrator imports its backup in Settings → Import v1 data.',
      'Log a repair — Service Orders → + Service order, pick the machine, say what happened.',
      'Update the service order’s status as you work: open it and move it along — In progress, Waiting parts, Waiting tech, Done.',
      'Add the parts you keep in stock (Parts → + Add part) and set a minimum quantity for each, so the app warns you before you run out.',
      'Add PM tasks (Preventive Maintenance → + Add PM task) with an interval in days, and the app tracks what is due and when.',
    ]),
  );
}

function helpGlossarySection(h) {
  return helpSection(
    h,
    'help-glossary',
    'Glossary',
    helpGlossary(h, [
      ['Work order / job', 'One repair or task, from the moment it is logged until it is marked Done. The app now calls these service orders; “job” and “work order” mean the same thing here.'],
      ['Breakdown', 'A repair logged because a machine stopped working. The app offers to mark that machine Down while the job is open, and Running again after.'],
      ['Machine type', 'What kind of machine it is — single-needle lockstitch, bartack, 5-thread overlock and other garment-shop types. If none of them fit, pick Other (type your own) and give it your own name; the types you use are remembered for next time.'],
      ['PM (preventive maintenance)', 'A small, scheduled check that keeps a machine working — cleaning, oiling, checking tension. Example: clean and oil the single-needle machine every 30 days.'],
      ['PM interval', 'How often a PM task repeats, in days from the last time it was done. A 30-day task is due again 30 days after you mark it done.'],
      ['Paused PM', 'The PM tasks of a machine that is In storage or Retired are paused: they do not count as overdue or due soon, and they sit in the “Paused” group on the Preventive Maintenance page. Set the machine back to Running and the tasks resume with their due dates unchanged.'],
      ['Overdue', 'Past its due date and not done yet.'],
      ['Due soon', 'Due within the next 3 days.'],
      ['Open', 'Logged, but nobody has started on it yet.'],
      ['In progress', 'Someone is working on it right now.'],
      ['Waiting parts', 'Paused until an ordered part arrives.'],
      ['Waiting tech', 'Paused until you (or an outside repair shop) can get to it.'],
      ['Done', 'Finished and closed.'],
      ['Downtime', 'How many minutes the machine was out of service because of this service order. Entered on the order as “Machine downtime (minutes)”.'],
      ['Labour minutes', 'How many minutes you spent working on the service order — your time, tracked separately from downtime.'],
      ['Low stock / minimum quantity', 'Every part has a minimum quantity. When the quantity on hand falls to it or below, the part is flagged Low so you can reorder in time.'],
      ['In storage', 'A machine that is put away instead of working on the floor. Service orders and PM tasks can still be logged for it, but the app leaves its status alone and pauses its PM while it is stored.'],
      ['Building item', 'Something that is part of the building — a drain, a gutter run, a light — logged like a machine so it can have service orders and PM tasks too.'],
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
        ' — Service Orders → + Service order, pick the machine, type what happened, then Save service order. Parts, timings and status can all be added later.',
      ],
      [
        'Close a service order and deduct parts',
        ' — open the order, add the parts it used, then set its status to Done. Parts are deducted from stock once, at the moment the order is marked Done. If you reopen it, the used parts go back into stock.',
      ],
      [
        'Mark a PM done',
        ' — Preventive Maintenance → open the task → Mark done. The app logs a done PM service order for the machine and sets the next due date from the interval.',
      ],
      ['Find a part', ' — go to Parts and type a name or part number into the search box.'],
      [
        'See a machine’s history',
        ' — Machines → open the machine → Repair history lists its service orders, newest first.',
      ],
      ['Export to Excel (CSV)', ' — Settings → Export service orders (CSV). The file opens in Excel, Numbers or Google Sheets.'],
      [
        'Back up',
        ' — Settings → Back up now saves a backup of the whole shared log on the server with one click; the server also does it automatically every night. Settings → Export backup (JSON) saves a local file of what this device holds.',
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
      [
        'After your first visit, the app loads with no signal — the whole thing is cached on the device. On the team server this needs the HTTPS address (offline install and offline opening do not work over plain HTTP); ask whoever runs the server for the HTTPS link.',
      ],
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
      row([key('n')], 'Start a new service order'),
      row([key('/')], 'Focus the search box on the current page'),
      row([key('g'), ' then ', key('h')], 'Go to Home'),
      row([key('g'), ' then ', key('j')], 'Go to Service Orders'),
      row([key('g'), ' then ', key('m')], 'Go to Machines'),
      row([key('g'), ' then ', key('p')], 'Go to Parts'),
      row([key('g'), ' then ', key('k')], 'Go to Preventive Maintenance'),
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
      'On a wide screen (1024 px or more), the app shows a dark sidebar on the left in place of the bottom tab bar, lists turn into tables you can sort by clicking a column header, and opening a row shows its details in a pane beside the list. The top bar has a global search box that finds service orders, machines and parts; pick a result with the arrow keys and press Enter. The sidebar can be collapsed to an icon rail with the button at its top. On phones the bottom bar has Home, Orders, Prev. Maint., Machines and More.',
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
      'Can two people use the same log?',
      'Yes — that is the normal way. Everyone signs in to the team server with their own account and shares one log. Each person works on their own device, and every record says who last edited it.',
    ),
    ...helpQa(
      h,
      'What happens when two people edit the same service order?',
      'The later save wins, and nothing is lost: the app tells the second saver that they saved over changes by the first, and both versions stay in the order’s History section. If you both close service orders that use the same part, both stock deductions apply.',
    ),
    ...helpQa(
      h,
      'What does the pill in the header mean?',
      'It is the sync status. “Synced” means you have everything and the server has all of your changes. “Saving… (n)” means n of your changes are being sent. “Offline – n changes waiting” means the server cannot be reached and your edits are safely queued on this device. “Sign in needed” means you have to sign in again. “n changes failed to sync” means the server rejected a change — Settings shows why and offers Retry.',
    ),
    ...helpQa(
      h,
      'I made edits on the shop floor with no Wi-Fi. Where are they?',
      'Still here, marked “Not synced yet”, and counted in the pill as waiting changes. They send automatically as soon as the server is reachable again — nothing to press.',
    ),
    ...helpQa(
      h,
      'How do backups work?',
      'Anyone signed in can tap Settings → Back up now: that saves a backup file on the server immediately. On top of that the server backs itself up automatically every night, and admins can download the backup files.',
    ),
    ...helpQa(
      h,
      'Will I lose data if the app is updated?',
      'No. Updates replace the app itself, not the records. Records live on the team server (and each device keeps a working copy); an update just refreshes the app shell.',
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